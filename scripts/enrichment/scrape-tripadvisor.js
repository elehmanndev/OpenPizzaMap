#!/usr/bin/env node
// TripAdvisor scrape phase for opm-runner.
//
// Per place per refresh cycle (90 days):
//   1. If tripadvisorLocationId is null → findTaLocationId() to locate
//      via Playwright search. Save the id, or -1 sentinel on miss.
//   2. Navigate to the canonical TA page, scrape rating/count/reviews/
//      distribution/photoUrls.
//   3. POST structured data to Hostinger /api/admin/update-place-ta.
//   4. Process + upload photo URLs (5 max, source="tripadvisor",
//      positions starting after MAX(existing position) per place).
//
// Throttle: 5s between places. Hostinger never sees the scrape — only
// the final update + per-photo uploads. The whole tick spaces traffic
// over ~5min for a 5-place batch.

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage } = require("../lib/gmaps");
const { findTaLocationId, scrapeTripadvisor } = require("../lib/tripadvisor");
const { processPlace, maxPosition } = require("./process-and-upload-photos");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const REFRESH_TTL_DAYS = 90;
const SEARCH_RETRY_DAYS = 180;       // re-try sentinel locationIds after this long
const PLACE_SPACING_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickQueue(limit) {
    const ttl = new Date(Date.now() - REFRESH_TTL_DAYS * 86400_000);
    const retryAfter = new Date(Date.now() - SEARCH_RETRY_DAYS * 86400_000);
    return prisma.place.findMany({
        where: {
            isVisible: true,
            OR: [
                // Has a positive locationId AND distribution is stale (or never scraped)
                {
                    tripadvisorLocationId: { gt: 0 },
                    OR: [
                        { tripadvisorRatingsScrapedAt: null },
                        { tripadvisorRatingsScrapedAt: { lt: ttl } },
                    ],
                },
                // Never tried (null locationId) — search needed
                { tripadvisorLocationId: null },
                // Was a true-miss (-1 sentinel) but enough time passed
                {
                    tripadvisorLocationId: -1,
                    OR: [
                        { tripadvisorRatingsScrapedAt: null },
                        { tripadvisorRatingsScrapedAt: { lt: retryAfter } },
                    ],
                },
            ],
        },
        select: {
            id: true, name: true, slug: true, city: true,
            tripadvisorLocationId: true,
        },
        orderBy: { id: "asc" },
        take: limit,
    });
}

async function postTaUpdate(payload) {
    const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
        method: "POST",
        headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status };
}

async function run({ limit = 5, disconnect = true } = {}) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        console.warn("[taScrape] HOSTINGER_URL or ADMIN_API_KEY unset — aborting");
        if (disconnect) await prisma.$disconnect();
        return { ok: false, reason: "config" };
    }

    const queue = await pickQueue(limit);
    if (!queue.length) {
        console.log("[taScrape] queue empty (all within TTL)");
        if (disconnect) await prisma.$disconnect();
        return { ok: true, scraped: 0 };
    }

    console.log(`[taScrape] queue ${queue.length} places`);
    const { browser, page } = await createGmapsPage();
    const stats = { scraped: 0, found: 0, miss: 0, photosUploaded: 0, failed: 0 };

    for (const p of queue) {
        try {
            // Step 1 — locate if needed.
            let locationId = p.tripadvisorLocationId;
            if (locationId == null) {
                console.log(`[taScrape] #${p.id} "${p.name}" — searching TA...`);
                const found = await findTaLocationId(page, { name: p.name, city: p.city });
                if (found) {
                    locationId = found;
                    console.log(`[taScrape]   matched locationId=${found}`);
                } else {
                    console.log(`[taScrape]   no match — writing -1 sentinel`);
                    await postTaUpdate({ placeId: p.id, tripadvisorLocationId: -1 });
                    stats.miss++;
                    await sleep(PLACE_SPACING_MS);
                    continue;
                }
            } else if (locationId === -1) {
                // Sentinel re-try
                console.log(`[taScrape] #${p.id} "${p.name}" — sentinel retry...`);
                const found = await findTaLocationId(page, { name: p.name, city: p.city });
                if (!found) {
                    // Stamp again so we don't re-search until next SEARCH_RETRY_DAYS
                    await postTaUpdate({ placeId: p.id, tripadvisorLocationId: -1 });
                    stats.miss++;
                    await sleep(PLACE_SPACING_MS);
                    continue;
                }
                locationId = found;
            }

            // Step 2 — scrape canonical page.
            const scrape = await scrapeTripadvisor(page, { locationId });
            if (scrape.error) {
                console.warn(`[taScrape] #${p.id} scrape error: ${scrape.error}`);
                stats.failed++;
                await sleep(PLACE_SPACING_MS);
                continue;
            }

            // Step 3 — push structured data to Hostinger.
            const payload = {
                placeId: p.id,
                tripadvisorLocationId: locationId,
                tripadvisorUrl: scrape.url,
                tripadvisorRating: scrape.rating,
                tripadvisorReviewCount: scrape.reviewCount,
                tripadvisorRanking: scrape.ranking,
                reviews: scrape.reviews,
                distribution: scrape.distribution,
            };
            const upd = await postTaUpdate(payload);
            if (!upd.ok) {
                console.warn(`[taScrape] #${p.id} update-place-ta HTTP ${upd.status}`);
                stats.failed++;
                await sleep(PLACE_SPACING_MS);
                continue;
            }

            // Step 4 — photos. Limit to 5, start positions after existing.
            const photos = (scrape.photoUrls || []).slice(0, 5).map((url, i) => ({
                sourceUrl: url,
                sourceRef: `ta:${locationId}:${i}`,    // synthetic ref for dedup
            }));
            if (photos.length) {
                const startPosition = (await maxPosition(prisma, p.id)) + 1;
                const photoResult = await processPlace({
                    placeId: p.id,
                    slug: p.slug,
                    source: "tripadvisor",
                    photos,
                    startPosition,
                });
                stats.photosUploaded += photoResult.uploaded || 0;
                console.log(`[taScrape] #${p.id} "${p.name}" — dist=${scrape.distribution ? JSON.stringify(scrape.distribution) : "n/a"} reviews=${(scrape.reviews||[]).length} photos+${photoResult.uploaded}/${photos.length}`);
            } else {
                console.log(`[taScrape] #${p.id} "${p.name}" — dist=${scrape.distribution ? JSON.stringify(scrape.distribution) : "n/a"} reviews=${(scrape.reviews||[]).length} photos=0`);
            }

            stats.scraped++;
            stats.found++;
            await sleep(PLACE_SPACING_MS);
        } catch (err) {
            console.warn(`[taScrape] #${p.id} crash: ${err.message}`);
            stats.failed++;
        }
    }

    await browser.close().catch(() => {});
    if (disconnect) await prisma.$disconnect();
    return { ok: true, stats, ...stats };
}

module.exports = { run };

if (require.main === module) {
    const args = process.argv.slice(2);
    const limit = (() => {
        const i = args.indexOf("--limit");
        if (i === -1) return 5;
        const n = parseInt(args[i + 1], 10);
        return Number.isFinite(n) ? n : 5;
    })();
    run({ limit, disconnect: true })
        .then((r) => console.log(JSON.stringify({ summary: r.stats || {} }, null, 2)))
        .catch((e) => { console.error(e); process.exit(1); });
}
