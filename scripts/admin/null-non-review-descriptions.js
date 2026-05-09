#!/usr/bin/env node
// One-shot cleanup: null-out every Place.descriptionHtml that wasn't
// generated from real customer reviews.
//
// Background: an earlier version of generate-descriptions.js had a website
// fallback that produced generic Gemini blurbs ("Experience authentic
// Neapolitan pizza...") for places without scraped reviews. Eric's rule is
// review-based descriptions only ("Pizza Lovers say: ...") — so anything
// that doesn't match that prefix is stale and must be cleared.
//
// Usage:
//   node scripts/admin/null-non-review-descriptions.js --dry-run
//   node scripts/admin/null-non-review-descriptions.js --apply

const { prisma } = require("../lib/bootstrap");

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY   = process.argv.includes("--apply");

if (!DRY_RUN && !APPLY) {
    console.error("Usage: node scripts/admin/null-non-review-descriptions.js --dry-run | --apply");
    process.exit(1);
}

const REVIEW_PREFIX = "Pizza Lovers say:";

async function main() {
    const rows = await prisma.place.findMany({
        where: { descriptionHtml: { not: null } },
        select: { id: true, name: true, city: true, country: true, descriptionHtml: true },
        orderBy: { id: "asc" },
    });

    const bad = rows.filter(r => !String(r.descriptionHtml).trim().startsWith(REVIEW_PREFIX));
    const good = rows.length - bad.length;

    console.log(`[cleanup] ${rows.length} places have a description`);
    console.log(`[cleanup]   review-based (kept):    ${good}`);
    console.log(`[cleanup]   non-review (to clear):  ${bad.length}\n`);

    for (const r of bad.slice(0, 20)) {
        console.log(`  #${r.id} "${r.name}" (${r.city}, ${r.country})`);
        console.log(`     → ${String(r.descriptionHtml).slice(0, 120)}`);
    }
    if (bad.length > 20) console.log(`  ... +${bad.length - 20} more\n`);

    if (DRY_RUN) {
        console.log("\n[cleanup] Dry-run — no writes. Re-run with --apply to clear.");
        return;
    }

    let cleared = 0;
    for (const r of bad) {
        await prisma.place.update({
            where: { id: r.id },
            data: { descriptionHtml: null },
        });
        cleared++;
        if (cleared % 50 === 0) console.log(`[cleanup] cleared ${cleared}/${bad.length}...`);
    }
    console.log(`\n[cleanup] Done — cleared ${cleared} non-review descriptions.`);
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
