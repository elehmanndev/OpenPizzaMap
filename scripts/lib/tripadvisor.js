// Shared TripAdvisor Content API client. Extracted from scripts/scrapers/
// scrape-venue.js so both the venue scraper and the new TA enricher share
// the same fetch path, retry behaviour, and budget bookkeeping.
//
// Two endpoints used:
//   /location/search          — find candidate location_ids by name + city
//   /location/{id}/details    — pull rating, reviewCount, ranking, url
//
// Per TA's pricing copy (2026-05-12): "Access search APIs for no charge"
// suggests /location/search is uncounted, while the 5,000/mo free tier
// covers details/photos/reviews. We treat both as billed for budget
// purposes until the dashboard confirms — safer to over-reserve.
//
// Auth: API key is domain-restricted to www.openpizzamap.com. TA
// validates the Referer header server-side; missing the `www.` prefix
// returns 403 ("explicit deny"), confirmed by direct probe 2026-04-26.

const taBudget = require('./tripadvisor-budget');
const { normalizeName, jaroWinkler, fetchWithTimeout } = require('./utils');

const TA_BASE = 'https://api.content.tripadvisor.com/api/v1';
const NAME_MATCH_MIN = 0.7;

async function taFetch(pathname, params = {}) {
    const apiKey = process.env.TRIPADVISOR_API_KEY;
    if (!apiKey) throw new Error('TRIPADVISOR_API_KEY not set');
    // Reserve a budget slot BEFORE the network call; load() rolls month/day.
    const slot = taBudget.reserve(pathname);
    const u = new URL(TA_BASE + pathname);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', apiKey);
    const r = await fetchWithTimeout(u.toString(), {
        accept: 'application/json',
        headers: { 'Referer': 'https://www.openpizzamap.com/' },
    });
    if (!r.ok) throw new Error(`tripadvisor ${pathname} ${r.status} (budget ${slot.calls}/${taBudget.MONTHLY_HARD_CAP})`);
    return await r.json();
}

// Two-call lookup: /location/search then /location/{id}/details.
// Returns { search, details } on a confident name match, null on a miss.
// `address` is the documented param (the older scrape-venue.js used the
// undocumented `searchAddress` which TA silently ignored).
async function taLookup(name, city, country) {
    const params = {
        searchQuery: name,
        category: 'restaurants',
    };
    if (city) params.address = city;
    const j = await taFetch('/location/search', params);
    const candidates = (j && j.data) || [];
    if (!candidates.length) return null;

    const wanted = normalizeName(name);
    let best = null, bestSim = 0;
    for (const c of candidates) {
        const sim = jaroWinkler(wanted, normalizeName(c.name || ''));
        if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (!best || bestSim < NAME_MATCH_MIN) return null;

    const det = await taFetch(`/location/${best.location_id}/details`);
    return { search: best, details: det, similarity: Math.round(bestSim * 100) / 100 };
}

module.exports = { taFetch, taLookup, NAME_MATCH_MIN };
