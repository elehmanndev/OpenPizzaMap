#!/usr/bin/env node
// Diagnostic: for places that came back as OSM "no match" at the standard
// 200m radius, re-query at widening radii (1km → 5km → 25km) and report
// whether a high-similarity name match actually exists nearby.
//
// Hypothesis: a chunk of our OSM misses are caused by wrong place_id
// resolving to wrong lat/lng — the real venue exists on OSM but sits a
// few hundred metres to a few km away from where the DB pin is. If true,
// the same bad coords also poison every other coord-anchored enrichment
// step (reviews, photos, TA).
//
// Usage:
//   node scripts/audits/audit-osm-misses.js                  # sample 50
//   node scripts/audits/audit-osm-misses.js --sample 100
//   node scripts/audits/audit-osm-misses.js --ids=261,312,345
//   node scripts/audits/audit-osm-misses.js --include-hidden
//
// Output:
//   - stdout: human-readable summary + bucket counts
//   - data/reports/osm-miss-audit.json: full per-row results
//
// Buckets:
//   GOT-CLOSE-MATCH      sim>=0.85 found within 200m (matcher bug? cache stale?)
//   LIKELY-BAD-PLACE-ID  sim>=0.85 found 200m-5km away (probably wrong place_id)
//   WRONG-CITY           sim>=0.85 found 5km-50km away
//   WRONG-COUNTRY        sim>=0.85 found >50km away
//   GENUINELY-MISSING    no sim>=0.85 match even at 25km

const path = require('path');
const fs = require('fs');
const { prisma, PATHS } = require('../lib/bootstrap');
const osm = require('../lib/osm');
const { haversineM } = require('../lib/utils');

const OUT_FILE = path.join(PATHS.reports, 'osm-miss-audit.json');

const RADII_M = [1000, 5000, 25000];
const HIGH_SIM = 0.85;
const POLITE_DELAY_MS = 1100; // ~1 query/sec, Overpass etiquette

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { sample: 50, ids: null, includeHidden: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--sample') out.sample = parseInt(argv[++i], 10);
        else if (a.startsWith('--sample=')) out.sample = parseInt(a.split('=')[1], 10);
        else if (a === '--ids') out.ids = argv[++i].split(',').map(Number);
        else if (a.startsWith('--ids=')) out.ids = a.split('=')[1].split(',').map(Number);
        else if (a === '--include-hidden') out.includeHidden = true;
    }
    return out;
}

function bucket(matchDistM, matchSim) {
    if (matchSim == null || matchSim < HIGH_SIM) return 'GENUINELY-MISSING';
    if (matchDistM < 200)   return 'GOT-CLOSE-MATCH';
    if (matchDistM < 5000)  return 'LIKELY-BAD-PLACE-ID';
    if (matchDistM < 50000) return 'WRONG-CITY';
    return 'WRONG-COUNTRY';
}

async function probeOne(place) {
    // Widen until we find a high-sim match or exhaust the radii.
    let best = null; // { result, radiusM }
    for (const r of RADII_M) {
        let res;
        try {
            res = await osm.lookup(place.name, Number(place.lat), Number(place.lng), { radiusM: r });
        } catch (e) {
            return { error: e.message, radiusTried: r };
        }
        await sleep(POLITE_DELAY_MS);
        if (res && res.similarity >= HIGH_SIM) {
            best = { result: res, radiusM: r };
            break;
        }
        // Track best lower-confidence match too — useful when categorising the miss.
        if (res && (!best || res.similarity > (best.result?.similarity ?? 0))) {
            best = { result: res, radiusM: r };
        }
    }
    return { best };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    let where;
    if (args.ids) {
        where = { id: { in: args.ids } };
    } else {
        // OSM-miss proxy: we ran the lookup AND none of the OSM-fillable fields landed.
        where = {
            osmCheckedAt: { not: null },
            phone: null,
            websiteUrl: null,
            openingHours: null,
        };
        if (!args.includeHidden) where.isVisible = true;
    }

    const all = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, city: true, country: true,
            lat: true, lng: true, addressLine: true, osmCheckedAt: true,
        },
        orderBy: { id: 'asc' },
    });

    let pool = all;
    if (!args.ids && args.sample && all.length > args.sample) {
        // Stable-ish random sample so re-runs cluster around the same rows.
        pool = [...all].sort(() => Math.random() - 0.5).slice(0, args.sample);
    }

    console.log(`[audit-osm-misses] pool=${all.length} probing=${pool.length}`);
    console.log(`[audit-osm-misses] radii=${RADII_M.join(',')}m  highSim=${HIGH_SIM}`);
    console.log();

    const rows = [];
    const counts = {
        'GOT-CLOSE-MATCH': 0,
        'LIKELY-BAD-PLACE-ID': 0,
        'WRONG-CITY': 0,
        'WRONG-COUNTRY': 0,
        'GENUINELY-MISSING': 0,
        ERROR: 0,
    };

    for (let i = 0; i < pool.length; i++) {
        const p = pool[i];
        process.stdout.write(`[${i + 1}/${pool.length}] #${p.id} ${JSON.stringify(p.name)} (${p.city || '?'}, ${p.country || '?'}) … `);
        const probe = await probeOne(p);

        if (probe.error) {
            counts.ERROR++;
            console.log(`ERROR (radius=${probe.radiusTried}m): ${probe.error}`);
            rows.push({ id: p.id, name: p.name, city: p.city, country: p.country, error: probe.error });
            continue;
        }

        const best = probe.best;
        if (!best) {
            counts['GENUINELY-MISSING']++;
            console.log('no candidates at any radius');
            rows.push({ id: p.id, name: p.name, city: p.city, country: p.country, bucket: 'GENUINELY-MISSING' });
            continue;
        }

        const m = best.result;
        const cat = bucket(m.distanceM, m.similarity);
        counts[cat]++;
        const tag = cat === 'GENUINELY-MISSING' ? `(best sim=${m.similarity} @ ${m.distanceM}m, below ${HIGH_SIM})` : `→ ${m.name}  sim=${m.similarity}  dist=${m.distanceM}m  r=${best.radiusM}m`;
        console.log(`${cat} ${tag}`);

        rows.push({
            id: p.id,
            name: p.name,
            city: p.city,
            country: p.country,
            dbCoords: { lat: Number(p.lat), lng: Number(p.lng) },
            dbAddress: p.addressLine,
            bucket: cat,
            match: {
                name: m.name,
                lat: m.lat,
                lng: m.lng,
                distanceM: m.distanceM,
                similarity: m.similarity,
                osmType: m.osmType,
                osmId: m.osmId,
                radiusTriedM: best.radiusM,
            },
        });
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        params: { sample: args.sample, ids: args.ids, includeHidden: args.includeHidden, radii: RADII_M, highSim: HIGH_SIM },
        poolSize: all.length,
        probed: pool.length,
        counts,
        rows,
    }, null, 2));

    console.log();
    console.log('=== Summary ===');
    for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(22)} ${v}`);
    console.log();
    console.log(`Report written to ${OUT_FILE}`);
    console.log();
    console.log('Interpretation:');
    console.log('  GOT-CLOSE-MATCH      = 200m matcher *should* have caught this — likely cache or threshold issue');
    console.log('  LIKELY-BAD-PLACE-ID  = real venue exists 200m-5km away → DB coords (place_id) are wrong');
    console.log('  WRONG-CITY/COUNTRY   = data quality bug at import — coords don\'t match address');
    console.log('  GENUINELY-MISSING    = no high-sim OSM venue anywhere nearby; nothing to fix');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
