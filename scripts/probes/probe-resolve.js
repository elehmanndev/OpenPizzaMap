#!/usr/bin/env node
// Validate the Playwright place resolver on one place. Doesn't write
// to DB — just reports what would have happened.
//
// Usage:
//   docker exec -it opm-runner node scripts/probes/probe-resolve.js --name "Pizzeria Errico Porzio" --city Naples --country Italy
//   docker exec -it opm-runner node scripts/probes/probe-resolve.js --placeId 145

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage, findPlaceByName } = require("../lib/gmaps");

(async () => {
    const args = process.argv.slice(2);
    const arg = (k) => {
        const i = args.indexOf(k);
        return i === -1 ? null : args[i + 1];
    };
    let name = arg("--name");
    let city = arg("--city");
    let country = arg("--country");
    let lat = null, lng = null;

    const placeIdRaw = arg("--placeId");
    if (placeIdRaw) {
        const place = await prisma.place.findUnique({
            where: { id: Number(placeIdRaw) },
            select: { name: true, city: true, country: true, lat: true, lng: true, googlePlaceId: true },
        });
        if (!place) { console.error("place not found"); process.exit(1); }
        name = name || place.name;
        city = city || place.city;
        country = country || place.country;
        lat = place.lat ? Number(place.lat) : null;
        lng = place.lng ? Number(place.lng) : null;
        if (place.googlePlaceId) {
            console.log(`[probe] note: place already has googlePlaceId=${place.googlePlaceId}`);
        }
    }

    if (!name) {
        console.error("Need either --name or --placeId");
        process.exit(1);
    }

    console.log(`[probe] resolving "${name}" / "${city || ''}" / "${country || ''}"`);
    const { browser, page } = await createGmapsPage();
    try {
        const t0 = Date.now();
        const r = await findPlaceByName(page, { name, city, country, lat, lng });
        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[probe] result (${elapsed}s):`, JSON.stringify(r, null, 2));
    } finally {
        await browser.close().catch(() => {});
        await prisma.$disconnect();
    }
})().catch((e) => { console.error(e); process.exit(1); });
