#!/usr/bin/env node
// Diagnostic: surface rows whose core identity fields (name / addressLine /
// googleMapsUrl / googlePlaceId) look broken. SQL-only — no network calls,
// runs against the whole table in seconds.
//
// Why: a wrong place_id at resolve-time poisons everything downstream
// (reviews, photos, TripAdvisor, OSM matching). When the place_id is wrong,
// the *symptoms* show up in the address (mismatched city/country),
// sometimes the name (street card text), and in galleryScrape headings.
// This audit looks for those symptoms across the whole DB so we can size
// the iceberg before deciding on a fix strategy.
//
// Usage:
//   node scripts/audits/audit-place-identity.js
//   node scripts/audits/audit-place-identity.js --include-hidden
//
// Output:
//   - stdout: bucket counts + 20-sample preview per bucket
//   - data/reports/place-identity-audit.json: full row list per bucket
//
// Buckets (a row may land in multiple):
//   EMPTY-ADDRESS         addressLine is empty / whitespace
//   NAME-IS-STREET        name looks like a street/square header (Via X, Piazza Y, ...)
//   CITY-NOT-IN-ADDRESS   addressLine has no token matching the DB city (any common variant)
//   SCRIPT-MISMATCH       address or name uses a script (CJK/Cyrillic/Arabic) that
//                         doesn't fit the country (e.g. Japanese chars in an Italy row)
//   NO-MAPS-URL           googleMapsUrl is null but googlePlaceId is set (or vice versa)
//   NO-COMMA-ADDRESS      address has no comma at all — usually truncated
//   SHORT-NAME            name length < 3 chars (likely junk from a scraper edge case)

const path = require('path');
const fs = require('fs');
const { prisma, PATHS } = require('../lib/bootstrap');

const OUT_FILE = path.join(PATHS.reports, 'place-identity-audit.json');

// City aliases — only the high-traffic Italian + Spanish + French + a few
// global ones. Long tail handled by case-insensitive substring fallback.
const CITY_ALIASES = {
    'naples': ['napoli'],
    'napoli': ['naples'],
    'florence': ['firenze'],
    'firenze': ['florence'],
    'rome': ['roma'],
    'roma': ['rome'],
    'milan': ['milano'],
    'milano': ['milan'],
    'turin': ['torino'],
    'torino': ['turin'],
    'genoa': ['genova'],
    'genova': ['genoa'],
    'venice': ['venezia'],
    'venezia': ['venice'],
    'syracuse': ['siracusa'],
    'siracusa': ['syracuse'],
    'palermo': [],
    'bologna': [],
    'seville': ['sevilla'],
    'sevilla': ['seville'],
    'lisbon': ['lisboa'],
    'lisboa': ['lisbon'],
    'munich': ['münchen', 'muenchen'],
    'münchen': ['munich', 'muenchen'],
    'cologne': ['köln', 'koeln'],
    'köln': ['cologne', 'koeln'],
    'vienna': ['wien'],
    'wien': ['vienna'],
};

// Country → expected scripts (latin-only is implicit; we only flag when a
// "definitely wrong" script appears).
const COUNTRY_NATIVE_SCRIPTS = {
    'Japan': ['cjk'],
    'China': ['cjk'],
    'Taiwan': ['cjk'],
    'Hong Kong': ['cjk'],
    'South Korea': ['hangul'],
    'Russia': ['cyrillic'],
    'Ukraine': ['cyrillic'],
    'Bulgaria': ['cyrillic'],
    'Greece': ['greek'],
    'Israel': ['hebrew'],
    'Saudi Arabia': ['arabic'],
    'UAE': ['arabic'],
    'Egypt': ['arabic'],
    'Thailand': ['thai'],
};

// Patterns indicating the name is actually a street/square header — typical
// galleryScrape "street card" symptom. Multilingual to catch Italian, Spanish,
// French, German, English layouts.
const STREET_PREFIXES = [
    /^via\b/i, /^v\.le\b/i, /^viale\b/i, /^vico(?:lo)?\b/i,
    /^p\.?za\b/i, /^piazz(?:a|ale|etta)\b/i,
    /^corso\b/i, /^largo\b/i, /^lungomare\b/i, /^lungo\b/i,
    /^calle\b/i, /^c\/\s/i, /^carrer\b/i,
    /^pla[çc]a\b/i, /^plaza\b/i, /^avenida\b/i, /^avda\.?\b/i,
    /^rue\b/i, /^avenue\b/i, /^bd\b/i, /^boulevard\b/i, /^place\b/i,
    /^stra(?:ße|sse)\b/i, /^platz\b/i,
    /^street\b/i, /^road\b/i, /^lane\b/i,
];

function hasScript(text, kind) {
    if (!text) return false;
    switch (kind) {
        case 'cjk':      return /[㐀-鿿]/.test(text);          // Han ideographs (CJK Unified)
        case 'hangul':   return /[가-힯]/.test(text);          // Korean Hangul syllables
        case 'cyrillic': return /[Ѐ-ӿ]/.test(text);
        case 'greek':    return /[Ͱ-Ͽ]/.test(text);
        case 'hebrew':   return /[֐-׿]/.test(text);
        case 'arabic':   return /[؀-ۿ]/.test(text);
        case 'thai':     return /[฀-๿]/.test(text);
        default: return false;
    }
}

function detectForeignScript(name, address, country) {
    const expected = COUNTRY_NATIVE_SCRIPTS[country] || []; // empty = latin-only expected
    const SCRIPTS = ['cjk', 'hangul', 'cyrillic', 'greek', 'hebrew', 'arabic', 'thai'];
    const text = `${name || ''} ${address || ''}`;
    for (const s of SCRIPTS) {
        if (expected.includes(s)) continue;
        if (hasScript(text, s)) return s;
    }
    return null;
}

function addressMentionsCity(addressLine, city) {
    if (!addressLine || !city) return false;
    const addr = addressLine.toLowerCase();
    const variants = new Set([city.toLowerCase(), ...(CITY_ALIASES[city.toLowerCase()] || [])]);
    for (const v of variants) {
        if (!v) continue;
        // Word-ish boundary — avoid matching "rome" inside "fromentin".
        const re = new RegExp(`(?:^|[^a-zà-ÿ])${escapeReg(v)}(?:[^a-zà-ÿ]|$)`, 'i');
        if (re.test(addr)) return true;
    }
    return false;
}

function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function nameLooksLikeStreet(name) {
    if (!name) return false;
    return STREET_PREFIXES.some((re) => re.test(name.trim()));
}

async function main() {
    const includeHidden = process.argv.includes('--include-hidden');

    const where = includeHidden ? {} : { isVisible: true };
    const places = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, addressLine: true, city: true, country: true,
            googleMapsUrl: true, googlePlaceId: true, isVisible: true,
        },
        orderBy: { id: 'asc' },
    });

    const buckets = {
        'EMPTY-ADDRESS': [],
        'NAME-IS-STREET': [],
        'CITY-NOT-IN-ADDRESS': [],
        'SCRIPT-MISMATCH': [],
        'NO-MAPS-URL': [],
        'NO-COMMA-ADDRESS': [],
        'SHORT-NAME': [],
    };

    for (const p of places) {
        const row = { id: p.id, name: p.name, city: p.city, country: p.country, addressLine: p.addressLine };
        const addr = (p.addressLine || '').trim();

        if (!addr) {
            buckets['EMPTY-ADDRESS'].push(row);
        } else {
            if (!addr.includes(',')) buckets['NO-COMMA-ADDRESS'].push(row);
            if (!addressMentionsCity(addr, p.city)) {
                buckets['CITY-NOT-IN-ADDRESS'].push(row);
            }
        }

        if (nameLooksLikeStreet(p.name)) buckets['NAME-IS-STREET'].push(row);
        if (!p.name || p.name.trim().length < 3) buckets['SHORT-NAME'].push({ ...row, name: p.name });

        const foreign = detectForeignScript(p.name, p.addressLine, p.country);
        if (foreign) buckets['SCRIPT-MISMATCH'].push({ ...row, foreignScript: foreign });

        // place_id without maps_url, or vice versa — broken pair
        if ((p.googlePlaceId && !p.googleMapsUrl) || (p.googleMapsUrl && !p.googlePlaceId)) {
            buckets['NO-MAPS-URL'].push({
                ...row,
                hasPlaceId: !!p.googlePlaceId,
                hasMapsUrl: !!p.googleMapsUrl,
            });
        }
    }

    // Cross-bucket: rows that show up in MULTIPLE buckets — these are the
    // most-likely-broken ones (multiple independent symptoms agree).
    const multiBucketIds = new Map(); // id -> Set<bucket>
    for (const [bk, rows] of Object.entries(buckets)) {
        for (const r of rows) {
            if (!multiBucketIds.has(r.id)) multiBucketIds.set(r.id, new Set());
            multiBucketIds.get(r.id).add(bk);
        }
    }
    const hotZone = [];
    for (const [id, bks] of multiBucketIds) {
        if (bks.size >= 2) hotZone.push({ id, buckets: Array.from(bks) });
    }

    fs.writeFileSync(OUT_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        totalRowsScanned: places.length,
        includeHidden,
        bucketCounts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
        hotZoneCount: hotZone.length,
        hotZone,
        buckets,
    }, null, 2));

    console.log(`[audit-place-identity] scanned ${places.length} ${includeHidden ? 'rows (incl. hidden)' : 'visible rows'}`);
    console.log();
    console.log('=== Bucket counts ===');
    for (const [k, v] of Object.entries(buckets)) {
        const pct = ((v.length / places.length) * 100).toFixed(1);
        console.log(`  ${k.padEnd(22)} ${String(v.length).padStart(5)}  (${pct}%)`);
    }
    console.log();
    console.log(`  HOT-ZONE (2+ buckets) ${String(hotZone.length).padStart(5)}  (${((hotZone.length / places.length) * 100).toFixed(1)}%)`);
    console.log();

    for (const [k, v] of Object.entries(buckets)) {
        if (!v.length) continue;
        console.log(`=== Sample: ${k} (${v.length} total, showing up to 10) ===`);
        for (const r of v.slice(0, 10)) {
            const extras = [];
            if (r.foreignScript) extras.push(`script=${r.foreignScript}`);
            if (r.hasPlaceId != null) extras.push(`placeId=${r.hasPlaceId ? 'Y' : 'N'} mapsUrl=${r.hasMapsUrl ? 'Y' : 'N'}`);
            console.log(`  #${r.id}  ${JSON.stringify(r.name)}  city=${JSON.stringify(r.city)}  country=${r.country}`);
            console.log(`         addr=${JSON.stringify(r.addressLine)}${extras.length ? '  ' + extras.join(' ') : ''}`);
        }
        console.log();
    }

    console.log(`Full report: ${OUT_FILE}`);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
