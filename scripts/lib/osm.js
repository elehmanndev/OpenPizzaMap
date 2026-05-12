// Shared OpenStreetMap / Overpass API client. Used by:
//   - scripts/enrichment/enrich-osm.js (metadata fill for existing places)
//   - scripts/scrapers/scrape-osm-pizzerias.js (bulk discovery, PR 2)
//
// All consumers share the same on-disk cache so a row looked up by one
// script doesn't re-hit Overpass. Cache key is `${name}|${city}` to
// match the gmaps cache pattern.
//
// Etiquette:
//   - Identifying User-Agent (Overpass operators look at this)
//   - Polite delay (1 query/sec) between calls
//   - Exponential backoff on 429 (rate-limited) and 503 (overloaded)
//   - On-disk cache — re-running on the same data hits cache, not the network

const path = require('path');
const fs = require('fs');
const { jaroWinkler, normalizeName, haversineM } = require('./utils');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_PATH = path.join(ROOT, 'data', 'cache', 'osm-resolve-cache.json');
fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });

const USER_AGENT = 'OpenPizzaMap-osm/0.1 (eric@openpizzamap.com)';
// Public mirrors. Primary fails over to alternates on 5xx.
const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
];
const DEFAULT_RADIUS_M = 200;
// Name-similarity threshold below which we treat the candidate as not a
// match. Same threshold as the dedup-merge gate so the bar to "this is
// the same venue" stays consistent across the codebase.
const NAME_MATCH_MIN = 0.7;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// One Overpass round-trip with retries + endpoint failover.
// Resolves to parsed JSON `{ elements: [...] }` or throws after exhausting both
// endpoints + ~30s of retry budget. Honours 429/503 with exponential backoff.
async function overpassQuery(ql) {
    let lastErr = null;
    for (const endpoint of OVERPASS_ENDPOINTS) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const delayMs = attempt === 0 ? 0 : 2000 * Math.pow(2, attempt - 1);
            if (delayMs) await sleep(delayMs);
            try {
                const ctrl = new AbortController();
                const t = setTimeout(() => ctrl.abort(), 30000);
                let r;
                try {
                    r = await fetch(endpoint, {
                        method: 'POST',
                        body: 'data=' + encodeURIComponent(ql),
                        headers: {
                            'User-Agent': USER_AGENT,
                            'Content-Type': 'application/x-www-form-urlencoded',
                            'Accept': 'application/json',
                        },
                        signal: ctrl.signal,
                    });
                } finally { clearTimeout(t); }
                if (r.status === 429 || r.status === 503) {
                    lastErr = new Error(`overpass ${r.status} on ${endpoint}`);
                    continue; // retry with backoff
                }
                if (!r.ok) throw new Error(`overpass ${r.status} on ${endpoint}`);
                return await r.json();
            } catch (e) {
                lastErr = e;
                // Don't retry on hard errors that aren't transient.
                if (e.name === 'AbortError' || /ENOTFOUND|ECONNREFUSED/.test(e.message)) break;
            }
        }
    }
    throw lastErr || new Error('overpass: all endpoints exhausted');
}

// Lookup a pizza venue near (lat, lng) by name. Returns:
//   { osmType, osmId, name, lat, lng, phone, websiteUrl, openingHours,
//     address, similarity }
// on a confident match, or null on a miss. Throws on Overpass-level errors
// so the caller can decide whether to cache the failure or retry.
//
// Search: within `radiusM` of (lat, lng), any of:
//   - amenity=restaurant + cuisine matching /pizza/
//   - amenity=fast_food + cuisine matching /pizza/
// then pick the highest name-similarity match >= NAME_MATCH_MIN.
async function lookup(name, lat, lng, opts = {}) {
    const radiusM = opts.radiusM || DEFAULT_RADIUS_M;
    if (lat == null || lng == null) return null;

    const ql = `[out:json][timeout:25];
(
  nwr["amenity"="restaurant"]["cuisine"~"pizza",i](around:${radiusM},${lat},${lng});
  nwr["amenity"="fast_food"]["cuisine"~"pizza",i](around:${radiusM},${lat},${lng});
);
out center tags 30;`;

    const res = await overpassQuery(ql);
    const elements = (res && res.elements) || [];
    if (!elements.length) return null;

    const wanted = normalizeName(name);
    let best = null, bestSim = 0;
    for (const el of elements) {
        const tags = el.tags || {};
        const elName = tags.name || tags['name:en'] || tags['name:it'] || tags['name:es'] || '';
        if (!elName) continue;
        const sim = jaroWinkler(wanted, normalizeName(elName));
        if (sim > bestSim) { bestSim = sim; best = el; }
    }
    if (!best || bestSim < NAME_MATCH_MIN) return null;

    const t = best.tags || {};
    // Nodes have lat/lon directly; ways/relations use the `center` we asked for.
    const elLat = best.lat != null ? best.lat : (best.center && best.center.lat);
    const elLng = best.lon != null ? best.lon : (best.center && best.center.lon);

    return {
        osmType: best.type,            // 'node' | 'way' | 'relation'
        osmId: best.id,
        name: t.name || null,
        lat: elLat,
        lng: elLng,
        phone: t.phone || t['contact:phone'] || null,
        websiteUrl: t.website || t['contact:website'] || null,
        openingHours: t.opening_hours || null,
        address: assembleAddress(t),
        distanceM: elLat != null && elLng != null ? Math.round(haversineM(lat, lng, elLat, elLng)) : null,
        similarity: Math.round(bestSim * 100) / 100,
    };
}

// Build a one-line street address from OSM tags. OSM stores address parts in
// addr:* tags rather than a single string — we assemble them in the order
// most consumers expect ("Via Roma 12, 80132 Napoli").
function assembleAddress(tags) {
    const street = tags['addr:street'];
    const num = tags['addr:housenumber'];
    const postcode = tags['addr:postcode'];
    const city = tags['addr:city'] || tags['addr:town'] || tags['addr:village'];
    const left = [street, num].filter(Boolean).join(' ');
    const right = [postcode, city].filter(Boolean).join(' ');
    const out = [left, right].filter(Boolean).join(', ');
    return out || null;
}

module.exports = {
    lookup,
    overpassQuery,
    loadCache,
    saveCache,
    USER_AGENT,
    NAME_MATCH_MIN,
};
