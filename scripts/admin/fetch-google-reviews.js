#!/usr/bin/env node
// One-shot Google reviews fetch. For each visible place with a
// googlePlaceId, call Place Details (reviews field) and store up to 5
// reviews as JSON on Place.googleReviewsJson + stamp googleReviewsFetchedAt.
//
// Cost: Place Details (Atmosphere SKU, reviews field) = ~$0.005/place
// For 2,400 places: ~$12, fits comfortably in the €130 expiring credit.
//
// Resumable / idempotent — by default only fetches places with no JSON
// yet, so re-running just picks up where it left off. Pass --refresh to
// re-fetch everything (e.g. quarterly cadence).
//
// Run on the opm-runner Docker container (has GOOGLE_MAPS_API_KEY +
// DATABASE_URL):
//   docker exec opm-runner node scripts/admin/fetch-google-reviews.js          # dry-run
//   docker exec opm-runner node scripts/admin/fetch-google-reviews.js --apply
//   docker exec opm-runner node scripts/admin/fetch-google-reviews.js --apply --limit=100
//   docker exec opm-runner node scripts/admin/fetch-google-reviews.js --apply --refresh

const { prisma } = require("../lib/bootstrap");

const PACE_MS = 80;
const COST_PER_CALL = 0.005;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { apply: false, limit: null, refresh: false, ids: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--apply") out.apply = true;
        else if (a === "--refresh") out.refresh = true;
        else if (a.startsWith("--limit=")) out.limit = parseInt(a.slice(8), 10);
        else if (a === "--limit") out.limit = parseInt(argv[++i], 10);
        else if (a.startsWith("--ids=")) out.ids = a.slice(6).split(",").map(Number).filter(Boolean);
    }
    return out;
}

// Normalize Google's Place Details reviews shape into the JSON blob we
// store. /place renders { author, rating, text, relativeTime, profilePhoto }.
function normalizeGoogleReview(r) {
    return {
        author: r.authorAttribution?.displayName || "Anonymous",
        rating: r.rating != null ? Number(r.rating) : null,
        text: (r.text && r.text.text) || (r.originalText && r.originalText.text) || "",
        relativeTime: r.relativePublishTimeDescription || null,
        profilePhoto: r.authorAttribution?.photoUri || null,
        lang: (r.text && r.text.languageCode) || null,
        publishedAt: r.publishTime || null,
    };
}

async function fetchOne(apiKey, googlePlaceId) {
    const url = `https://places.googleapis.com/v1/places/${googlePlaceId}?fields=reviews&key=${apiKey}`;
    const res = await fetch(url, {
        headers: { "X-Goog-Api-Key": apiKey },
    });
    if (res.status === 429) {
        throw new Error("QUOTA_EXCEEDED");
    }
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
    }
    const j = await res.json();
    const reviews = (j.reviews || []).slice(0, 5).map(normalizeGoogleReview);
    return reviews;
}

async function main() {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        console.error("GOOGLE_MAPS_API_KEY not set");
        process.exit(1);
    }
    const args = parseArgs(process.argv.slice(2));

    let where = { isVisible: true, googlePlaceId: { not: null } };
    if (!args.refresh) where.googleReviewsJson = null;
    if (args.ids) where = { id: { in: args.ids }, googlePlaceId: { not: null } };

    const all = await prisma.place.findMany({
        where,
        select: { id: true, name: true, googlePlaceId: true },
        orderBy: { id: "asc" },
        take: args.limit || undefined,
    });

    console.log(`[google-reviews] candidates=${all.length} apply=${args.apply} refresh=${args.refresh}`);
    if (!args.apply) {
        const cost = (all.length * COST_PER_CALL).toFixed(2);
        console.log(`[google-reviews] DRY RUN — would cost ~$${cost}`);
        await prisma.$disconnect();
        return;
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    const stats = { processed: 0, withReviews: 0, empty: 0, errors: 0 };
    const start = Date.now();

    for (let i = 0; i < all.length; i++) {
        const p = all[i];
        process.stdout.write(`[${i+1}/${all.length}] #${p.id} ${(p.name||"").slice(0,40)} … `);
        try {
            const reviews = await fetchOne(apiKey, p.googlePlaceId);
            await prisma.place.update({
                where: { id: p.id },
                data: {
                    googleReviewsJson: reviews.length ? JSON.stringify(reviews) : null,
                    googleReviewsFetchedAt: new Date(),
                },
            });
            stats.processed++;
            if (reviews.length) stats.withReviews++; else stats.empty++;
            console.log(`+${reviews.length} reviews`);
        } catch (err) {
            stats.errors++;
            console.log(`ERR: ${err.message.slice(0,80)}`);
            if (err.message === "QUOTA_EXCEEDED") {
                console.error("Quota exceeded — stopping. Re-run later to resume.");
                break;
            }
        }
        if ((i+1) % 100 === 0) {
            const spent = (stats.processed * COST_PER_CALL).toFixed(2);
            console.log(`  --- ${i+1}/${all.length} processed, ~$${spent} so far ---`);
        }
        await sleep(PACE_MS);
    }

    const dur = ((Date.now() - start) / 1000).toFixed(0);
    const cost = (stats.processed * COST_PER_CALL).toFixed(2);
    console.log("");
    console.log(`[google-reviews] done in ${dur}s`);
    console.log(`  processed=${stats.processed}  with-reviews=${stats.withReviews}  empty=${stats.empty}  errors=${stats.errors}`);
    console.log(`  est cost: $${cost}`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error("[google-reviews] crashed:", err);
    process.exit(1);
});
