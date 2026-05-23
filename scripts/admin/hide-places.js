#!/usr/bin/env node
// Set isVisible=false on a list of Place rows. Direct DB update via
// Prisma — bypasses the HTTP /api/admin/places-hide endpoint when that
// path is broken or auth is misconfigured.
//
// Usage:
//   node scripts/admin/hide-places.js --ids=1,2,3            # dry run
//   node scripts/admin/hide-places.js --ids=1,2,3 --apply    # apply

const { prisma } = require('../lib/bootstrap');

function parseArgs(argv) {
    const out = { ids: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ids') out.ids = argv[++i].split(',').map((s) => parseInt(s, 10));
        else if (a.startsWith('--ids=')) out.ids = a.split('=')[1].split(',').map((s) => parseInt(s, 10));
        else if (a === '--apply') out.apply = true;
    }
    return out;
}

async function main() {
    const { ids, apply } = parseArgs(process.argv.slice(2));
    if (!ids || !ids.length) {
        console.error('Usage: node hide-places.js --ids=N,N,N [--apply]');
        process.exit(1);
    }
    const rows = await prisma.place.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, city: true, isVisible: true },
        orderBy: { id: 'asc' },
    });
    console.log(`Targets (${rows.length}/${ids.length} found):`);
    for (const r of rows) {
        console.log(`  #${r.id} "${r.name}" (${r.city}) visible=${r.isVisible}`);
    }
    if (!apply) {
        console.log('\nDry run. Pass --apply to commit.');
        return;
    }
    const result = await prisma.place.updateMany({
        where: { id: { in: ids } },
        data: { isVisible: false },
    });
    console.log(`\nHidden ${result.count} rows.`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
