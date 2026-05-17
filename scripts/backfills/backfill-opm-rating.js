#!/usr/bin/env node
// Compute Place.opmRating for every visible place from external aggregator
// signals and (when present) OPM community reviews. Idempotent — re-running
// produces the same numbers and only writes rows whose computed value
// actually changed.
//
// Importable: exports `run(opts)` so src/services/maintenance.js can
// call it in-process inside the live worker (avoids the Hostinger
// Prisma "tokio panic" hit when this is spawned as a bare CLI script).
//
// Two-pass:
//   1. Compute global priorMean as the count-weighted average of every
//      place's external rating (weighted by min(count, 100)). Falls back
//      to PRIOR_MEAN constant if the dataset is empty.
//   2. For each place, gather its external signals + any OPM reviews,
//      run computeOpmRating with the dynamic priorMean, and update the
//      row if the rounded value differs from what's stored.
//
// Usage:
//   node scripts/backfill-opm-rating.js              # dry-run, prints histogram
//   node scripts/backfill-opm-rating.js --apply      # write back to Place.opmRating

const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { computeOpmRating, PRIOR_MEAN, CAP_PER_EXTERNAL_SOURCE } = require(path.join(ROOT, "src", "services", "opm-rating"));

const EXTERNAL_PAIRS = [
    ["googleRating", "googleReviewCount"],
    ["tripadvisorRating", "tripadvisorReviewCount"],
    ["yelpRating", "yelpReviewCount"],
];

function computePriorMean(places) {
    let totalWeight = 0;
    let weighted = 0;
    for (const p of places) {
        for (const [rf, cf] of EXTERNAL_PAIRS) {
            const r = p[rf];
            const c = p[cf];
            if (r == null || c == null) continue;
            const rn = Number(r), cn = Number(c);
            if (!Number.isFinite(rn) || !Number.isFinite(cn) || cn <= 0) continue;
            const w = Math.min(cn, CAP_PER_EXTERNAL_SOURCE);
            weighted += rn * w;
            totalWeight += w;
        }
    }
    if (totalWeight === 0) return PRIOR_MEAN;
    return Math.round((weighted / totalWeight) * 100) / 100;
}

async function loadAllReviewsByPlaceId() {
    // Use raw SQL so this works even if the local Prisma client wasn't
    // regenerated with the Review model (Windows DLL lock during local
    // dev). Prod auto-regenerates on every deploy via postinstall, so
    // there's no equivalent issue when this runs on Hostinger.
    const rows = await prisma.$queryRawUnsafe(
        "SELECT placeId, pizza, `local`, servicio, precio FROM Review WHERE isVisible = 1"
    );
    const byId = new Map();
    for (const r of rows) {
        if (!byId.has(r.placeId)) byId.set(r.placeId, []);
        byId.get(r.placeId).push({
            pizza: Number(r.pizza),
            local: Number(r.local),
            servicio: Number(r.servicio),
            precio: Number(r.precio),
        });
    }
    return byId;
}

function bucketHistogram(values) {
    // Bucket of width 0.5 from 0 to 5 (matches the new /5 scale).
    const buckets = new Map();
    for (let b = 0; b <= 5; b += 0.5) buckets.set(b.toFixed(1), 0);
    for (const v of values) {
        if (v == null) continue;
        const b = (Math.floor(v * 2) / 2).toFixed(1);
        buckets.set(b, (buckets.get(b) || 0) + 1);
    }
    return buckets;
}

async function run({ apply = false } = {}) {
    const all = await prisma.place.findMany({
        select: {
            id: true, name: true, opmRating: true,
            googleRating: true, googleReviewCount: true,
            tripadvisorRating: true, tripadvisorReviewCount: true,
            yelpRating: true, yelpReviewCount: true,
        },
    });
    console.log(`[backfill] loaded ${all.length} places`);

    const reviewsByPlaceId = await loadAllReviewsByPlaceId();
    const totalReviews = [...reviewsByPlaceId.values()].reduce((s, arr) => s + arr.length, 0);
    console.log(`[backfill] loaded ${totalReviews} OPM review${totalReviews === 1 ? "" : "s"} across ${reviewsByPlaceId.size} place${reviewsByPlaceId.size === 1 ? "" : "s"}`);

    const priorMean = computePriorMean(all);
    console.log(`[backfill] priorMean = ${priorMean} (default would be ${PRIOR_MEAN})`);

    let computedRows = 0, updatedRows = 0, unchangedRows = 0, nullRows = 0;
    const computedValues = [];

    for (const p of all) {
        const reviews = reviewsByPlaceId.get(p.id) || [];
        const out = computeOpmRating(p, reviews, priorMean);
        computedValues.push(out);

        if (out == null) {
            nullRows++;
            // Clear stale opmRating if upstream data is now missing.
            if (p.opmRating != null && apply) {
                await prisma.place.update({ where: { id: p.id }, data: { opmRating: null } });
                updatedRows++;
            }
            continue;
        }
        computedRows++;
        const stored = p.opmRating == null ? null : Number(p.opmRating);
        if (stored != null && Math.abs(stored - out) < 0.005) {
            unchangedRows++;
            continue;
        }
        if (apply) {
            await prisma.place.update({ where: { id: p.id }, data: { opmRating: out } });
            updatedRows++;
        }
    }

    console.log(`[backfill] computed=${computedRows}  null(no data)=${nullRows}  unchanged=${unchangedRows}  ${apply ? "wrote" : "would write"}=${updatedRows}`);

    const hist = bucketHistogram(computedValues);
    console.log("\n[histogram] opmRating distribution (bucket width 0.5):");
    for (const [bucket, n] of hist) {
        if (n === 0) continue;
        const bar = "▓".repeat(Math.min(60, Math.round(n / 5)));
        console.log(`  ${bucket.padStart(4)}  ${String(n).padStart(4)}  ${bar}`);
    }
    console.log(`  null  ${String(nullRows).padStart(4)}  (no rating signals)`);

    if (!apply) console.log("\n(dry-run — pass --apply to write opmRating back)");

    return {
        ok: true, total: all.length,
        computed: computedRows, updated: updatedRows,
        unchanged: unchangedRows, nullRows,
        priorMean,
    };
}

if (require.main === module) {
    run({ apply: process.argv.includes("--apply") })
        .catch((e) => { console.error(e); process.exit(1); })
        .finally(async () => { await prisma.$disconnect(); });
}

module.exports = { run };
