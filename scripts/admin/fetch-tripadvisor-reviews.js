#!/usr/bin/env node
// One-shot TripAdvisor reviews fetch. For each visible place with a
// tripadvisorLocationId, call TA Content API /location/{id}/reviews and
// store up to 5 reviews as JSON on Place.tripadvisorReviewsJson + stamp
// tripadvisorReviewsFetchedAt.
//
// Cost: TA Content API "reviews" endpoint counts against the 5,000/month
// free tier. ~1,273 places have a TA id → fits within May budget
// (~793 used so far per the dashboard, ~4,200 remaining).
//
// Resumable / idempotent — by default only fetches places with no JSON
// yet, so re-running picks up where it left off. Pass --refresh to
// re-fetch everything.
//
// Uses the shared TripAdvisor budget tracker (scripts/lib/tripadvisor-budget.js)
// so we don't blow through the monthly free tier or daily cap.
//
// Run on the opm-runner Docker container:
//   docker exec opm-runner node scripts/admin/fetch-tripadvisor-reviews.js          # dry-run
//   docker exec opm-runner node scripts/admin/fetch-tripadvisor-reviews.js --apply
//   docker exec opm-runner node scripts/admin/fetch-tripadvisor-reviews.js --apply --limit=100

const { prisma } = require("../lib/bootstrap");
const taBudget = require("../lib/tripadvisor-budget");

const PACE_MS = 200;
const TA_BASE = "https://api.content.tripadvisor.com/api/v1";

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

// Normalize TA reviews shape into the same JSON blob /place renders:
// { author, rating, text, relativeTime, profilePhoto }
function normalizeTaReview(r) {
    return {
        author: (r.user && (r.user.username || r.user.user_location?.name)) || "Anonymous",
        rating: r.rating != null ? Number(r.rating) : null,
        title: r.title || null,
        text: r.text || "",
        relativeTime: r.published_date
            ? new Date(r.published_date).toLocaleDateString("en-US", { month: "long", year: "numeric" })
            : null,
        profilePhoto: r.user?.avatar?.small?.url || null,
        lang: r.lang || null,
        url: r.url || null,
        publishedAt: r.published_date || null,
    };
}

async function fetchOne(apiKey, locationId) {
    const url = `${TA_BASE}/location/${locationId}/reviews?key=${apiKey}&language=en&limit=5`;
    // TA's free Content API gates by Referer header — must match the
    // registered domain on the API key. Same pattern as scripts/lib/tripadvisor.js.
    const res = await fetch(url, {
        headers: {
            Accept: "application/json",
            Referer: "https://www.openpizzamap.com/",
        },
    });
    if (res.status === 429) throw new Error("TA_RATE_LIMITED");
    if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
    }
    const j = await res.json();
    const reviews = (j.data || []).slice(0, 5).map(normalizeTaReview);
    return reviews;
}

async function main() {
    if (!process.env.TRIPADVISOR_API_KEY) {
        console.error("TRIPADVISOR_API_KEY not set");
        process.exit(1);
    }
    const args = parseArgs(process.argv.slice(2));

    let where = { isVisible: true, tripadvisorLocationId: { not: null } };
    if (!args.refresh) where.tripadvisorReviewsJson = null;
    if (args.ids) where = { id: { in: args.ids }, tripadvisorLocationId: { not: null } };

    const all = await prisma.place.findMany({
        where,
        select: { id: true, name: true, tripadvisorLocationId: true },
        orderBy: { id: "asc" },
        take: args.limit || undefined,
    });

    console.log(`[ta-reviews] candidates=${all.length} apply=${args.apply} refresh=${args.refresh}`);
    if (!args.apply) {
        console.log(`[ta-reviews] DRY RUN — free under 5K/month TA tier`);
        await prisma.$disconnect();
        return;
    }

    const apiKey = process.env.TRIPADVISOR_API_KEY;
    const stats = { processed: 0, withReviews: 0, empty: 0, errors: 0 };
    const start = Date.now();

    for (let i = 0; i < all.length; i++) {
        const p = all[i];
        process.stdout.write(`[${i+1}/${all.length}] #${p.id} ${(p.name||"").slice(0,40)} … `);

        // Budget guard — throws if we've blown the daily/monthly cap.
        try {
            taBudget.reserve(`location/${p.tripadvisorLocationId}/reviews`);
        } catch (err) {
            console.error(`BUDGET STOP: ${err.message}`);
            break;
        }

        try {
            const reviews = await fetchOne(apiKey, p.tripadvisorLocationId);
            await prisma.place.update({
                where: { id: p.id },
                data: {
                    tripadvisorReviewsJson: reviews.length ? JSON.stringify(reviews) : null,
                    tripadvisorReviewsFetchedAt: new Date(),
                },
            });
            stats.processed++;
            if (reviews.length) stats.withReviews++; else stats.empty++;
            console.log(`+${reviews.length} reviews`);
        } catch (err) {
            stats.errors++;
            console.log(`ERR: ${err.message.slice(0,80)}`);
            if (err.message === "TA_RATE_LIMITED") {
                console.error("TA rate-limited — stopping. Re-run later to resume.");
                break;
            }
        }
        await sleep(PACE_MS);
    }

    const dur = ((Date.now() - start) / 1000).toFixed(0);
    const budget = taBudget.status();
    console.log("");
    console.log(`[ta-reviews] done in ${dur}s`);
    console.log(`  processed=${stats.processed}  with-reviews=${stats.withReviews}  empty=${stats.empty}  errors=${stats.errors}`);
    console.log(`  TA budget after: month ${budget.monthDetailCalls}/${budget.monthlyCap}, today ${budget.todayDetailCalls}/${budget.dailyCap}`);
    await prisma.$disconnect();
}

main().catch((err) => {
    console.error("[ta-reviews] crashed:", err);
    process.exit(1);
});
