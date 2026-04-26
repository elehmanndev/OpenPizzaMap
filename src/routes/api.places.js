const express = require("express");
const { prisma } = require("../db");
const { boundingBox, haversineKm } = require("../services/geo");

const router = express.Router();

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

router.get("/", async (req, res) => {
    const { query, city, lat, lng, radius, style } = req.query;
    const styleSlug = (style || "").trim();

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

        return res.json({ ok: true, places: places.map(flattenStyles) });
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

        return res.json({ ok: true, places: withDist });
    }

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true, ...styleFilter },
        include: STYLE_INCLUDE,
        orderBy: { updatedAt: "desc" },
        take: 1000,
    });
    res.json({ ok: true, places: places.map(flattenStyles) });
});

router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id }, include: STYLE_INCLUDE });
    if (!place || place.isVisible === false) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, place: flattenStyles(place) });
});

module.exports = router;
