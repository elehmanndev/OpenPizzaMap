#!/usr/bin/env node
// Bulk-discover pizzerias in a country from OpenStreetMap and stage them
// for review-then-import. PR 2 of the OSM plan.
//
// Usage:
//   node scripts/scrapers/scrape-osm-pizzerias.js --country=IT
//   node scripts/scrapers/scrape-osm-pizzerias.js --country=ES --limit=500
//
// Output (no DB writes — this script ONLY stages):
//   data/scrapes/osm-{country}-new.json        — Tier 4: confidently new
//   data/scrapes/osm-{country}-conflicts.json  — Tier 3: needs review
//   data/scrapes/osm-{country}-merges.json     — Tier 1+2: auto-merge log
//
// The follow-up importer (separate script, kept out of this PR by design)
// will lift from `-new.json` into Place rows after Eric reviews.
//
// Dedup ladder (matches the agreed policy):
//   Tier 1: dedupKey(name,city) matches existing → auto-merge candidate
//   Tier 2: within 50m AND name similarity >= 0.85 → auto-merge candidate
//   Tier 3: within 200m AND similarity >= 0.7 → conflict, needs review
//   Tier 4: none of the above → confidently new

const path = require('path');
const fs = require('fs');
const { prisma, ROOT } = require('../lib/bootstrap');
const osm = require('../lib/osm');
const { normalizeName, jaroWinkler, haversineM, dedupKey, slugify, canonCity } = require('../lib/utils');

const args = process.argv.slice(2);
const COUNTRY = (() => {
    const a = args.find((x) => x.startsWith('--country='));
    return a ? a.slice(10).toUpperCase() : null;
})();
const LIMIT = (() => {
    const a = args.find((x) => x.startsWith('--limit='));
    return a ? parseInt(a.slice(8), 10) : null;
})();

if (!COUNTRY || !/^[A-Z]{2}$/.test(COUNTRY)) {
    console.error('usage: node scripts/scrapers/scrape-osm-pizzerias.js --country=IT|ES|... [--limit=N]');
    process.exit(2);
}

// Dedup thresholds, named so tuning lives in one place.
const TIER2_DIST_M = 50;
const TIER2_SIM   = 0.85;
const TIER3_DIST_M = 200;
const TIER3_SIM   = 0.70;

// Where staged JSON ends up. data/scrapes/ already exists as a path
// constant in scripts/lib/bootstrap.js — reuse so the directory layout
// stays consistent with TasteAtlas / thegreat.pizza scrapes.
const SCRAPES_DIR = path.join(ROOT, 'data', 'scrapes');
fs.mkdirSync(SCRAPES_DIR, { recursive: true });

function writeJson(file, data) {
    fs.writeFileSync(path.join(SCRAPES_DIR, file), JSON.stringify(data, null, 2));
}

// Pick the best "city" string out of OSM's address tags. OSM stores city
// under several tags depending on the place's administrative status, and
// some venues have none at all (rural pizzerias).
function osmCity(tags) {
    return tags['addr:city']
        || tags['addr:town']
        || tags['addr:village']
        || tags['addr:hamlet']
        || tags['addr:suburb']
        || null;
}

// Build the addressLine the way our DB expects ("Via Roma 12, 80132 Napoli").
function osmAddress(tags) {
    const street = tags['addr:street'];
    const num = tags['addr:housenumber'];
    const postcode = tags['addr:postcode'];
    const city = osmCity(tags);
    const left = [street, num].filter(Boolean).join(' ');
    const right = [postcode, city].filter(Boolean).join(' ');
    return [left, right].filter(Boolean).join(', ') || null;
}

// Pick a display name out of OSM's localised name tags. Prefer the local
// language, fall back to whatever's set.
function osmName(tags, country) {
    const lang = ({ IT: 'name:it', ES: 'name:es', FR: 'name:fr', DE: 'name:de', PT: 'name:pt' })[country];
    return tags.name || (lang ? tags[lang] : null) || tags['name:en'] || null;
}

// Project an OSM element to the venue shape the importer expects.
function toVenue(el, country) {
    const t = el.tags || {};
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
    return {
        osmType: el.type,
        osmId: el.id,
        name: osmName(t, country),
        lat, lng,
        addressLine: osmAddress(t),
        city: osmCity(t),
        postalCode: t['addr:postcode'] || null,
        country,
        phone: t.phone || t['contact:phone'] || null,
        websiteUrl: t.website || t['contact:website'] || null,
        openingHours: t.opening_hours || null,
        cuisine: t.cuisine || null,
        amenity: t.amenity || null,
    };
}

(async () => {
    console.log(`[osm-scrape] querying Overpass for pizzerias in ${COUNTRY}...`);
    const ql = `[out:json][timeout:240];
area["ISO3166-1"="${COUNTRY}"][admin_level=2]->.search;
(
  nwr["amenity"="restaurant"]["cuisine"~"pizza",i](area.search);
  nwr["amenity"="fast_food"]["cuisine"~"pizza",i](area.search);
);
out center tags;`;

    const t0 = Date.now();
    const res = await osm.overpassQuery(ql, { timeoutMs: 300000 });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    const elements = (res && res.elements) || [];
    console.log(`[osm-scrape] Overpass returned ${elements.length} elements in ${elapsed}s`);

    // Project + filter out venues we can't act on. A row with no name OR no
    // coords is useless to the importer; log the count but drop them.
    const venues = elements.map((e) => toVenue(e, COUNTRY)).filter((v) => v.name && v.lat != null && v.lng != null);
    const dropped = elements.length - venues.length;
    console.log(`[osm-scrape] ${venues.length} usable venues (dropped ${dropped} without name/coords)`);
    const subset = LIMIT ? venues.slice(0, LIMIT) : venues;

    // Load existing places ONCE. We compare every candidate against this
    // snapshot rather than hitting the DB per-venue.
    const existing = await prisma.place.findMany({
        where: { country: COUNTRY },
        select: { id: true, name: true, city: true, lat: true, lng: true, slug: true },
    });
    console.log(`[osm-scrape] ${existing.length} existing places in DB for ${COUNTRY}`);

    // Pre-index existing places for O(1) dedupKey lookup, and pre-normalise
    // names for the fuzzy passes so we don't recompute per candidate.
    const byKey = new Map();
    const indexed = existing.map((p) => {
        const key = dedupKey(p.name, p.city || '');
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push(p);
        return {
            ...p,
            _lat: p.lat != null ? Number(p.lat) : null,
            _lng: p.lng != null ? Number(p.lng) : null,
            _normName: normalizeName(p.name),
        };
    });

    const newRows = [];
    const conflicts = [];
    const merges = [];

    for (const v of subset) {
        const candidateKey = dedupKey(v.name, v.city || '');
        const normName = normalizeName(v.name);

        // Tier 1: exact dedupKey match.
        const keyHits = byKey.get(candidateKey) || [];
        if (keyHits.length === 1) {
            merges.push({ tier: 1, reason: 'exact-key', placeId: keyHits[0].id, place: { name: keyHits[0].name, city: keyHits[0].city }, osm: v });
            continue;
        }
        if (keyHits.length > 1) {
            conflicts.push({ tier: 1, reason: 'ambiguous-key', candidates: keyHits.map((p) => p.id), osm: v });
            continue;
        }

        // Tier 2 + 3: geo proximity. We scan everything (~thousands of rows)
        // but for a few-thousand candidate run this is fine. If it ever
        // gets slow, swap in a quadtree on lat/lng.
        let best = null, bestDist = Infinity, bestSim = 0;
        for (const p of indexed) {
            if (p._lat == null || p._lng == null) continue;
            const d = haversineM(v.lat, v.lng, p._lat, p._lng);
            if (d > TIER3_DIST_M) continue;
            const sim = jaroWinkler(normName, p._normName);
            // Prefer closer-and-similar; tiebreak by distance.
            if (sim >= TIER3_SIM && (sim > bestSim || (sim === bestSim && d < bestDist))) {
                best = p; bestDist = d; bestSim = sim;
            }
        }

        if (best && bestDist <= TIER2_DIST_M && bestSim >= TIER2_SIM) {
            merges.push({ tier: 2, reason: 'geo+name', placeId: best.id, place: { name: best.name, city: best.city }, distM: Math.round(bestDist), similarity: Math.round(bestSim * 100) / 100, osm: v });
        } else if (best) {
            conflicts.push({ tier: 3, reason: 'geo-or-name', placeId: best.id, place: { name: best.name, city: best.city }, distM: Math.round(bestDist), similarity: Math.round(bestSim * 100) / 100, osm: v });
        } else {
            newRows.push(v);
        }
    }

    writeJson(`osm-${COUNTRY}-new.json`, newRows);
    writeJson(`osm-${COUNTRY}-conflicts.json`, conflicts);
    writeJson(`osm-${COUNTRY}-merges.json`, merges);

    console.log(`\n[osm-scrape] ${COUNTRY} dedup summary:`);
    console.log(`  Tier 1+2 auto-merge candidates → ${merges.length.toString().padStart(5)}  data/scrapes/osm-${COUNTRY}-merges.json`);
    console.log(`  Tier 3 conflicts (review)      → ${conflicts.length.toString().padStart(5)}  data/scrapes/osm-${COUNTRY}-conflicts.json`);
    console.log(`  Tier 4 confidently new         → ${newRows.length.toString().padStart(5)}  data/scrapes/osm-${COUNTRY}-new.json`);
    const total = merges.length + conflicts.length + newRows.length;
    if (total !== subset.length) console.log(`  [warn] tier totals (${total}) != processed (${subset.length})`);

    await prisma.$disconnect();
})();
