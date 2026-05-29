#!/usr/bin/env node
// Validate the full TA scrape → update → photo upload chain for ONE
// specific place. Bypasses the runner's queue picker — directly calls
// the scrape lib + update endpoint + photo pipeline against the
// requested placeId. Useful when probing places at the back of the
// natural queue.
//
// Usage:
//   docker exec -it opm-runner node scripts/probes/probe-scrape-tripadvisor.js --placeId 163

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage } = require("../lib/gmaps");
const { findTaLocationId, scrapeTripadvisor } = require("../lib/tripadvisor");
const { processPlace, maxPosition } = require("../enrichment/process-and-upload-photos");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

async function postTaUpdate(payload) {
    const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
        method: "POST",
        headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    const body = await r.text().catch(() => "");
    return { ok: r.ok, status: r.status, body };
}

(async () => {
    const args = process.argv.slice(2);
    const placeIdArg = args.indexOf("--placeId");
    if (placeIdArg === -1) {
        console.error("Usage: node probe-scrape-tripadvisor.js --placeId <id>");
        process.exit(1);
    }
    const placeId = Number(args[placeIdArg + 1]);
    if (!Number.isInteger(placeId)) {
        console.error("placeId must be an integer");
        process.exit(1);
    }

    const place = await prisma.place.findUnique({
        where: { id: placeId },
        select: { id: true, name: true, slug: true, city: true, tripadvisorLocationId: true },
    });
    if (!place) { console.error("place not found"); process.exit(1); }

    console.log(`[probe] place #${place.id} "${place.name}" / city="${place.city}" / locationId=${place.tripadvisorLocationId ?? "null"}`);

    const { browser, page } = await createGmapsPage();
    try {
        // Step 1 — locate if needed
        let locationId = place.tripadvisorLocationId;
        if (locationId == null || locationId === -1) {
            console.log("[probe] no locationId → searching TA...");
            const found = await findTaLocationId(page, { name: place.name, city: place.city });
            if (!found) {
                console.log("[probe] no TA match found");
                await postTaUpdate({ placeId: place.id, tripadvisorLocationId: -1 });
                console.log("[probe] wrote -1 sentinel");
                process.exit(0);
            }
            locationId = found;
            console.log(`[probe] matched locationId=${found}`);
        }

        // Step 2 — scrape
        console.log(`[probe] scraping locationId=${locationId} ...`);
        const t0 = Date.now();
        const scrape = await scrapeTripadvisor(page, {
            locationId, name: place.name, city: place.city,
        });
        const elapsedScrape = Math.round((Date.now() - t0) / 1000);

        if (scrape.error) {
            console.log(`[probe] scrape error: ${scrape.error}  (${elapsedScrape}s)`);
            process.exit(1);
        }

        console.log(`[probe] scrape OK (${elapsedScrape}s):`);
        console.log(`  rating=${scrape.rating} count=${scrape.reviewCount}`);
        console.log(`  distribution=${scrape.distribution ? JSON.stringify(scrape.distribution) : "n/a"}`);
        console.log(`  ranking=${scrape.ranking || "n/a"}`);
        console.log(`  reviews=${(scrape.reviews || []).length}`);
        console.log(`  photoUrls=${(scrape.photoUrls || []).length}`);
        console.log(`  url=${scrape.url}`);

        // Step 3 — update-place-ta
        const upd = await postTaUpdate({
            placeId: place.id,
            tripadvisorLocationId: locationId,
            tripadvisorUrl: scrape.url,
            tripadvisorRating: scrape.rating,
            tripadvisorReviewCount: scrape.reviewCount,
            tripadvisorRanking: scrape.ranking,
            reviews: scrape.reviews,
            distribution: scrape.distribution,
        });
        console.log(`[probe] update-place-ta → ${upd.status} ${upd.body.slice(0, 200)}`);

        // Step 4 — photos
        const photos = (scrape.photoUrls || []).slice(0, 5).map((url, i) => ({
            sourceUrl: url,
            sourceRef: `ta:${locationId}:${i}`,
        }));
        if (photos.length) {
            console.log(`[probe] uploading ${photos.length} TA photos ...`);
            const startPosition = (await maxPosition(prisma, place.id)) + 1;
            const result = await processPlace({
                placeId: place.id,
                slug: place.slug,
                source: "tripadvisor",
                photos,
                startPosition,
            });
            console.log(`[probe] photo upload → ${result.uploaded} uploaded, ${result.failed} failed`);
            for (const r of result.results) {
                console.log(`  ${r.sourceRef}: ${r.ok ? `OK (placeImageId=${r.placeImageId}${r.idempotent ? ', idempotent' : ''})` : `FAIL ${r.reason}`}`);
            }
        }

        const totalElapsed = Math.round((Date.now() - t0) / 1000);
        console.log(`[probe] DONE in ${totalElapsed}s`);
    } finally {
        await browser.close().catch(() => {});
        await prisma.$disconnect();
    }
})().catch((e) => { console.error(e); process.exit(1); });
