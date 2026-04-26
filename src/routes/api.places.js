const express = require("express");
const { prisma } = require("../db");
const { boundingBox, haversineKm } = require("../services/geo");

const router = express.Router();

router.get("/", async (req, res) => {
    const { query, city, lat, lng, radius } = req.query;

    // Text search (name/city)
    if (query || city) {
        const q = (query || "").trim();
        const c = (city || "").trim();

        const places = await prisma.place.findMany({
            where: {
                AND: [
                    q ? { name: { contains: q } } : {},
                    c ? { city: { contains: c } } : {},
                ],
                status: "active",
                isVisible: true,
            },
            orderBy: { updatedAt: "desc" },
            take: 200,
        });

        return res.json({ ok: true, places });
    }

    // Near-me search
    if (lat && lng) {
        const latN = Number(lat);
        const lngN = Number(lng);
        const radiusKm = Number(radius || 5);

        const box = boundingBox(latN, lngN, radiusKm);

        // prefilter by bounding box
        const pre = await prisma.place.findMany({
            where: {
                status: "active",
                isVisible: true,
                lat: { gte: box.minLat, lte: box.maxLat },
                lng: { gte: box.minLng, lte: box.maxLng },
            },
            take: 500,
        });

        const withDist = pre
            .map((p) => ({
                ...p,
                distance_km: haversineKm(latN, lngN, Number(p.lat), Number(p.lng)),
            }))
            .filter((p) => p.distance_km <= radiusKm)
            .sort((a, b) => a.distance_km - b.distance_km)
            .slice(0, 200);

        return res.json({ ok: true, places: withDist });
    }

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true },
        orderBy: { updatedAt: "desc" },
        take: 200,
    });
    res.json({ ok: true, places });
});

router.get("/:id", async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id } });
    if (!place || place.isVisible === false) return res.status(404).json({ ok: false, error: "Not found" });
    res.json({ ok: true, place });
});

module.exports = router;
