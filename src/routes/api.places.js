const express = require("express");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../db");
const { boundingBox, haversineKm } = require("../services/geo");

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
    res.set("Vary", "Cookie");
    if (hasSession || hasCookie) {
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
            tripadvisorRating: true,
            yelpRating: true,
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

module.exports = router;
