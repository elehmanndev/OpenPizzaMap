#!/usr/bin/env node
// One-shot probe for the new v2 photo pipeline. Scrapes one place via
// Playwright, runs the download → sharp → upload chain end-to-end,
// and reports what landed on Hostinger.
//
// Usage:
//   docker exec -it opm-runner node scripts/probes/probe-upload-place-photo.js --placeId 145
//
// Expected output for a healthy run on a place with 5 photos:
//   [probe] scraping #145 ...
//   [probe]   scraped 5 photo URLs from gmaps
//   [probe] processing + uploading...
//   [probe]   #1 photo a1b2c3 → 201 placeImageId=12345
//   [probe]   #2 photo def456 → 201 placeImageId=12346
//   ...
//   [probe] DONE — 5 uploaded, 0 failed in 28s

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage, scrapePhotos } = require("../lib/gmaps");
const { processPlace, stampGalleryScraped, maxPosition } = require("../enrichment/process-and-upload-photos");

(async () => {
    const args = process.argv.slice(2);
    const placeIdArg = args.indexOf("--placeId");
    if (placeIdArg === -1) {
        console.error("Usage: node probe-upload-place-photo.js --placeId <id>");
        process.exit(1);
    }
    const placeId = Number(args[placeIdArg + 1]);
    if (!Number.isInteger(placeId)) {
        console.error("placeId must be an integer");
        process.exit(1);
    }

    const place = await prisma.place.findUnique({
        where: { id: placeId },
        select: { id: true, name: true, slug: true, city: true, googlePlaceId: true },
    });
    if (!place) { console.error("place not found"); process.exit(1); }
    if (!place.googlePlaceId) { console.error("place has no googlePlaceId"); process.exit(1); }

    const t0 = Date.now();
    console.log(`[probe] scraping #${place.id} "${place.name}" ...`);

    const { browser, page } = await createGmapsPage();
    try {
        const scrape = await scrapePhotos(page, {
            googlePlaceId: place.googlePlaceId,
            name: place.name,
            city: place.city,
            maxPhotos: 5,
        });
        if (scrape.captcha) { console.error("CAPTCHA — aborting"); process.exit(1); }
        if (scrape.error) { console.error("scrape error:", scrape.error); process.exit(1); }

        const photos = scrape.photos || [];
        console.log(`[probe]   scraped ${photos.length} photo URLs from gmaps`);
        if (!photos.length) { console.log("[probe] no photos to upload"); process.exit(0); }

        console.log("[probe] processing + uploading...");
        const startPosition = (await maxPosition(prisma, place.id)) + 1;
        const result = await processPlace({
            placeId: place.id,
            slug: place.slug,
            source: "google",
            photos,
            startPosition,
        });

        for (const r of result.results) {
            const status = r.ok
                ? `${r.idempotent ? "409" : "201"} placeImageId=${r.placeImageId}`
                : `FAIL ${r.reason}`;
            console.log(`[probe]   sourceRef=${(r.sourceRef || "").slice(0, 20)}... → ${status}`);
        }

        if (result.uploaded > 0) {
            await stampGalleryScraped(place.id);
        }

        const elapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[probe] DONE — ${result.uploaded} uploaded, ${result.failed} failed in ${elapsed}s`);
    } finally {
        await browser.close().catch(() => {});
        await prisma.$disconnect();
    }
})().catch((e) => { console.error(e); process.exit(1); });
