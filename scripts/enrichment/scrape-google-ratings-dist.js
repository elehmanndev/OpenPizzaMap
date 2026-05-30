#!/usr/bin/env node
// Scrape per-star ratings distribution from the public Google Maps DOM.
// Runs on the Unraid opm-runner, polite cadence, refreshes monthly.
//
// Why this exists: the Places API doesn't expose `ratings_distribution`
// at any tier (verified 2026-05-28). The public Maps page does — same
// data source as the existing scrape-gallery.js photo pipeline. We
// reuse the createGmapsPage + Reviews-tab nav from that scraper.
//
// Queue logic:
//   - Visible places only
//   - With googlePlaceId AND googleReviewCount >= 5 (panel doesn't
//     render for <5 reviews — Google hides the summary on tiny samples)
//   - Either never scraped OR last scraped > 30 days ago
//   - Ordered by id ASC
//   - Default limit 10/tick
//
// CAPTCHA handling: shared backoff cache pattern from scrape-gallery.js
// (3 strikes/24h → 7-day cooldown, otherwise 6h backoff).
//
// Storage:
//   - Place.googleRatingsDistribution: JSON array [c5, c4, c3, c2, c1]
//   - Place.googleRatingsScrapedAt: timestamp
//
// Validation: scrapeRatingsDistribution() in scripts/lib/gmaps.js
// cross-checks the parsed sum against the on-page total within 5%.
// Rows that fail validation are NOT written — they re-queue on the
// next tick (no cooldown, just a normal retry).

const fs = require("fs");
const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { createGmapsPage, scrapeRatingsDistribution, extractGoogleReviewsFromOpenPanel } = require("../lib/gmaps");

const BACKOFF_FILE = path.join(ROOT, "data", "cache", "ratings-dist-backoff.json");
const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_BACKOFF_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_DAYS = 30;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackoff() {
    try { return JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8")); }
    catch { return { captchas: [], blockedUntil: null, cooldownUntil: null }; }
}
function saveBackoff(state) {
    fs.mkdirSync(path.dirname(BACKOFF_FILE), { recursive: true });
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify(state, null, 2));
}
function isBlocked(state) {
    const now = Date.now();
    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) {
        return { blocked: true, reason: "cooldown", until: state.cooldownUntil };
    }
    if (state.blockedUntil && new Date(state.blockedUntil).getTime() > now) {
        return { blocked: true, reason: "backoff", until: state.blockedUntil };
    }
    return { blocked: false };
}
function recordStrike(state) {
    const now = Date.now();
    state.captchas = (state.captchas || []).filter(t => now - new Date(t).getTime() < STRIKE_WINDOW_MS);
    state.captchas.push(new Date(now).toISOString());
    if (state.captchas.length >= 3) {
        state.cooldownUntil = new Date(now + COOLDOWN_MS).toISOString();
        state.escalation = "3-strikes-7day-cooldown";
    } else {
        state.blockedUntil = new Date(now + FIRST_BACKOFF_MS).toISOString();
    }
    return state;
}

async function pickQueue(limit) {
    const ttlBoundary = new Date(Date.now() - REFRESH_TTL_DAYS * 86400_000);
    return prisma.place.findMany({
        where: {
            isVisible: true,
            googlePlaceId: { not: null },
            googleReviewCount: { gte: 5 },
            OR: [
                { googleRatingsScrapedAt: null },
                { googleRatingsScrapedAt: { lt: ttlBoundary } },
            ],
        },
        select: {
            id: true, name: true, city: true,
            googlePlaceId: true, googleReviewCount: true,
        },
        orderBy: { id: "asc" },
        take: limit,
    });
}

async function run({ limit = 10, disconnect = true } = {}) {
    const state = loadBackoff();
    const blockStatus = isBlocked(state);
    if (blockStatus.blocked) {
        console.log(`[ratingsDist] ${blockStatus.reason} active until ${blockStatus.until} — skipping tick`);
        if (disconnect) await prisma.$disconnect();
        return { ok: true, skipped: true, ...blockStatus };
    }

    const queue = await pickQueue(limit);
    if (!queue.length) {
        console.log("[ratingsDist] queue empty (all places within TTL)");
        if (disconnect) await prisma.$disconnect();
        return { ok: true, scraped: 0 };
    }

    console.log(`[ratingsDist] queue ${queue.length} places`);
    const { browser, page } = await createGmapsPage();
    const stats = { scraped: 0, captcha: 0, failed: 0, mismatch: 0 };
    let captchaHit = false;

    for (const p of queue) {
        const t0 = Date.now();
        const result = await scrapeRatingsDistribution(page, { googlePlaceId: p.googlePlaceId });
        const elapsed = Math.round((Date.now() - t0) / 1000);

        if (result.captcha) {
            console.warn(`[ratingsDist] #${p.id} CAPTCHA — aborting tick (${elapsed}s)`);
            stats.captcha++;
            captchaHit = true;
            break;
        }

        if (result.error) {
            // Validation failures (sum-mismatch, partial-distribution) re-queue
            // by NOT writing googleRatingsScrapedAt. Hard errors (no-distribution,
            // reviews-tab-not-found) get the timestamp so we don't spin on them.
            const isValidationMiss = /sum-mismatch|partial-distribution/.test(result.error);
            console.warn(`[ratingsDist] #${p.id} "${p.name}" — ${result.error} (${elapsed}s)${isValidationMiss ? " [will retry]" : ""}`);
            stats.failed++;
            if (isValidationMiss) {
                stats.mismatch++;
            } else {
                // Mark scraped-but-empty so the queue moves on.
                await prisma.place.update({
                    where: { id: p.id },
                    data: { googleRatingsScrapedAt: new Date() },
                }).catch(() => {});
            }
            await sleep(2500);
            continue;
        }

        const driftPct = p.googleReviewCount
            ? Math.round((result.total - p.googleReviewCount) / p.googleReviewCount * 100)
            : null;

        // Reject when drift is wildly off — the DB count can lag the live
        // total by months but >15% off usually means the parser picked
        // up per-review "N stars" aria-labels in addition to the summary
        // rows. Don't stamp scrapedAt so the place re-queues; we'd rather
        // be eventually correct than persist garbage.
        if (driftPct != null && Math.abs(driftPct) > 15) {
            console.warn(`[ratingsDist] #${p.id} "${p.name}" — drift ${driftPct}% > 15% (sum=${result.total} vs DB=${p.googleReviewCount}), skipping write (${elapsed}s)`);
            stats.failed++;
            stats.mismatch++;
            await sleep(2500);
            continue;
        }

        // Piggyback: extract review cards from the already-open Reviews
        // tab. Costs ~3s/place (a few feed scrolls + DOM walk). Stores
        // structured reviews so place.ejs can render them alongside the
        // refreshed bar graph.
        const reviews = await extractGoogleReviewsFromOpenPanel(page, 5);

        console.log(`[ratingsDist] #${p.id} "${p.name}" — dist=[${result.dist.join(",")}] sum=${result.total} drift=${driftPct}% reviews=${reviews.length} (${elapsed}s)`);

        await prisma.place.update({
            where: { id: p.id },
            data: {
                googleRatingsDistribution: result.dist,
                googleRatingsScrapedAt: new Date(),
                ...(reviews.length ? {
                    googleReviewsJson: JSON.stringify(reviews),
                    googleReviewsFetchedAt: new Date(),
                } : {}),
            },
        }).catch((e) => {
            console.warn(`[ratingsDist] #${p.id} db update failed: ${e.message}`);
        });
        stats.scraped++;

        // Polite throttle. Same cadence as scrape-gallery.js.
        await sleep(2500);
    }

    await browser.close().catch(() => {});

    if (captchaHit) {
        const next = recordStrike(state);
        saveBackoff(next);
        console.warn(`[ratingsDist] strike recorded — ${next.captchas.length}/3, blocked until ${next.cooldownUntil || next.blockedUntil}`);
    }

    if (disconnect) await prisma.$disconnect();
    return { ok: true, stats, ...stats };
}

module.exports = { run };

if (require.main === module) {
    const args = process.argv.slice(2);
    const limit = (() => {
        const i = args.indexOf("--limit");
        if (i === -1) return 10;
        const n = parseInt(args[i + 1], 10);
        return Number.isFinite(n) ? n : 10;
    })();
    run({ limit, disconnect: true })
        .then((r) => { console.log(JSON.stringify({ summary: r.stats || {} }, null, 2)); })
        .catch((e) => { console.error(e); process.exit(1); });
}
