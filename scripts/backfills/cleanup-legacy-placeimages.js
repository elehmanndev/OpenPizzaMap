#!/usr/bin/env node
// Delete orphaned PlaceImage rows from the 2026-05-23 lazy migration.
//
// The migrate-legacy-heroes.js pass that ran on 2026-05-23 promoted
// every pre-existing heroImageUrl string into a PlaceImage row but
// never opened the underlying file to measure it. Result: 1,320 rows
// with source='legacy' and null bytes/width/height. In production
// those rows point at file paths that have since been swept — the
// migration ran BEFORE the persistent uploads move on 2026-05-23
// (see `feedback_no_prod_experiments` + the 2026-05-23 session
// note). Result: 404s when the gallery UI tries to render them.
//
// Cleanup logic:
//   - Drop every PlaceImage row where source='legacy'
//   - Places with a fresh Google scrape (~98% of catalogue) keep
//     working — their google-source rows take over the gallery
//   - Places with no scrape yet (~60) fall back to the Place.
//     heroImageUrl column (a string, NOT a PlaceImage row — that
//     field still points at Track 1 downloads in persistent
//     storage, which survived the deploy churn)
//
// Run:  node scripts/backfills/cleanup-legacy-placeimages.js --dry-run
//       node scripts/backfills/cleanup-legacy-placeimages.js --apply

const { prisma } = require("../lib/bootstrap");

(async () => {
    const apply = process.argv.includes("--apply");
    const dryRun = !apply;

    const legacyRows = await prisma.placeImage.count({ where: { source: "legacy" } });
    const placesWithLegacyOnly = await prisma.$queryRawUnsafe(
        `SELECT placeId, COUNT(*) AS n FROM PlaceImage GROUP BY placeId HAVING SUM(source!="legacy")=0`
    );

    console.log(`Legacy PlaceImage rows to drop: ${legacyRows}`);
    console.log(`Places that will be left with no PlaceImage rows (fall back to Place.heroImageUrl): ${placesWithLegacyOnly.length}`);

    if (placesWithLegacyOnly.length) {
        console.log("\nFirst 10 of those places:");
        const ids = placesWithLegacyOnly.slice(0, 10).map(r => Number(r.placeId));
        const places = await prisma.place.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, heroImageUrl: true },
        });
        for (const p of places) {
            const hero = p.heroImageUrl ? " hero=" + p.heroImageUrl : " (no heroImageUrl either)";
            console.log(`  #${p.id} "${p.name}"${hero}`);
        }
    }

    if (dryRun) {
        console.log("\n[DRY RUN] No deletion performed. Re-run with --apply to commit.");
        await prisma.$disconnect();
        return;
    }

    console.log("\n[APPLY] Deleting...");
    const result = await prisma.placeImage.deleteMany({ where: { source: "legacy" } });
    console.log(`Deleted ${result.count} rows.`);
    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
