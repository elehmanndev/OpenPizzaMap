#!/usr/bin/env node
// One-shot: fix the mislabeled thegreat.pizza photos that landed on
// 2026-05-26 via the first run of scrape-thegreat-pizza-photos.js.
//
// Context: download-gallery.js used to hardcode `source: "google"` on
// every PlaceImage row regardless of what the caller put in job.source.
// That bug was fixed in the same commit as this script (download-gallery.js
// now respects job.source). This script retroactively corrects the 706
// rows already on disk with sourceUrl prefixed assets.thegreat.pizza/
// but source = "google".
//
// Idempotent — re-runs are no-ops once the data is corrected.
//
// Usage:
//   node scripts/admin/relabel-thegreat-photos.js           # dry-run, prints count
//   node scripts/admin/relabel-thegreat-photos.js --apply

const { prisma } = require('../lib/bootstrap');

async function main() {
    const apply = process.argv.includes('--apply');

    const where = {
        sourceUrl: { startsWith: 'https://assets.thegreat.pizza/' },
        source: 'google',
    };

    const count = await prisma.placeImage.count({ where });
    console.log(`[relabel] candidates (sourceUrl ~ assets.thegreat.pizza, source = "google"): ${count}`);

    if (!count) {
        console.log('[relabel] nothing to do.');
        return;
    }

    // Sanity peek
    const sample = await prisma.placeImage.findMany({
        where,
        select: { id: true, placeId: true, sourceRef: true, sourceUrl: true },
        take: 3,
    });
    console.log('[relabel] sample:');
    for (const s of sample) console.log(`  #${s.id} placeId=${s.placeId} ref=${s.sourceRef}`);

    if (!apply) {
        console.log('[relabel] DRY-RUN — pass --apply to UPDATE.');
        return;
    }

    const r = await prisma.placeImage.updateMany({
        where,
        data: { source: 'thegreat.pizza' },
    });
    console.log(`[relabel] updated ${r.count} rows: source "google" -> "thegreat.pizza"`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
