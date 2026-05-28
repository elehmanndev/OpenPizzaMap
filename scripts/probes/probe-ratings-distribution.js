#!/usr/bin/env node
// One-off probe to validate scripts/lib/gmaps.js#scrapeRatingsDistribution
// before we wire it into the enrichment runner. Picks 3 places with a
// googlePlaceId + googleReviewCount > 100 (so the panel definitely
// renders), scrapes each, prints the result + on-DB review count for
// comparison. Run locally with:
//
//   node scripts/probes/probe-ratings-distribution.js
//
// Expected output: 3 [c5,c4,c3,c2,c1] arrays whose sum is within ~5% of
// the DB's googleReviewCount.

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage, scrapeRatingsDistribution } = require("../lib/gmaps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const places = await prisma.place.findMany({
        where: {
            isVisible: true,
            googlePlaceId: { not: null },
            googleReviewCount: { gte: 100 },
        },
        select: { id: true, name: true, slug: true, googlePlaceId: true, googleReviewCount: true, googleRating: true },
        orderBy: { id: "asc" },
        take: 3,
    });

    if (!places.length) {
        console.log("No candidate places found.");
        await prisma.$disconnect();
        return;
    }

    console.log(`Probing ${places.length} places...`);
    const { browser, page } = await createGmapsPage();

    for (const p of places) {
        console.log(`\n#${p.id} "${p.name}" — DB has ${p.googleReviewCount} reviews @ ${p.googleRating}★`);
        const t0 = Date.now();
        const result = await scrapeRatingsDistribution(page, { googlePlaceId: p.googlePlaceId });
        const elapsed = Math.round((Date.now() - t0) / 1000);
        if (result.error) {
            console.log(`  ❌ ${result.error}  (${elapsed}s)`);
        } else {
            const drift = p.googleReviewCount ? ((result.total - p.googleReviewCount) / p.googleReviewCount * 100).toFixed(1) : "n/a";
            console.log(`  ✓ dist=[${result.dist.join(", ")}] sum=${result.total} (DB=${p.googleReviewCount}, drift=${drift}%)  (${elapsed}s)`);
        }
        await sleep(3000); // throttle
    }

    await browser.close();
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
