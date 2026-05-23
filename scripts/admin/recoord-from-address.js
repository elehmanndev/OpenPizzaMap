#!/usr/bin/env node
// Re-geocode places by their addressLine via Nominatim (OSM, free) and
// patch any rows whose stored lat/lng don't match what the address
// actually resolves to. Built specifically to fix the case where two
// rows share the same coords in the DB despite having different
// addresses — the audit's "0m apart, address-match" trigger.
//
// Usage:
//   node scripts/admin/recoord-from-address.js --ids=1471,1476          # dry run
//   node scripts/admin/recoord-from-address.js --ids=1471,1476 --apply  # patch
//
// Etiquette: Nominatim's public instance allows 1 query/sec with an
// identifying User-Agent. We sleep 1.1s between queries to stay safely
// under the rate cap.
//
// Patch policy: only writes when the geocoded coord is >= 100m from the
// stored coord. Within 100m we trust the existing pin (small drift from
// Google geocoding is normal). Above 100m, something is wrong — the
// stored coord is either wholly wrong (the bug we're fixing) or off by
// enough to matter for proximity-based dedup audits.
//
// Also updates addressLine if Nominatim returned a longer/cleaner one,
// but never changes the city/country/region. The address is the input
// of truth here; we're aligning coords TO it, not the other way around.

const { prisma } = require('../lib/bootstrap');

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'OpenPizzaMap-recoord/0.1 (eric@openpizzamap.com)';
const POLITE_DELAY_MS = 1100;
const PATCH_THRESHOLD_M = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function haversineM(lat1, lng1, lat2, lng2) {
    if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return null;
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

function parseArgs(argv) {
    const out = { ids: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--ids') out.ids = argv[++i].split(',').map(Number);
        else if (a.startsWith('--ids=')) out.ids = a.split('=')[1].split(',').map(Number);
        else if (a === '--apply') out.apply = true;
    }
    return out;
}

async function geocode(query) {
    const url = `${NOMINATIM}?q=${encodeURIComponent(query)}&format=json&limit=1&addressdetails=1`;
    const r = await fetch(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`nominatim ${r.status}`);
    const arr = await r.json();
    if (!arr.length) return null;
    const hit = arr[0];
    return {
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
        displayName: hit.display_name,
        type: hit.type,
        class: hit.class,
    };
}

async function main() {
    const { ids, apply } = parseArgs(process.argv.slice(2));
    if (!ids || !ids.length) {
        console.error('Usage: node recoord-from-address.js --ids=N,N[,N] [--apply]');
        process.exit(1);
    }

    const rows = await prisma.place.findMany({
        where: { id: { in: ids } },
        select: { id: true, name: true, addressLine: true, city: true, country: true, lat: true, lng: true },
        orderBy: { id: 'asc' },
    });

    if (!rows.length) {
        console.log('[recoord] no rows found for those ids');
        return;
    }

    console.log(`[recoord] ${rows.length} row(s) — apply=${apply}`);
    console.log();

    for (const p of rows) {
        const dbLat = Number(p.lat);
        const dbLng = Number(p.lng);
        const query = [p.addressLine, p.city, p.country].filter(Boolean).join(', ');
        process.stdout.write(`#${p.id} "${p.name}" → ${query} … `);

        let hit;
        try {
            hit = await geocode(query);
        } catch (e) {
            console.log(`ERROR: ${e.message}`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }
        await sleep(POLITE_DELAY_MS);

        if (!hit) {
            console.log('no geocode result');
            continue;
        }

        const distM = Math.round(haversineM(dbLat, dbLng, hit.lat, hit.lng));
        console.log(`hit @${hit.lat.toFixed(6)},${hit.lng.toFixed(6)} (${hit.class}/${hit.type})  shift=${distM}m`);
        console.log(`     db @${dbLat.toFixed(6)},${dbLng.toFixed(6)}`);

        if (distM == null || distM < PATCH_THRESHOLD_M) {
            console.log(`     within ${PATCH_THRESHOLD_M}m — leaving as-is`);
            continue;
        }

        if (!apply) {
            console.log(`     >= ${PATCH_THRESHOLD_M}m — would patch (dry run; pass --apply)`);
            continue;
        }

        await prisma.place.update({
            where: { id: p.id },
            data: {
                lat: hit.lat,
                lng: hit.lng,
                // Reset enrichmentVersion so the next runner tick re-resolves
                // Google place_id + reviews/photos against the corrected coords.
                enrichmentVersion: 0,
            },
        });
        console.log(`     PATCHED → @${hit.lat.toFixed(6)},${hit.lng.toFixed(6)} (enrichmentVersion=0)`);
    }

    console.log();
    console.log('[recoord] done');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
