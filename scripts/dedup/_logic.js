// Shared merge decision logic used by find-duplicates.js + merge-duplicates.js.
// Keeping it in one module so the dry-run report and the live executor
// CANNOT disagree about what would happen.

function isEmpty(v) {
    if (v == null) return true;
    if (typeof v === 'string' && v.trim() === '') return true;
    // -1 is a "no match found" sentinel in tripadvisorLocationId; treat as empty.
    if (typeof v === 'number' && v === -1) return true;
    return false;
}

// Compare phone numbers ignoring formatting AND country code prefixes.
// "055 936 0052" ↔ "+39 055 936 0052" → same.
function phonesEqual(a, b) {
    if (!a || !b) return false;
    const na = String(a).replace(/[^\d]/g, '');
    const nb = String(b).replace(/[^\d]/g, '');
    if (na === nb) return true;
    const tail = (s, n) => s.slice(Math.max(0, s.length - n));
    return tail(na, 8) === tail(nb, 8) && tail(na, 8).length >= 7;
}

function isInternationalPhone(p) {
    return typeof p === 'string' && p.trim().startsWith('+');
}

// Classify a Google place id by ID scheme. The Places API returns canonical
// `ChIJ…` ids; our Playwright resolver writes the FTID hex form `0x…:0x…`
// as a fallback for the SAME physical venue (see notes: ftid-placeid-format).
function gpidFormat(g) {
    if (!g) return null;
    if (/^0x[0-9a-f]+:0x[0-9a-f]+$/i.test(String(g))) return 'ftid';
    if (/^ChIJ/.test(String(g))) return 'chij';
    return 'other';
}

// Do two gpids plausibly point at the SAME place? Equal → yes. One empty →
// not a conflict. Different *formats* (FTID vs ChIJ) → yes: the pair already
// matched on name+coords, so a cross-format id pair is the same venue under
// two schemes, NOT two distinct Google entries. Same format but different
// value → a real conflict (return false → caller flags).
function gpidSamePlace(a, b) {
    if (!a || !b) return true;
    if (a === b) return true;
    const fa = gpidFormat(a), fb = gpidFormat(b);
    return !!(fa && fb && fa !== fb);
}

// Returns { keep: 'survivor'|'drop'|'merged', reason, mergedValue?, flag? }.
function decideField(field, sv, dv, survivor, drop) {
    if (isEmpty(sv) && !isEmpty(dv)) return { keep: 'drop', reason: 'survivor empty' };
    if (!isEmpty(sv) && isEmpty(dv)) return { keep: 'survivor', reason: 'drop empty' };
    if (isEmpty(sv) && isEmpty(dv)) return { keep: 'survivor', reason: 'both empty' };

    switch (field) {
        case 'name':
        case 'addressLine':
        case 'descriptionHtml':
        case 'openingHours':
        case 'seoTitle':
        case 'seoDescription':
        case 'region':
        case 'postalCode': {
            const ls = String(sv).trim().length;
            const ld = String(dv).trim().length;
            if (ld > ls) return { keep: 'drop', reason: `drop longer (${ld} > ${ls})` };
            if (ls > ld) return { keep: 'survivor', reason: `survivor longer (${ls} > ${ld})` };
            return { keep: 'survivor', reason: 'tie — survivor wins' };
        }
        case 'heroImageUrl': {
            const sIsLocal = String(sv).startsWith('/uploads/');
            const dIsLocal = String(dv).startsWith('/uploads/');
            if (sIsLocal && !dIsLocal) return { keep: 'survivor', reason: 'survivor self-hosted' };
            if (!sIsLocal && dIsLocal) return { keep: 'drop', reason: 'drop self-hosted (more durable)' };
            const sGoogle = /googleusercontent\.com\/place/.test(sv);
            const dGoogle = /googleusercontent\.com\/place/.test(dv);
            if (sGoogle && !dGoogle) return { keep: 'drop', reason: 'survivor is expiring Google URL' };
            if (!sGoogle && dGoogle) return { keep: 'survivor', reason: 'drop is expiring Google URL' };
            return { keep: 'survivor', reason: 'both equivalent — survivor wins' };
        }
        case 'phone': {
            if (phonesEqual(sv, dv)) {
                if (isInternationalPhone(dv) && !isInternationalPhone(sv)) return { keep: 'drop', reason: 'drop uses international format' };
                return { keep: 'survivor', reason: 'same number' };
            }
            // Phones differ — but if BOTH rows carry a gpid for the same place
            // (equal, or cross-format FTID↔ChIJ), it's one venue whose number
            // changed or that has a second line. Keep survivor's; don't flag.
            if (survivor.googlePlaceId && drop.googlePlaceId
                && gpidSamePlace(survivor.googlePlaceId, drop.googlePlaceId)) {
                return { keep: 'survivor', reason: 'same place (gpid) — phone differs, survivor kept' };
            }
            return { keep: 'survivor', reason: 'DIFFERENT numbers — flag', flag: true };
        }
        case 'websiteUrl': {
            const sHttps = /^https:/i.test(sv);
            const dHttps = /^https:/i.test(dv);
            if (dHttps && !sHttps) return { keep: 'drop', reason: 'drop uses https' };
            if (sHttps && !dHttps) return { keep: 'survivor', reason: 'survivor uses https' };
            return { keep: 'survivor', reason: 'equivalent — survivor wins' };
        }
        case 'googlePlaceId': {
            if (sv === dv) return { keep: 'survivor', reason: 'same gpid' };
            // Cross-format (FTID hex ↔ ChIJ) is the same venue under two id
            // schemes, not a conflict. Prefer the canonical ChIJ over the
            // Playwright FTID fallback so the survivor ends up Places-API-clean.
            const fSv = gpidFormat(sv), fDv = gpidFormat(dv);
            if (fSv && fDv && fSv !== fDv) {
                if (fDv === 'chij' && fSv !== 'chij') return { keep: 'drop', reason: 'drop is canonical ChIJ (survivor FTID)' };
                return { keep: 'survivor', reason: 'cross-format gpid — survivor canonical, kept' };
            }
            return { keep: 'survivor', reason: 'DIFFERENT gpids — flag', flag: true };
        }
        case 'lat':
        case 'lng': {
            const sGpid = !isEmpty(survivor.googlePlaceId);
            const dGpid = !isEmpty(drop.googlePlaceId);
            if (sGpid && !dGpid) return { keep: 'survivor', reason: 'survivor has gpid' };
            if (!sGpid && dGpid) return { keep: 'drop', reason: 'drop has gpid' };
            return { keep: 'survivor', reason: 'both/neither have gpid' };
        }
        case 'priceLevel': {
            if (sv === 2 && dv !== 2) return { keep: 'drop', reason: 'drop is non-default' };
            if (sv !== 2 && dv === 2) return { keep: 'survivor', reason: 'survivor is non-default' };
            return { keep: 'survivor', reason: 'tie — survivor wins' };
        }
        // Counts only grow — take MAX, not "more recent".
        case 'googleReviewCount':
        case 'tripadvisorReviewCount':
        case 'yelpReviewCount': {
            const sn = typeof sv === 'number' ? sv : Number(sv);
            const dn = typeof dv === 'number' ? dv : Number(dv);
            if (Number.isFinite(dn) && dn > (Number.isFinite(sn) ? sn : 0)) return { keep: 'drop', reason: `drop has higher count (${dn} > ${sn})` };
            return { keep: 'survivor', reason: `survivor count ≥ drop (${sn} ≥ ${dn})` };
        }
        // Ratings: prefer the side with more reviews backing it.
        case 'googleRating': {
            const s = survivor.googleReviewCount || 0;
            const d = drop.googleReviewCount || 0;
            if (d > s) return { keep: 'drop', reason: `drop has more reviews (${d} > ${s})` };
            return { keep: 'survivor', reason: `survivor has more reviews (${s} ≥ ${d})` };
        }
        case 'tripadvisorRating': {
            const s = survivor.tripadvisorReviewCount || 0;
            const d = drop.tripadvisorReviewCount || 0;
            if (d > s) return { keep: 'drop', reason: `drop has more TA reviews (${d} > ${s})` };
            return { keep: 'survivor', reason: `survivor has more TA reviews (${s} ≥ ${d})` };
        }
        case 'yelpRating': {
            const s = survivor.yelpReviewCount || 0;
            const d = drop.yelpReviewCount || 0;
            if (d > s) return { keep: 'drop', reason: `drop has more Yelp reviews (${d} > ${s})` };
            return { keep: 'survivor', reason: `survivor has more Yelp reviews (${s} ≥ ${d})` };
        }
        // External-platform URLs/IDs that both have set: KEEP SURVIVOR'S.
        // "Drop more recent" is unreliable (could be regression). Only the
        // survivor-empty → drop-wins path upgrades these.
        case 'googleUrl':
        case 'tripadvisorLocationId':
        case 'tripadvisorRanking':
        case 'tripadvisorUrl':
        case 'yelpUrl':
        case 'opmRating':
        case 'opmRatingSource':
            return { keep: 'survivor', reason: 'both set — survivor wins (no recency trust)' };
        case 'enrichmentVersion':
            return { keep: dv > sv ? 'drop' : 'survivor', reason: 'higher version wins' };
        case 'enrichedAt':
            // NEVER auto-bump from drop. A merge isn't a re-enrichment — the
            // cron uses enrichedAt to skip recently-touched rows, so lying
            // here would block legitimate re-enrichment.
            return { keep: 'survivor', reason: 'identity stable — no merge bump' };
        case 'stylesJson': {
            try {
                const sArr = JSON.parse(sv || '[]') || [];
                const dArr = JSON.parse(dv || '[]') || [];
                const merged = [...new Set([...sArr, ...dArr])];
                if (merged.length > sArr.length) return { keep: 'merged', reason: `union (${sArr.length}+${dArr.length} → ${merged.length})`, mergedValue: JSON.stringify(merged) };
                return { keep: 'survivor', reason: 'no new styles' };
            } catch { return { keep: 'survivor', reason: 'parse fail' }; }
        }
        case 'instagramUrl':
        case 'facebookUrl':
        case 'googleMapsUrl':
        case 'googlePlaceUrl':
            return { keep: 'survivor', reason: 'both set — survivor wins' };
        case 'dineIn':
        case 'takeaway':
            if (sv === true && dv === false) return { keep: 'drop', reason: 'drop edited from default' };
            if (sv === false && dv === true) return { keep: 'survivor', reason: 'survivor edited from default' };
            return { keep: 'survivor', reason: 'same' };
        case 'delivery':
        case 'reservations':
        case 'outdoorSeating':
            if (sv === false && dv === true) return { keep: 'drop', reason: 'drop has true' };
            if (sv === true && dv === false) return { keep: 'survivor', reason: 'survivor has true' };
            return { keep: 'survivor', reason: 'same' };
        default:
            return { keep: 'survivor', reason: 'default — survivor wins' };
    }
}

const MERGE_FIELDS = [
    'name', 'addressLine', 'region', 'postalCode',
    'lat', 'lng',
    'priceLevel', 'stylesJson',
    'dineIn', 'takeaway', 'delivery', 'reservations', 'outdoorSeating',
    'phone', 'websiteUrl', 'googleMapsUrl', 'instagramUrl', 'facebookUrl', 'openingHours',
    'enrichedAt', 'enrichmentVersion',
    'tripadvisorLocationId', 'tripadvisorRanking', 'tripadvisorRating', 'tripadvisorReviewCount', 'tripadvisorUrl',
    'googleRating', 'googleReviewCount', 'googleUrl',
    'yelpRating', 'yelpReviewCount', 'yelpUrl',
    'opmRating', 'opmRatingSource',
    'googlePlaceId', 'googlePlaceUrl',
    'descriptionHtml', 'heroImageUrl', 'seoTitle', 'seoDescription',
];

// Build the per-pair plan: list of field patches + flags.
function buildPlan(survivor, drop) {
    const wins = [];
    const flags = [];
    for (const f of MERGE_FIELDS) {
        const d = decideField(f, survivor[f], drop[f], survivor, drop);
        if (d.flag) flags.push({ field: f, sv: survivor[f], dv: drop[f], reason: d.reason });
        if (d.keep === 'drop') wins.push({ field: f, oldValue: survivor[f], newValue: drop[f], reason: d.reason });
        else if (d.keep === 'merged') wins.push({ field: f, oldValue: survivor[f], newValue: d.mergedValue, reason: d.reason });
    }
    return { wins, flags };
}

function haversineM(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const toRad = (x) => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
}

module.exports = {
    isEmpty, phonesEqual, isInternationalPhone,
    gpidFormat, gpidSamePlace,
    decideField, MERGE_FIELDS, buildPlan,
    haversineM,
};
