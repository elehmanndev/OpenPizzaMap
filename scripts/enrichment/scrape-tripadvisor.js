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
const { scrapeTripadvisor, createTaPage } = require("../lib/tripadvisor");
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
                // Was a true-miss (-1 sentinel) but enough time passed.
                // 2026-05-30: removed the `tripadvisorRatingsScrapedAt: null`
                // branch — it was re-queuing every backfill sentinel every
                // tick (the backfill never set scrapedAt on sentinels).
                // Sentinels with null scrapedAt now mean "leave alone".
                // Sentinel writes below ALSO set scrapedAt=now so the 180d
                // retry clock actually starts.
                {
                    tripadvisorLocationId: -1,
                    tripadvisorRatingsScrapedAt: { lt: retryAfter },
                },
            ],
        },
        select: {
            id: true, name: true, slug: true, city: true, country: true,
            tripadvisorLocationId: true,
            tripadvisorUrl: true,
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
    // TA bot-fingerprints stock Playwright and serves blank pages.
    // CloakBrowser patches the detection layer. ~535MB binary; the
    // entrypoint self-heals it on docker restart.
    const { browser, page } = await createTaPage();
    const stats = { scraped: 0, found: 0, miss: 0, photosUploaded: 0, failed: 0 };

    for (const p of queue) {
        try {
            // Pass whatever locationId we have (null, -1, or positive)
            // straight through. scrapeTripadvisor's internal strategy
            // chain handles all three cases:
            //   - positive: try stored URL → fall back to API resolve
            //     on heading mismatch
            //   - null: API resolve via taLookup (free /location/search +
            //     billed /location/{id}/details)
            //   - -1 sentinel: same as null — re-try via API. The runner
            //     gets a fresh locationId in scrape.locationIdOut if the
            //     API now finds a match (self-heal — previously sentinel
            //     places were blocked from re-discovery because the
            //     runner used findTaLocationId() which goes through
            //     Playwright /Search, whose JS-mounted results don't
            //     render consistently).
            const locationId = p.tripadvisorLocationId;
            const scrape = await scrapeTripadvisor(page, {
                locationId,
                name: p.name,
                city: p.city,
                country: p.country,
                tripadvisorUrl: p.tripadvisorUrl,
            });

            // "API also can't find this venue" → write -1 sentinel so
            // we skip retries until SEARCH_RETRY_DAYS expires.
            if (scrape.error === "api-lookup-no-match") {
                console.log(`[taScrape] #${p.id} "${p.name}" — no TA match (API search empty) → -1 sentinel`);
                await postTaUpdate({ placeId: p.id, tripadvisorLocationId: -1 });
                stats.miss++;
                await sleep(PLACE_SPACING_MS);
                continue;
            }
            if (scrape.error) {
                console.warn(`[taScrape] #${p.id} scrape error: ${scrape.error}`);
                stats.failed++;
                await sleep(PLACE_SPACING_MS);
                continue;
            }

            // Step 3 — push structured data to Hostinger. If the
            // scrape self-healed a wrong stored locationId via the
            // search fallback, scrape.locationIdOut carries the new
            // canonical id — write THAT to the DB.
            const finalLocationId = scrape.locationIdOut || locationId;
            const payload = {
                placeId: p.id,
                tripadvisorLocationId: finalLocationId,
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
                sourceRef: `ta:${finalLocationId}:${i}`,    // synthetic ref for dedup
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
