#!/usr/bin/env node
// Create a new Place row from CLI-provided ground-truth data.
//
// Use this when scrape-venue would over-scrape (e.g. when adding a
// second location of an existing brand, where the venue resolver
// would conflict with the first row). Eric provides exact name +
// address + coords from a Google Maps URL; we create the bare row +
// PlaceSource('manual'), and the runner's enrichment phases fill in
// the rest (Google place_id, photos, reviews, ratings, etc.) over
// subsequent ticks.
//
// Usage:
//   node scripts/admin/add-place.js \
//     --name "Sartoria Panatieri Eixample" \
//     --address "Carrer de Provença, 330, 08037 Barcelona, Spain" \
//     --city "Barcelona" --country "Spain" \
//     --lat 41.3971753 --lng 2.1649105 \
//     [--postal 08037] [--region Catalunya] [--apply]
//
// Dry-run by default. Prints the row that would be created.

const { prisma } = require('../lib/bootstrap');

function slugify(s) {
    return String(s)
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function parseArgs(argv) {
    const out = { apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        const KEYS = ['name', 'address', 'city', 'country', 'postal', 'region', 'lat', 'lng'];
        for (const k of KEYS) {
            if (a === `--${k}`) { out[k] = argv[++i]; break; }
            const v = eq(k); if (v != null) { out[k] = v; break; }
        }
        if (a === '--apply') out.apply = true;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const required = ['name', 'address', 'city', 'country', 'lat', 'lng'];
    const missing = required.filter((k) => !args[k]);
    if (missing.length) {
        console.error(`Missing required args: ${missing.join(', ')}`);
        console.error('Usage: node add-place.js --name "..." --address "..." --city "..." --country "..." --lat N --lng N [--postal ...] [--region ...] [--apply]');
        process.exit(1);
    }

    const lat = parseFloat(args.lat);
    const lng = parseFloat(args.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        console.error('lat/lng must be valid numbers');
        process.exit(1);
    }

    // Slug: name + city, slugified, with collision-avoiding suffix.
    const baseSlug = slugify(`${args.name} ${args.city}`);
    let finalSlug = baseSlug;
    let suffix = 2;
    while (await prisma.place.findUnique({ where: { slug: finalSlug }, select: { id: true } })) {
        finalSlug = `${baseSlug}-${suffix++}`;
    }

    // City row — find or create.
    const countryCode = args.country.length === 2 ? args.country.toUpperCase() : args.country; // crude — schema uses 2-letter codes upstream
    const citySlug = slugify(args.city);
    let cityRow = await prisma.city.findFirst({
        where: { slug: citySlug, OR: [{ countryCode }, { name: args.country }] },
        select: { id: true, name: true, countryCode: true },
    });

    const row = {
        name: args.name,
        addressLine: args.address,
        city: args.city,
        country: args.country,
        postalCode: args.postal || null,
        region: args.region || null,
        lat, lng,
        priceLevel: 2,
        stylesJson: '[]',
        slug: finalSlug,
        status: 'active',
        isVisible: true,
        cityId: cityRow ? cityRow.id : null,
    };

    console.log('Will create Place:');
    for (const [k, v] of Object.entries(row)) console.log(`  ${k.padEnd(14)} ${v == null ? '(null)' : v}`);
    if (cityRow) console.log(`  cityRef        #${cityRow.id} ${cityRow.name} (${cityRow.countryCode})`);
    else console.log(`  cityRef        — (no matching City row; cityId stays null until enrichment)`);

    if (!args.apply) {
        console.log('\nDry run. Pass --apply to create.');
        return;
    }

    const created = await prisma.$transaction(async (tx) => {
        const p = await tx.place.create({ data: row });
        await tx.placeSource.create({ data: { placeId: p.id, source: 'manual', rank: null } });
        return p;
    });
    console.log(`\nCREATED Place #${created.id} slug=${created.slug}`);
    console.log(`Visible at: https://openpizzamap.com/place/${created.id}`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
