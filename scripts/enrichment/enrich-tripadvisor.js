#!/usr/bin/env node
// Fill TripAdvisor metadata (locationId, rating, reviewCount, ranking,
// url) for places that don't have it yet. Uses the shared lib at
// scripts/lib/tripadvisor.js + the existing budget tracker.
//
// Usage:
//   node scripts/enrichment/enrich-tripadvisor.js                 # dry-run
//   node scripts/enrichment/enrich-tripadvisor.js --apply         # writes
//   node scripts/enrichment/enrich-tripadvisor.js --limit=5 --apply
//   node scripts/enrichment/enrich-tripadvisor.js --country=IT    # filter
//   node scripts/enrichment/enrich-tripadvisor.js --ids=1,2,3     # specific
//
// Queue: visible places where tripadvisorLocationId IS NULL, ordered
// NULL tripadvisorCheckedAt first (untried). Sentinel value -1 in
// tripadvisorLocationId marks "search returned no confident match" so
// we don't keep paying for the same lookup forever — same negative-cache
// pattern as the Playwright resolver.

const { prisma } = require('../lib/bootstrap');
const { taLookup } = require('../lib/tripadvisor');
const taBudget = require('../lib/tripadvisor-budget');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const IDS = (() => {
    const a = args.find((x) => x.startsWith('--ids='));
    return a ? a.slice(6).split(',').map((s) => parseInt(s, 10)).filter(Boolean) : null;
})();
const LIMIT = (() => {
    const a = args.find((x) => x.startsWith('--limit='));
    return a ? parseInt(a.slice(8), 10) : null;
})();
const COUNTRY = (() => {
    const a = args.find((x) => x.startsWith('--country='));
    return a ? a.slice(10) : null;
})();

// Sentinel value: -1 in tripadvisorLocationId means "search ran but no
// confident match" — prevents the row from being re-queued every cron.
const NEGATIVE_CACHE_SENTINEL = -1;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let where;
    if (IDS) where = { id: { in: IDS } };
    else {
        where = {
            isVisible: true,
            tripadvisorLocationId: null,
        };
        if (COUNTRY) where.country = COUNTRY;
    }

    const placesAll = await prisma.place.findMany({
        where,
        select: { id: true, name: true, city: true, country: true, tripadvisorLocationId: true, tripadvisorRating: true },
        // Prefer Italy + Spain first (highest TA coverage + matches the
        // geo priorities). Inside each country, oldest enrichedAt first.
        orderBy: [
            { country: 'asc' },
            { id: 'asc' },
        ],
    });
    const places = LIMIT ? placesAll.slice(0, LIMIT) : placesAll;

    const before = taBudget.status();
    console.log(`[ta] ${places.length} places to enrich (apply=${APPLY})`);
    console.log(`[ta] BILLED before: month ${before.monthDetailCalls}/${before.monthlyCap}, today ${before.todayDetailCalls}/${before.dailyCap}`);
    console.log(`[ta] FREE search before: month ${before.monthSearchCalls}, today ${before.todaySearchCalls}`);
    console.log('');

    let matched = 0, missed = 0, errors = 0;

    for (const p of places) {
        try {
            const r = await taLookup(p.name, p.city, p.country);
            if (!r) {
                missed++;
                console.log(`[ta] #${p.id} "${p.name}" / ${p.city} — no confident match`);
                if (APPLY) {
                    await prisma.place.update({
                        where: { id: p.id },
                        data: { tripadvisorLocationId: NEGATIVE_CACHE_SENTINEL },
                    });
                }
                await sleep(500);
                continue;
            }
            matched++;
            const rating = r.details && r.details.rating != null ? Number(r.details.rating) : null;
            const reviewCount = r.details && r.details.num_reviews != null ? parseInt(r.details.num_reviews, 10) : null;
            const url = (r.details && r.details.web_url) || null;
            const ranking = (r.details && r.details.ranking_data && r.details.ranking_data.ranking_string) || null;
            console.log(`[ta] #${p.id} "${p.name}" / ${p.city} → loc=${r.search.location_id} sim=${r.similarity} ★${rating ?? '-'} (${reviewCount ?? '-'} reviews)`);
            if (ranking) console.log(`     ranking: ${ranking}`);
            if (url) console.log(`     url: ${url}`);

            if (APPLY) {
                // TA returns location_id as a string ("12597899"); our column is
                // Int — parseInt before writing.
                const locationId = parseInt(r.search.location_id, 10);
                await prisma.place.update({
                    where: { id: p.id },
                    data: {
                        tripadvisorLocationId: locationId,
                        tripadvisorRating: rating,
                        tripadvisorReviewCount: reviewCount,
                        tripadvisorRanking: ranking,
                        tripadvisorUrl: url,
                    },
                });
            }
            await sleep(500);
        } catch (e) {
            errors++;
            console.log(`[ta] #${p.id} "${p.name}" ERROR: ${e.message}`);
            // Budget-cap errors are terminal — stop the run rather than
            // hammering through the rest.
            if (/cap reached/i.test(e.message)) {
                console.log('[ta] hit budget cap, aborting');
                break;
            }
        }
    }

    const after = taBudget.status();
    console.log('');
    console.log(`[ta] matched=${matched} missed=${missed} errors=${errors}`);
    console.log(`[ta] BILLED after:  month ${after.monthDetailCalls}/${after.monthlyCap}, today ${after.todayDetailCalls}/${after.dailyCap}`);
    console.log(`[ta] FREE search after:  month ${after.monthSearchCalls}, today ${after.todaySearchCalls}`);
    const billedThisRun = after.monthDetailCalls - before.monthDetailCalls;
    const searchThisRun = after.monthSearchCalls - before.monthSearchCalls;
    console.log(`[ta] this run: ${searchThisRun} free search + ${billedThisRun} billed = ${searchThisRun + billedThisRun} total`);

    await prisma.$disconnect();
})();
