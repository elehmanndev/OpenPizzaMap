#!/usr/bin/env node
// Dry-preview the dedup outcome for gambero-rosso-scrape.json against the
// live DB, WITHOUT writing anything. Reuses the real enrichAndValidate
// pipeline so the counts match exactly what `import-places.js` would do.
//
// Output: counts of merge_into (per layer) vs created vs manual_review.
//
// Usage:
//   ENRICHMENT_PROVIDER=google_api node scripts/importers/preview-gambero-rosso.js

const fs = require('fs');
const path = require('path');
const { prisma, ROOT, PATHS } = require('../lib/bootstrap');
const { enrichAndValidate } = require(path.join(ROOT, 'src', 'services', 'enrichment'));
const { getProvider } = require(path.join(ROOT, 'src', 'services', 'enrichment', 'providers'));

const JSON_PATH = path.join(PATHS.scrapes, 'gambero-rosso-scrape.json');

function canonCityName(s) {
    const CITY_NAME_CANON = {
        roma: 'Rome', napoli: 'Naples', firenze: 'Florence', milano: 'Milan',
        torino: 'Turin', genova: 'Genoa',
    };
    const k = String(s || '').toLowerCase().trim();
    return CITY_NAME_CANON[k] || s;
}

async function main() {
    const j = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    const venues = j.places.filter((v) => v.name && v.city && v.lat != null && v.lng != null);
    console.log(`[preview] ${venues.length} venues with usable name+city+coords (of ${j.count} total)`);

    const provider = getProvider({ prisma, override: 'google_api' });
    const counts = { merge_googlePlaceId: 0, merge_bbox: 0, merge_slug: 0, create: 0, manual_review: 0 };
    const merges = []; // sample for inspection
    const creates = []; // sample
    const flagged = [];
    const byCity = {}; // city → { merge, create }

    for (let i = 0; i < venues.length; i++) {
        const v = venues[i];
        const verdict = await enrichAndValidate({
            name: v.name,
            city: canonCityName(v.city),
            country: 'Italy',
            lat: v.lat,
            lng: v.lng,
        }, { prisma, provider });

        const cityKey = canonCityName(v.city);
        if (!byCity[cityKey]) byCity[cityKey] = { merge: 0, create: 0 };

        if (verdict.action === 'manual_review') {
            counts.manual_review++;
            flagged.push({ name: v.name, city: v.city, reasons: verdict.reasons });
        } else if (verdict.existing) {
            // verdict.reasons includes "dedup match via {layer}"
            const layerMatch = (verdict.reasons.find((r) => r.startsWith('dedup match via ')) || '').replace('dedup match via ', '');
            if (layerMatch === 'googlePlaceId') counts.merge_googlePlaceId++;
            else if (layerMatch === 'bbox+name') counts.merge_bbox++;
            else if (layerMatch === 'slug') counts.merge_slug++;
            byCity[cityKey].merge++;
            if (merges.length < 8) {
                merges.push({
                    scrape: `${v.name} (${v.city})`,
                    db: `${verdict.existing.name} (${verdict.existing.city})`,
                    layer: layerMatch,
                });
            }
        } else {
            counts.create++;
            byCity[cityKey].create++;
            if (creates.length < 8) {
                creates.push({ name: v.name, city: v.city, tier: v.spicchiTier, category: v.category });
            }
        }
        if ((i + 1) % 100 === 0) {
            console.log(`[preview] ${i + 1}/${venues.length}  merge=${counts.merge_googlePlaceId + counts.merge_bbox + counts.merge_slug} create=${counts.create} flagged=${counts.manual_review}`);
        }
    }
    await provider.close().catch(() => {});
    await prisma.$disconnect();

    console.log('\n=========== PREVIEW SUMMARY ===========');
    console.log(`Total candidates: ${venues.length}`);
    console.log(`MERGE into existing row (fill-only, no overwrite):`);
    console.log(`  via googlePlaceId  : ${counts.merge_googlePlaceId}`);
    console.log(`  via bbox+name (≤200m + name match): ${counts.merge_bbox}`);
    console.log(`  via slug exact     : ${counts.merge_slug}`);
    console.log(`  ── TOTAL MERGE      : ${counts.merge_googlePlaceId + counts.merge_bbox + counts.merge_slug}`);
    console.log(`CREATE new Place    : ${counts.create}`);
    console.log(`MANUAL_REVIEW (flag): ${counts.manual_review}`);
    console.log('=========================================\n');

    console.log('Sample merges (preserved existing row):');
    for (const m of merges) console.log(`  ${m.layer.padEnd(14)}  scrape="${m.scrape}"  →  db="${m.db}"`);
    console.log('\nSample creates (will be new rows):');
    for (const c of creates) console.log(`  ${c.name} (${c.city})  tier=${c.tier ?? '–'}  cat=${c.category}`);
    if (flagged.length) {
        console.log('\nSample flagged:');
        for (const f of flagged.slice(0, 5)) console.log(`  ${f.name} (${f.city}) — ${f.reasons.join(', ')}`);
    }

    console.log('\nTop 12 cities — merge vs create:');
    const cityRows = Object.entries(byCity)
        .map(([c, x]) => ({ c, ...x, tot: x.merge + x.create }))
        .sort((a, b) => b.tot - a.tot)
        .slice(0, 12);
    console.log('city                       merge  create  total');
    for (const r of cityRows) {
        console.log(`  ${r.c.padEnd(24)} ${String(r.merge).padStart(5)} ${String(r.create).padStart(6)} ${String(r.tot).padStart(6)}`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
