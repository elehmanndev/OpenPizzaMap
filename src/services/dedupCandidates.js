// Shared duplicate-candidate finder.
//
// The 4-pass "which Place rows look like the same venue" logic, extracted so
// the CLI audit (scripts/dedup/find-duplicates.js) and the admin merge queue
// (/admin/merge) run the SAME passes and can't drift. Pure function — caller
// supplies the already-queried rows, this returns candidate pairs. No DB or
// I/O here.
//
// A pair is a candidate if ANY pass fires (deduped across passes):
//   1. same googlePlaceId            — canonical identity (strongest)
//   2. exact normalized name + country + ≤100m
//   3. same city + ≤50m + meaningful-token overlap on names
//   4. same fully-normalized address (same city) + ≤200m
//
// "Flagged" (a pair that disagrees on phone or same-format gpid → maybe two
// REAL venues) is NOT decided here — that's _logic.buildPlan's job, run by the
// caller on the returned pairs. This module only finds the candidates.

const { normalizePlaceName } = require("./normalize-place-name");
const { haversineM } = require("../../scripts/dedup/_logic");

const COORD_MATCH_M = 100;
const TOKEN_OVERLAP_RADIUS_M = 50;
const MIN_TOKEN_LEN = 4;
const ADDRESS_MIN_LEN = 12;
const ADDRESS_PASS_MAX_M = 200;

// Generic venue/cuisine/city words that pair too many unrelated places when
// used as the only shared "meaningful" token.
const NAME_STOPWORDS = new Set([
    "pizza", "pizzeria", "pizzaria", "pizze", "pizzette",
    "restaurant", "ristorante", "trattoria", "osteria",
    "antica", "gourmet", "bistrot", "bistro", "cucina",
    "forno", "food", "kitchen", "house", "place",
    "napoli", "naples", "roma", "rome", "milano", "milan",
    "verona", "firenze", "florence", "torino", "turin",
    "napoletana", "napoletano",
]);

function meaningfulTokens(normalizedName) {
    return String(normalizedName || "").split(/\s+/)
        .filter((t) => t.length >= MIN_TOKEN_LEN && !NAME_STOPWORDS.has(t));
}

function normalizeAddress(addr) {
    if (!addr) return null;
    let s = String(addr).toLowerCase()
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    s = s.replace(/\b(italy|italia|usa|united states|spain|espana|france|francia|uk|united kingdom)\b/g, "").trim();
    s = s.replace(/\s+/g, " ");
    return s || null;
}

// places: array of rows with at least { id, name, lat, lng, country, city,
// addressLine, googlePlaceId }. Returns [{ survivor, drop, distM, why }] where
// survivor is the LOWER id (URL stability) and why names the pass that caught it.
function findCandidatePairs(places) {
    const byNameCountry = new Map();
    const byGpid = new Map();
    const byCity = new Map();
    const byAddr = new Map();

    for (const p of places) {
        if (!p.lat || !p.lng) continue;
        const normName = normalizePlaceName(p.name);

        const k2 = (p.country || "") + "|" + normName;
        if (!byNameCountry.has(k2)) byNameCountry.set(k2, []);
        byNameCountry.get(k2).push(p);

        if (p.googlePlaceId) {
            if (!byGpid.has(p.googlePlaceId)) byGpid.set(p.googlePlaceId, []);
            byGpid.get(p.googlePlaceId).push(p);
        }

        const cityKey = (p.country || "") + "|" + (p.city || "");
        if (!byCity.has(cityKey)) byCity.set(cityKey, []);
        byCity.get(cityKey).push({ p, tokens: new Set(meaningfulTokens(normName)) });

        const addr = normalizeAddress(p.addressLine);
        if (addr && addr.length >= ADDRESS_MIN_LEN) {
            const k4 = (p.city || "") + "|" + addr;
            if (!byAddr.has(k4)) byAddr.set(k4, []);
            byAddr.get(k4).push(p);
        }
    }

    const seen = new Set();
    const pairs = [];
    const addPair = (a, b, dist, why) => {
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
        const k = lo + ":" + hi;
        if (seen.has(k)) return;
        seen.add(k);
        const survivor = a.id < b.id ? a : b;
        const drop = a.id < b.id ? b : a;
        pairs.push({ survivor, drop, distM: dist, why });
    };

    // Pass 1: same gpid
    for (const arr of byGpid.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            addPair(a, b, Math.round(d), "same-gpid");
        }
    }
    // Pass 2: exact normalized name + country + ≤100m
    for (const arr of byNameCountry.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            if (d <= COORD_MATCH_M) addPair(a, b, Math.round(d), "exact-name");
        }
    }
    // Pass 3: same city + ≤50m + token overlap
    for (const arr of byCity.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.p.lat), Number(a.p.lng), Number(b.p.lat), Number(b.p.lng));
            if (d > TOKEN_OVERLAP_RADIUS_M) continue;
            let overlap = 0;
            for (const t of a.tokens) if (b.tokens.has(t)) overlap++;
            if (overlap === 0) continue;
            addPair(a.p, b.p, Math.round(d), `token-overlap(${overlap})`);
        }
    }
    // Pass 4: same fully-normalized address (same city) + ≤200m
    for (const arr of byAddr.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            if (d <= ADDRESS_PASS_MAX_M) addPair(a, b, Math.round(d), "address-match");
        }
    }

    return pairs;
}

module.exports = {
    findCandidatePairs,
    meaningfulTokens,
    normalizeAddress,
    NAME_STOPWORDS,
    COORD_MATCH_M,
    TOKEN_OVERLAP_RADIUS_M,
    ADDRESS_MIN_LEN,
    ADDRESS_PASS_MAX_M,
};
