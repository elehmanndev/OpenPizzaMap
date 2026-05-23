#!/usr/bin/env node
// Manually patch a Place row's identity-critical fields (coords,
// addressLine, googlePlaceId, postalCode). Used when a row's coords or
// place_id are wrong and we have ground-truth values (e.g. a Google
// Maps URL Eric provided).
//
// Patches reset enrichmentVersion to 0 so the next runner tick
// re-resolves downstream enrichment (reviews, photos, ratings, TA)
// against the corrected identity.
//
// Usage:
//   node scripts/admin/patch-place.js --id=1472 --lat=40.429532 --lng=-3.6708832
//   node scripts/admin/patch-place.js --id=1472 --lat=40.429532 --lng=-3.6708832 --apply
//   node scripts/admin/patch-place.js --id=1472 --place-id=ChIJ... --address="Calle X, 12" --apply
//
// Always shows a before/after diff before writing. Dry-run by default —
// must pass --apply to commit.

const { prisma } = require('../lib/bootstrap');

function parseArgs(argv) {
    const out = { id: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--id') out.id = parseInt(argv[++i], 10);
        else if (eq('id')) out.id = parseInt(eq('id'), 10);
        else if (a === '--lat') out.lat = parseFloat(argv[++i]);
        else if (eq('lat')) out.lat = parseFloat(eq('lat'));
        else if (a === '--lng') out.lng = parseFloat(argv[++i]);
        else if (eq('lng')) out.lng = parseFloat(eq('lng'));
        else if (a === '--address') out.addressLine = argv[++i];
        else if (eq('address')) out.addressLine = eq('address');
        else if (a === '--place-id') out.googlePlaceId = argv[++i];
        else if (eq('place-id')) out.googlePlaceId = eq('place-id');
        else if (a === '--postal') out.postalCode = argv[++i];
        else if (eq('postal')) out.postalCode = eq('postal');
        else if (a === '--apply') out.apply = true;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!args.id) {
        console.error('Usage: node patch-place.js --id=N [--lat=... --lng=...] [--address="..."] [--place-id=...] [--postal=...] [--apply]');
        process.exit(1);
    }

    const patch = {};
    if (args.lat != null && !Number.isNaN(args.lat)) patch.lat = args.lat;
    if (args.lng != null && !Number.isNaN(args.lng)) patch.lng = args.lng;
    if (args.addressLine != null) patch.addressLine = args.addressLine;
    if (args.googlePlaceId != null) patch.googlePlaceId = args.googlePlaceId;
    if (args.postalCode != null) patch.postalCode = args.postalCode;

    if (!Object.keys(patch).length) {
        console.error('No fields to patch. Pass at least one of --lat/--lng/--address/--place-id/--postal.');
        process.exit(1);
    }

    const row = await prisma.place.findUnique({
        where: { id: args.id },
        select: {
            id: true, name: true, city: true, country: true,
            lat: true, lng: true, addressLine: true,
            googlePlaceId: true, postalCode: true, enrichmentVersion: true,
        },
    });
    if (!row) {
        console.error(`No place row with id=${args.id}`);
        process.exit(1);
    }

    console.log(`#${row.id} "${row.name}" (${row.city || '?'}, ${row.country || '?'})`);
    console.log();
    console.log('Field            Before                                   →  After');
    console.log('----------       ----------------------------------       --------------------------------');
    const fmt = (v) => v == null ? '(null)' : String(v);
    for (const k of Object.keys(patch)) {
        const before = row[k];
        const after = patch[k];
        const beforeStr = fmt(before).padEnd(40);
        const afterStr = fmt(after);
        const changed = String(before) !== String(after) ? '✱ ' : '  ';
        console.log(`${changed}${k.padEnd(15)} ${beforeStr} →  ${afterStr}`);
    }
    console.log();

    // Identity-critical changes warrant resetting enrichmentVersion so the
    // next runner tick re-resolves reviews/photos/TA against new coords/IDs.
    const resetsEnrichment = patch.lat != null || patch.lng != null || patch.googlePlaceId != null;
    if (resetsEnrichment) {
        console.log(`  enrichmentVersion ${row.enrichmentVersion} → 0  (identity changed, re-enrichment queued)`);
        console.log();
    }

    if (!args.apply) {
        console.log('Dry run. Pass --apply to commit.');
        return;
    }

    const data = { ...patch };
    if (resetsEnrichment) data.enrichmentVersion = 0;

    await prisma.place.update({ where: { id: args.id }, data });
    console.log('PATCHED.');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
