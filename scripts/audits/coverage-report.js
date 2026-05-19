#!/usr/bin/env node
// Coverage report — total visible places + how many are missing each
// enrichable field, with % vs total. Wraps src/services/audit-coverage.js
// so the terminal view stays in sync with /api/admin/audit/coverage.
//
// Usage:
//   node scripts/audits/coverage-report.js

const path = require("path");
const { ROOT } = require("../lib/bootstrap");
const { getCoverage } = require(path.join(ROOT, "src", "services", "audit-coverage"));

const FIELD_LABELS = {
    googlePlaceId:     "googlePlaceId",
    heroImageUrl:      "heroImageUrl",
    descriptionHtml:   "descriptionHtml",
    websiteUrl:        "websiteUrl",
    phone:             "phone",
    openingHours:      "openingHours",
    instagramUrl:      "instagramUrl",
    facebookUrl:       "facebookUrl",
    googleRating:      "googleRating",
    googleReviewCount: "googleReviewCount",
    osmCheckedAt:      "osmCheckedAt",
    addressLine:       "addressLine",
};

function pct(n, total) {
    if (!total) return "  0.0%";
    return `${(100 * n / total).toFixed(1).padStart(5)}%`;
}

function printTable(title, rows, total) {
    console.log(`\n${title}`);
    console.log("─".repeat(54));
    const nameWidth = Math.max(...rows.map(([k]) => k.length));
    for (const [label, count] of rows) {
        const countStr = String(count).padStart(6);
        console.log(`  ${label.padEnd(nameWidth)}  ${countStr}  ${pct(count, total)}`);
    }
}

(async () => {
    const cov = await getCoverage();
    console.log(`\nTotal visible places: ${cov.total}`);
    console.log(`Generated at: ${cov.generatedAt}`);

    const missingRows = Object.entries(cov.missing)
        .map(([k, v]) => [FIELD_LABELS[k] || k, v])
        .sort((a, b) => b[1] - a[1]);
    printTable("Missing per field (count, % of total)", missingRows, cov.total);

    const queueRows = Object.entries(cov.queueDepth)
        .filter(([, v]) => v != null)
        .sort((a, b) => b[1] - a[1]);
    printTable("Queue depth per phase", queueRows, cov.total);

    const stuckRows = Object.entries(cov.stuck).sort((a, b) => b[1] - a[1]);
    printTable("Stuck rows (silent gaps)", stuckRows, cov.total);

    console.log();
    process.exit(0);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
