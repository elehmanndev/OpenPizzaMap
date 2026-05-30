const express = require("express");
const { z } = require("zod");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { boundingBox, haversineKm } = require("../services/geo");
const { recalcPlaceOpmRating } = require("../services/opm-rating");

const router = express.Router();

function requireApiAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, error: "Sign in required" });
    }
    next();
}

const STYLE_INCLUDE = {
    styles: {
        select: {
            style: { select: { slug: true, name: true, shortLabel: true } },
        },
    },
};

function flattenStyles(p) {
    if (!p.styles) return p;
    return { ...p, styles: p.styles.map((s) => s.style) };
}

// Hydrate places with public visit counts + per-viewer flags.
//
// Old shape: 1 sequential groupBy + (if auth) Promise.all([visits, favorites]) =
// up to 3 round-trips per request, all serial-then-parallel.
// New shape: groupBy in parallel with the user-specific lookup, and the
// user-specific lookup itself is one combined raw UNION query instead of two
// findMany. Net: 1 round-trip for anon, 2 parallel round-trips for auth.
async function attachUserAndCounts(places, userId) {
    if (!places.length) return places;
    const ids = places.map((p) => p.id);

    const visitCountPromise = prisma.visit.groupBy({
        by: ["placeId"],
        where: { placeId: { in: ids } },
        _count: { _all: true },
    });

    const userFlagsPromise = userId
        ? prisma.$queryRaw`
            SELECT 'visit' AS kind, placeId FROM Visit
              WHERE userId = ${userId} AND placeId IN (${Prisma.join(ids)})
            UNION ALL
            SELECT 'favorite' AS kind, placeId FROM Favorite
              WHERE userId = ${userId} AND placeId IN (${Prisma.join(ids)})
        `
        : Promise.resolve([]);

    const [visitGroups, userFlags] = await Promise.all([visitCountPromise, userFlagsPromise]);

    const visitCount = new Map(visitGroups.map((g) => [g.placeId, g._count._all]));
    const visited = new Set();
    const favorited = new Set();
    for (const row of userFlags) {
        if (row.kind === "visit") visited.add(row.placeId);
        else if (row.kind === "favorite") favorited.add(row.placeId);
    }

    return places.map((p) => ({
        ...p,
        visitCount: visitCount.get(p.id) || 0,
        viewerVisited: visited.has(p.id),
        viewerFavorited: favorited.has(p.id),
    }));
}

// Resolve `?limit=` clamped to [1, 500]. Anon callers default to 200, auth to
// 500. Old code unconditionally fetched 1000 rows even when the map only
// renders a couple hundred — wasteful and a worker-killer under load.
function resolveLimit(req, isAuth) {
    const cap = isAuth ? 500 : 200;
    const raw = Number(req.query.limit);
    if (!Number.isFinite(raw) || raw <= 0) return cap;
    return Math.min(cap, Math.max(1, Math.floor(raw)));
}

// Cache-Control: edge-cacheable for anon, no-store for authed.
//
// With express-session `saveUninitialized:false`, anon users send no Cookie
// header at all — so all anon callers share one cache key at Cloudflare and
// the second hit onwards is served from edge. Authed users carry opm.sid and
// must always get fresh per-user flags.
function applyCacheHeaders(req, res) {
    const hasSession = !!(req.session && req.session.user);
    const hasCookie = !!(req.headers.cookie && req.headers.cookie.includes("opm.sid"));
    if (hasSession || hasCookie) {
        // Vary: Cookie tells downstream caches the response depends on the
        // session cookie. Only needed on the authed path; on the public path
        // the Cloudflare Cache Rule already splits the cache by cookie
        // presence, and Vary: Cookie there triggers CF to append `no-store`.
        res.set("Vary", "Cookie");
        res.set("Cache-Control", "private, no-store");
    } else {
        // 60 s edge cache, plus 5 min serve-stale-while-revalidating. Even one
        // viral spike will only land a single request on Node per minute.
        res.set("Cache-Control", "public, max-age=30, s-maxage=60, stale-while-revalidate=300");
    }
}

router.get("/", async (req, res) => {
    const { query, city, lat, lng, radius, style } = req.query;
    const styleSlug = (style || "").trim();
    const userId = req.session?.user?.id || null;
    const isAuth = !!userId;
    const limit = resolveLimit(req, isAuth);

    applyCacheHeaders(req, res);

    const styleFilter = styleSlug
        ? { styles: { some: { style: { slug: styleSlug } } } }
        : {};

    // Text search (name/city)
    if (query || city) {
        const q = (query || "").trim();
        const c = (city || "").trim();

        const places = await prisma.place.findMany({
            where: {
                AND: [
                    q ? { name: { contains: q } } : {},
                    c ? { city: { contains: c } } : {},
                    styleFilter,
                ],
                status: "active",
                isVisible: true,
            },
            include: STYLE_INCLUDE,
            orderBy: { updatedAt: "desc" },
            take: limit,
        });

        const flat = places.map(flattenStyles);
        const enriched = await attachUserAndCounts(flat, userId);
        return res.json({ ok: true, places: enriched });
    }

    // Near-me search
    if (lat && lng) {
        const latN = Number(lat);
        const lngN = Number(lng);
        const radiusKm = Number(radius || 5);

        const box = boundingBox(latN, lngN, radiusKm);

        const pre = await prisma.place.findMany({
            where: {
                status: "active",
                isVisible: true,
                lat: { gte: box.minLat, lte: box.maxLat },
                lng: { gte: box.minLng, lte: box.maxLng },
                ...styleFilter,
            },
            include: STYLE_INCLUDE,
            take: limit,
        });

        const withDist = pre
            .map((p) => ({
                ...flattenStyles(p),
                distance_km: haversineKm(latN, lngN, Number(p.lat), Number(p.lng)),
            }))
            .filter((p) => p.distance_km <= radiusKm)
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, limit);

        const enriched = await attachUserAndCounts(withDist, userId);
        return res.json({ ok: true, places: enriched });
    }

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true, ...styleFilter },
        include: STYLE_INCLUDE,
        orderBy: { updatedAt: "desc" },
        take: limit,
    });
    const flat = places.map(flattenStyles);
    const enriched = await attachUserAndCounts(flat, userId);
    res.json({ ok: true, places: enriched });
});

// GET /api/places/markers — slim payload for rendering every visible place on
// the map. Returns only the fields the marker + sidebar card need; popup-heavy
// fields (descriptionHtml, addressLine, postalCode, phone, websiteUrl, etc.)
// are lazy-loaded by the client via /api/places/:id when a popup opens.
//
// Why a separate endpoint: GET /api/places caps results at 200/500 to protect
// the worker pool, but the map needs every marker (~1500 today) so cluster
// counts and famous spots like Sorbillo / 50 Kalò aren't silently dropped.
// Per-row payload here is ~10x smaller, so the full set comfortably fits in
// one cacheable response.
router.get("/markers", async (req, res) => {
    const userId = req.session?.user?.id || null;
    applyCacheHeaders(req, res);

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true },
        select: {
            id: true,
            name: true,
            lat: true,
            lng: true,
            city: true,
            country: true,
            priceLevel: true,
            heroImageUrl: true,
            opmRating: true,
            googleRating: true,
            googleReviewCount: true,
            tripadvisorRating: true,
            tripadvisorReviewCount: true,
            yelpRating: true,
            yelpReviewCount: true,
            styles: {
                select: {
                    style: { select: { slug: true, name: true, shortLabel: true } },
                },
            },
        },
    });

    const flat = places.map(flattenStyles);
    const enriched = await attachUserAndCounts(flat, userId);
    res.json({ ok: true, places: enriched });
});

// GET /api/places/search?q=...&limit=8 — lightweight autocomplete used by
// the homepage hero search. Two buckets: matching cities (with place
// counts so we can rank dense cities first) and matching spots. Returns
// only the fields the suggest dropdown needs — small enough to cache at
// the edge and hammer on every keystroke.
//
// Why a dedicated endpoint instead of reusing /markers: /markers is ~1MB
// and is the wrong shape for prefix search. This one is server-side
// filtered, capped per side, and case-insensitive.
router.get("/search", async (req, res) => {
    applyCacheHeaders(req, res);

    const raw = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 8));

    if (raw.length < 2) {
        return res.json({ ok: true, cities: [], spots: [] });
    }

    // Pull a slightly wider net than `limit` so we can re-rank prefix
    // matches above mid-string matches before slicing.
    const slack = limit * 3;

    const [cities, spots] = await Promise.all([
        prisma.city.findMany({
            where: {
                isVisible: true,
                name: { contains: raw },
            },
            select: {
                name: true,
                slug: true,
                countryCode: true,
                _count: { select: { places: { where: { isVisible: true } } } },
            },
            take: slack,
        }),
        prisma.place.findMany({
            where: {
                status: "active",
                isVisible: true,
                name: { contains: raw },
            },
            select: {
                id: true,
                name: true,
                slug: true,
                city: true,
                country: true,
                heroImageUrl: true,
            },
            take: slack,
        }),
    ]);

    // Rank: prefix-match first, then alpha. Keep only rows with at least
    // one visible place for the cities side so we don't surface empties.
    const lc = raw.toLowerCase();
    const startsWith = (s) => (s || "").toLowerCase().startsWith(lc);
    const cityRows = cities
        .filter((c) => c._count.places > 0)
        .map((c) => ({
            city: c.name,
            slug: c.slug,
            country: c.countryCode,
            count: c._count.places,
            _prefix: startsWith(c.name) ? 0 : 1,
        }))
        .sort((a, b) => a._prefix - b._prefix || b.count - a.count)
        .slice(0, limit)
        .map(({ _prefix, ...row }) => row);

    const spotRows = spots
        .map((p) => ({
            id: p.id,
            name: p.name,
            slug: p.slug,
            city: p.city,
            country: p.country,
            heroImageUrl: p.heroImageUrl,
            _prefix: startsWith(p.name) ? 0 : 1,
        }))
        .sort((a, b) => a._prefix - b._prefix || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map(({ _prefix, ...row }) => row);

    res.json({ ok: true, cities: cityRows, spots: spotRows });
});

// GET /api/places/favorites — places the current user has hearted (for /favourites page)
router.get("/favorites", requireApiAuth, async (req, res) => {
    const userId = req.session.user.id;
    const favs = await prisma.favorite.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: { place: { include: STYLE_INCLUDE } },
    });
    const places = favs
        .filter((f) => f.place && f.place.isVisible !== false)
        .map((f) => flattenStyles(f.place));
    const enriched = await attachUserAndCounts(places, userId);
    res.json({ ok: true, places: enriched });
});

router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    const userId = req.session?.user?.id || null;
    const place = await prisma.place.findUnique({ where: { id }, include: STYLE_INCLUDE });
    if (!place || place.isVisible === false) return res.status(404).json({ ok: false, error: "Not found" });
    const flat = flattenStyles(place);
    const [enriched] = await attachUserAndCounts([flat], userId);
    res.json({ ok: true, place: enriched });
});

// POST /api/places/:id/visit — toggle "I've been here". Returns new state.
router.post("/:id/visit", requireApiAuth, async (req, res) => {
    const placeId = Number(req.params.id);
    const userId = req.session.user.id;
    if (!Number.isFinite(placeId)) return res.status(400).json({ ok: false, error: "Bad id" });

    const place = await prisma.place.findUnique({ where: { id: placeId }, select: { id: true, isVisible: true } });
    if (!place || place.isVisible === false) return res.status(404).json({ ok: false, error: "Not found" });

    const existing = await prisma.visit.findUnique({ where: { userId_placeId: { userId, placeId } } });
    if (existing) {
        await prisma.visit.delete({ where: { id: existing.id } });
    } else {
        await prisma.visit.create({ data: { userId, placeId } });
    }
    const visitCount = await prisma.visit.count({ where: { placeId } });
    res.json({ ok: true, visited: !existing, visitCount });
});

// POST /api/places/:id/favorite — toggle heart. Returns new state.
router.post("/:id/favorite", requireApiAuth, async (req, res) => {
    const placeId = Number(req.params.id);
    const userId = req.session.user.id;
    if (!Number.isFinite(placeId)) return res.status(400).json({ ok: false, error: "Bad id" });

    const place = await prisma.place.findUnique({ where: { id: placeId }, select: { id: true, isVisible: true } });
    if (!place || place.isVisible === false) return res.status(404).json({ ok: false, error: "Not found" });

    const existing = await prisma.favorite.findUnique({ where: { userId_placeId: { userId, placeId } } });
    if (existing) {
        await prisma.favorite.delete({ where: { id: existing.id } });
    } else {
        await prisma.favorite.create({ data: { userId, placeId } });
    }
    res.json({ ok: true, favorited: !existing });
});

// ---------- Reviews ----------

// 0–5 in 0.5 steps. Reject anything that won't multiply cleanly to an
// integer at *2 — the front-end can't submit invalid steps even if the
// network layer lets them through.
const ratingSchema = z.number().min(0).max(5).refine(
    (n) => Number.isInteger(Math.round(n * 2)),
    { message: "Rating must be in 0.5 steps" }
);
const reviewBodySchema = z.object({
    pizza: ratingSchema,
    local: ratingSchema,
    servicio: ratingSchema,
    precio: ratingSchema,
    // Comment is REQUIRED (2026-05-19) — stars alone are noise without
    // context. Min 4 chars rejects "ok", "lol", etc. Client also gates
    // submit on this, so the server min is just the safety net.
    comment: z.string().trim().min(4).max(500),
    // priceLevel is a Place attribute, not a Review attribute. Surfacing
    // it in the review modal (added 2026-05-18) lets users keep the
    // place's € rating fresh as it changes over time — last submitter
    // wins. Optional so older clients keep working.
    priceLevel: z.coerce.number().int().min(1).max(3).optional(),
    // Month-precision visit date — "2026-05" from <input type="month">,
    // stored as the first day of that month on Review.visitedAt AND
    // Visit.visitedAt. Optional so older clients still work.
    visitedAt: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

function publicReviewShape(row) {
    // Never expose email. displayName/username/avatarUrl are
    // user-controlled and safe to show. avatarUrl can be either a
    // Google content URL (lh3.googleusercontent.com/…) or a local
    // /uploads/avatars/{userId}.jpg path; the client renders either
    // identically with referrerpolicy=no-referrer on the <img>.
    return {
        id: row.id,
        pizza: row.pizza,
        local: row.local,
        servicio: row.servicio,
        precio: row.precio,
        comment: row.comment,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        userName: row.user
            ? (row.user.username || row.user.displayName || "user")
            : "user",
        userAvatar: row.user ? row.user.avatarUrl || null : null,
        userId: row.userId,
    };
}

// POST /api/places/:id/review — create or update the current user's
// review for this place. Visit row is upserted alongside in the same
// transaction so "I've been here" is implied by leaving a review (the
// only way to mark a visit per the product spec).
router.post("/:id/review", requireApiAuth, async (req, res) => {
    const placeId = Number(req.params.id);
    const userId = req.session.user.id;
    if (!Number.isFinite(placeId)) return res.status(400).json({ ok: false, error: "Bad id" });

    const parsed = reviewBodySchema.safeParse(req.body || {});
    if (!parsed.success) {
        return res.status(422).json({ ok: false, error: "Invalid review", details: parsed.error.flatten() });
    }

    const place = await prisma.place.findUnique({
        where: { id: placeId },
        select: { id: true, isVisible: true, status: true },
    });
    if (!place || place.status !== "active") {
        return res.status(404).json({ ok: false, error: "Not found" });
    }
    // Same creator-bypass as GET /place/:id: a user who just added a
    // spot via the chatbot can review it before enrichment flips
    // isVisible to true.
    const justCreated = Array.isArray(req.session?.justCreatedPlaceIds) && req.session.justCreatedPlaceIds.includes(placeId);
    if (place.isVisible === false && !justCreated) {
        return res.status(404).json({ ok: false, error: "Not found" });
    }

    // visitedAt — "YYYY-MM" → first-of-month Date. Stamped on both Review
    // and Visit so the profile page can sort either by the actual visit
    // date rather than the createdAt write time.
    const visitedAt = parsed.data.visitedAt
        ? new Date(parsed.data.visitedAt + "-01T12:00:00.000Z")
        : null;

    const data = {
        pizza: parsed.data.pizza,
        local: parsed.data.local,
        servicio: parsed.data.servicio,
        precio: parsed.data.precio,
        comment: parsed.data.comment.trim(),
        ...(visitedAt ? { visitedAt } : {}),
    };

    const review = await prisma.$transaction(async (tx) => {
        const r = await tx.review.upsert({
            where: { placeId_userId: { placeId, userId } },
            create: { placeId, userId, ...data },
            update: data,
        });
        // Visit is implied by review — create if missing, never duplicate.
        await tx.visit.upsert({
            where: { userId_placeId: { userId, placeId } },
            create: { userId, placeId, ...(visitedAt ? { visitedAt } : {}) },
            update: visitedAt ? { visitedAt } : {},
        });
        // Optional place-level priceLevel update (Eric, 2026-05-18) —
        // we don't bother with stale-write conflicts; last submitter
        // wins on this single field.
        if (parsed.data.priceLevel != null) {
            await tx.place.update({
                where: { id: placeId },
                data: { priceLevel: parsed.data.priceLevel },
            });
        }
        return r;
    });

    const opmRating = await recalcPlaceOpmRating(prisma, placeId);

    res.json({
        ok: true,
        review: publicReviewShape({
            ...review,
            user: {
                username: req.session.user.username,
                displayName: req.session.user.displayName,
                avatarUrl: req.session.user.avatarUrl || null,
            },
        }),
        opmRating,
    });
});

// GET /api/places/:id/reviews — paginated list of visible reviews,
// newest first. Public — no auth needed to read.
router.get("/:id/reviews", async (req, res) => {
    const placeId = Number(req.params.id);
    if (!Number.isFinite(placeId)) return res.status(400).json({ ok: false, error: "Bad id" });

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const offset = Math.max(0, Number(req.query.offset) || 0);

    const [reviews, total] = await Promise.all([
        prisma.review.findMany({
            where: { placeId, isVisible: true },
            orderBy: { createdAt: "desc" },
            skip: offset,
            take: limit,
            include: {
                user: { select: { username: true, displayName: true, avatarUrl: true } },
            },
        }),
        prisma.review.count({ where: { placeId, isVisible: true } }),
    ]);

    res.set("Cache-Control", "private, no-cache");
    res.json({
        ok: true,
        reviews: reviews.map(publicReviewShape),
        total,
        limit,
        offset,
    });
});

module.exports = router;
