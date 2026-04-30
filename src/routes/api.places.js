const express = require("express");
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

async function attachUserAndCounts(places, userId) {
    if (!places.length) return places;
    const ids = places.map((p) => p.id);

    // Visit counts (everybody)
    const visitGroups = await prisma.visit.groupBy({
        by: ["placeId"],
        where: { placeId: { in: ids } },
        _count: { _all: true },
    });
    const visitCount = new Map(visitGroups.map((g) => [g.placeId, g._count._all]));

    // Per-user flags
    let visited = new Set();
    let favorited = new Set();
    if (userId) {
        const [vs, fs] = await Promise.all([
            prisma.visit.findMany({ where: { userId, placeId: { in: ids } }, select: { placeId: true } }),
            prisma.favorite.findMany({ where: { userId, placeId: { in: ids } }, select: { placeId: true } }),
        ]);
        visited = new Set(vs.map((v) => v.placeId));
        favorited = new Set(fs.map((f) => f.placeId));
    }

    return places.map((p) => ({
        ...p,
        visitCount: visitCount.get(p.id) || 0,
        viewerVisited: visited.has(p.id),
        viewerFavorited: favorited.has(p.id),
    }));
}

router.get("/", async (req, res) => {
    const { query, city, lat, lng, radius, style } = req.query;
    const styleSlug = (style || "").trim();
    const userId = req.session?.user?.id || null;

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
            take: 1000,
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
            take: 1000,
        });

        const withDist = pre
            .map((p) => ({
                ...flattenStyles(p),
                distance_km: haversineKm(latN, lngN, Number(p.lat), Number(p.lng)),
            }))
            .filter((p) => p.distance_km <= radiusKm)
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, 500);

        const enriched = await attachUserAndCounts(withDist, userId);
        return res.json({ ok: true, places: enriched });
    }

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true, ...styleFilter },
        include: STYLE_INCLUDE,
        orderBy: { updatedAt: "desc" },
        take: 1000,
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
