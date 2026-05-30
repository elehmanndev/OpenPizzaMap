#!/usr/bin/env node
// Export all -1 sentinel places (TA backfill couldn't find them) as CSV
// for manual lookup. Sorted by Google review count DESC NULLS LAST so
// the most popular places — most likely to actually exist on TA but
// just got missed by our search — come first.
//
// Eric pastes a TA URL into the ta_url column for each place he finds.
// Companion import script reads the filled CSV back and updates the DB.
//
// Run on opm-runner:
//   docker exec opm-runner node scripts/exports/export-ta-sentinels.js > /tmp/sentinels.csv

const { prisma } = require("../lib/bootstrap");

function csvEscape(v) {
    if (v == null) return "";
    const s = String(v);
    if (/[,"\n\r]/.test(s)) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

(async () => {
    const rows = await prisma.place.findMany({
        where: {
            tripadvisorLocationId: -1,
            isVisible: true,
        },
        select: {
            id: true,
            name: true,
            city: true,
            country: true,
            addressLine: true,
            googleRating: true,
            googleReviewCount: true,
            slug: true,
        },
        orderBy: [
            { googleReviewCount: { sort: "desc", nulls: "last" } },
            { id: "asc" },
        ],
    });

    const headers = [
        "id",
        "name",
        "city",
        "country",
        "address",
        "google_rating",
        "google_review_count",
        "opm_url",
        "ta_search_hint",
        "ta_url",
    ];
    console.log(headers.join(","));

    for (const r of rows) {
        const opmUrl = `https://openpizzamap.com/place/${r.id}-${r.slug || ""}`;
        const taSearchHint = `https://www.tripadvisor.com/Search?q=${encodeURIComponent(`${r.name} ${r.city || ""}`.trim())}`;
        console.log([
            r.id,
            csvEscape(r.name),
            csvEscape(r.city),
            csvEscape(r.country),
            csvEscape(r.addressLine),
            r.googleRating ?? "",
            r.googleReviewCount ?? "",
            csvEscape(opmUrl),
            csvEscape(taSearchHint),
            "", // empty for user to fill
        ].join(","));
    }

    console.error(`\n# Exported ${rows.length} sentinel places to stdout`);
    await prisma.$disconnect();
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
