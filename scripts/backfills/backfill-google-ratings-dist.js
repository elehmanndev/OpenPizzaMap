#!/usr/bin/env node
// One-shot backfill — loops the per-tick scraper until the queue empties
// (or a CAPTCHA cooldown takes over). Run on opm-runner:
//
//   docker exec -it opm-runner node scripts/backfills/backfill-google-ratings-dist.js
//
// With ~1,300 places eligible and a 2.5s polite delay per place plus
// ~10s of page load + tab click, expected wall time is ~70–90 minutes
// total. Splits naturally into 10-place ticks via the underlying
// run({ limit }) — same throttle math as scrape-gallery.js's overnight
// behavior, no surprises.
//
// Idempotent: places already scraped within the 30-day TTL are skipped
// by the queue picker. Safe to re-run.
//
// Flags:
//   --limit N      tile size per inner tick (default 10)
//   --max-ticks N  hard cap on tick count (default 200 → ~2000 places)
//   --dry-run      print the queue size and exit without scraping

const { prisma } = require("../lib/bootstrap");
const { run } = require("../enrichment/scrape-google-ratings-dist");

function arg(name, def) {
    const i = process.argv.indexOf(name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith("--")) return true;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

(async () => {
    const limit = arg("--limit", 10);
    const maxTicks = arg("--max-ticks", 200);
    const dryRun = arg("--dry-run", false);

    if (dryRun) {
        const eligible = await prisma.place.count({
            where: {
                isVisible: true,
                googlePlaceId: { not: null },
                googleReviewCount: { gte: 5 },
                OR: [
                    { googleRatingsScrapedAt: null },
                    { googleRatingsScrapedAt: { lt: new Date(Date.now() - 30 * 86400_000) } },
                ],
            },
        });
        console.log(`[backfill] eligible places: ${eligible}`);
        console.log(`[backfill] estimated wall time: ~${Math.ceil(eligible * 12 / 60)} minutes at 12s/place`);
        await prisma.$disconnect();
        return;
    }

    const totals = { scraped: 0, captcha: 0, failed: 0, mismatch: 0, ticks: 0 };
    const startedAt = Date.now();

    for (let i = 0; i < maxTicks; i++) {
        // disconnect:false on inner ticks — we share the prisma client.
        const r = await run({ limit, disconnect: false });
        totals.ticks++;

        if (r.skipped) {
            console.log(`[backfill] tick ${totals.ticks}: backoff active until ${r.until} — stopping`);
            break;
        }
        if (!r.stats || (r.stats.scraped + r.stats.failed) === 0) {
            console.log(`[backfill] tick ${totals.ticks}: queue empty — done`);
            break;
        }
        totals.scraped += r.stats.scraped || 0;
        totals.captcha += r.stats.captcha || 0;
        totals.failed  += r.stats.failed  || 0;
        totals.mismatch += r.stats.mismatch || 0;

        if (r.stats.captcha) {
            console.log(`[backfill] tick ${totals.ticks}: CAPTCHA hit — backoff engaged, stopping`);
            break;
        }

        const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
        console.log(`[backfill] tick ${totals.ticks} done: +${r.stats.scraped} scraped, ${r.stats.failed} failed. Totals: ${totals.scraped} scraped / ${totals.failed} failed in ${elapsedMin}m`);
    }

    const elapsedMin = Math.round((Date.now() - startedAt) / 60000);
    console.log(`\n[backfill] DONE — ${totals.scraped} places scraped, ${totals.failed} failed (${totals.mismatch} validation mismatch, will retry), ${totals.captcha} CAPTCHAs in ${elapsedMin}m across ${totals.ticks} ticks.`);

    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
