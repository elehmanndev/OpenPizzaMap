#!/usr/bin/env node
// Import scraped pizza places from thegreat.pizza + TasteAtlas JSON dumps.
// Usage:
//   node scripts/import-places.js [--dry-run] [--limit N] [--no-geocode]
//
// Reads JSON files from repo root, normalizes, dedupes by name+city, geocodes
// missing lat/lng via Nominatim (cached to geocode-cache.json), and upserts
// City + Place + PlaceSource rows. All places land with isVisible=false.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'geocode-cache.json');
const ERRORS_FILE = path.join(ROOT, 'import-errors.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_GEOCODE = args.includes('--no-geocode');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : null;
})();

const NOMINATIM_USER_AGENT = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const NOMINATIM_DELAY_MS = 1100;

// ----- file map -----
const SOURCES = [
  { file: 'scrape-result.json',                       source: 'thegreat.pizza', style: null,                  shape: 'great' },
  { file: 'tasteatlas-pizza-napoletana.json',         source: 'tasteatlas',     style: 'neapolitan',          shape: 'tasteatlas' },
  { file: 'tasteatlas-ny-style-pizza.json',           source: 'tasteatlas',     style: 'ny',                  shape: 'tasteatlas' },
  { file: 'tasteatlas-detroit-style-pizza.json',      source: 'tasteatlas',     style: 'detroit',             shape: 'tasteatlas' },
  { file: 'tasteatlas-chicago-pizza.json',            source: 'tasteatlas',     style: 'chicago',             shape: 'tasteatlas' },
  { file: 'tasteatlas-apizza.json',                   source: 'tasteatlas',     style: 'new-haven',           shape: 'tasteatlas' },
  { file: 'tasteatlas-pizza-al-taglio.json',          source: 'tasteatlas',     style: 'al-taglio',           shape: 'tasteatlas' },
  { file: 'tasteatlas-traditional-italian-pizza.json',source: 'tasteatlas',     style: 'italian',             shape: 'tasteatlas' },
];

// ----- canonicalisation tables -----
// citySlug (thegreat.pizza) → canonical English name + ISO2
const CITY_SLUG_CANON = {
  barcelona: { name: 'Barcelona', code: 'ES' },
  bari:      { name: 'Bari',      code: 'IT' },
  bologna:   { name: 'Bologna',   code: 'IT' },
  catania:   { name: 'Catania',   code: 'IT' },
  florence:  { name: 'Florence',  code: 'IT' },
  genova:    { name: 'Genoa',     code: 'IT' },
  lecce:     { name: 'Lecce',     code: 'IT' },
  london:    { name: 'London',    code: 'GB' },
  milan:     { name: 'Milan',     code: 'IT' },
  naples:    { name: 'Naples',    code: 'IT' },
  palermo:   { name: 'Palermo',   code: 'IT' },
  paris:     { name: 'Paris',     code: 'FR' },
  rome:      { name: 'Rome',      code: 'IT' },
  torino:    { name: 'Turin',     code: 'IT' },
  verona:    { name: 'Verona',    code: 'IT' },
  vienna:    { name: 'Vienna',    code: 'AT' },
};

// city display name (any language) → canonical English
const CITY_NAME_CANON = {
  roma: 'Rome', napoli: 'Naples', firenze: 'Florence', milano: 'Milan',
  torino: 'Turin', genova: 'Genoa', wien: 'Vienna',
};

// country display name → ISO2
const COUNTRY_TO_CODE = {
  'italia': 'IT', 'italy': 'IT',
  'francia': 'FR', 'france': 'FR',
  'spagna': 'ES', 'spain': 'ES', 'españa': 'ES',
  'regno unito': 'GB', 'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB',
  'austria': 'AT',
  'germania': 'DE', 'germany': 'DE',
  'united states of america': 'US', 'united states': 'US', 'usa': 'US',
};

const CODE_TO_COUNTRY_NAME = {
  IT: 'Italy', FR: 'France', ES: 'Spain', GB: 'United Kingdom',
  AT: 'Austria', DE: 'Germany', US: 'United States',
};

// ----- helpers -----
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function dedupKey(name, city) {
  return slugify(name) + '|' + slugify(city);
}

function priceLevelFromRange(range) {
  if (!range) return 2;
  const n = (range.match(/€/g) || []).length;
  return n >= 1 ? Math.min(n, 3) : 2;
}

function canonCountryCode(rawCountry, citySlug) {
  let s = rawCountry;
  if (s && typeof s === 'object') s = s.name || '';
  s = decodeEntities(String(s || '')).trim().toLowerCase();
  if (s && COUNTRY_TO_CODE[s]) return COUNTRY_TO_CODE[s];
  if (citySlug && CITY_SLUG_CANON[citySlug]) return CITY_SLUG_CANON[citySlug].code;
  return null;
}

function canonCityName(rawCity, citySlug) {
  if (citySlug && CITY_SLUG_CANON[citySlug]) return CITY_SLUG_CANON[citySlug].name;
  const s = decodeEntities(String(rawCity || '')).trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (CITY_NAME_CANON[lower]) return CITY_NAME_CANON[lower];
  return s;
}

// ----- normalisation per source shape -----
function normalizeGreat(rec) {
  const a = rec.address || {};
  const code = canonCountryCode(a.country, rec.citySlug);
  const city = canonCityName(a.locality, rec.citySlug);
  return {
    name: decodeEntities(rec.name).trim(),
    addressLine: decodeEntities(a.street || '').trim() || null,
    city,
    region: decodeEntities(a.region || '').trim() || null,
    postalCode: decodeEntities(a.postalCode || '').trim() || null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : (typeof a.country === 'string' ? decodeEntities(a.country) : null),
    phone: decodeEntities(rec.telephone || '').trim() || null,
    priceLevel: priceLevelFromRange(rec.priceRange),
    heroImageUrl: rec.image || null,
    rank: null,
  };
}

function normalizeTasteatlas(rec) {
  const code = canonCountryCode(rec.country, null);
  const city = canonCityName(rec.city, null);
  const street = rec.address || rec.street_address || rec.street || null;
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: street ? decodeEntities(street).trim() : null,
    city,
    region: rec.region || null,
    postalCode: null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : (rec.country || null),
    phone: null,
    priceLevel: 2,
    heroImageUrl: rec.image_url || rec.image || null,
    rank: typeof rec.rank === 'number' ? rec.rank : null,
  };
}

// ----- collect + dedupe -----
function loadAll() {
  const items = []; // { norm, source, style, raw }
  for (const cfg of SOURCES) {
    const full = path.join(ROOT, cfg.file);
    if (!fs.existsSync(full)) {
      console.warn(`[skip] missing ${cfg.file}`);
      continue;
    }
    const data = JSON.parse(fs.readFileSync(full, 'utf8'));
    const arr = cfg.shape === 'great' ? data.data : data.places;
    if (!Array.isArray(arr)) {
      console.warn(`[skip] ${cfg.file} has no array of records`);
      continue;
    }
    for (const rec of arr) {
      const norm = cfg.shape === 'great' ? normalizeGreat(rec) : normalizeTasteatlas(rec);
      if (!norm.name || !norm.city || !norm.countryCode) {
        // can't dedupe / locate without these
        continue;
      }
      items.push({ norm, source: cfg.source, style: cfg.style, file: cfg.file });
    }
  }
  return items;
}

function buildDedupMap(items) {
  // key → { primary normalized record, sources: [{source, rank, style, file}] }
  const map = new Map();
  for (const it of items) {
    const k = dedupKey(it.norm.name, it.norm.city);
    if (!map.has(k)) {
      map.set(k, { primary: { ...it.norm }, sources: [], styles: new Set() });
    }
    const entry = map.get(k);
    // Prefer first-seen primary, but fill in missing fields from later sources.
    for (const f of ['addressLine', 'postalCode', 'region', 'phone', 'heroImageUrl']) {
      if (!entry.primary[f] && it.norm[f]) entry.primary[f] = it.norm[f];
    }
    entry.sources.push({ source: it.source, rank: it.norm.rank, file: it.file });
    if (it.style) entry.styles.add(it.style);
  }
  return map;
}

// ----- geocode cache -----
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function geocodeQueries(p) {
  const country = p.countryName || CODE_TO_COUNTRY_NAME[p.countryCode];
  const al = (p.addressLine || '').trim();
  const queries = [];
  if (al) {
    if (al.includes(',')) {
      // addressLine is multi-part — likely already includes city/country tokens.
      // Try it alone, then with country tacked on.
      queries.push(al);
      if (country) queries.push(`${al}, ${country}`);
      // Fall back to the first comma-segment (street + number) plus city + country.
      const head = al.split(',').slice(0, 2).join(',').trim();
      if (head && head !== al) {
        queries.push([head, p.city, country].filter(Boolean).join(', '));
      }
    } else {
      // Plain street with no city/country — append.
      queries.push([al, p.city, country].filter(Boolean).join(', '));
    }
  }
  // Final fallback: city + country (gets us at least to the right city).
  queries.push([p.city, country].filter(Boolean).join(', '));
  return [...new Set(queries.filter(Boolean))];
}

async function nominatimLookup(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const r = arr[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name, class: r.class, type: r.type };
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ----- main -----
async function main() {
  const prisma = new PrismaClient();
  console.log(`[mode] dry-run=${DRY_RUN} no-geocode=${NO_GEOCODE} limit=${LIMIT ?? 'none'}`);

  const items = loadAll();
  const dedup = buildDedupMap(items);
  console.log(`[load] ${items.length} raw records → ${dedup.size} unique places`);

  const cache = loadCache();
  const errors = [];
  let entries = [...dedup.entries()];
  if (LIMIT) entries = entries.slice(0, LIMIT);

  // --- geocode pass ---
  let geocoded = 0, fromCache = 0, missed = 0;
  for (const [key, entry] of entries) {
    const p = entry.primary;
    if (p.lat && p.lng) continue;
    const queries = geocodeQueries(p);
    if (!queries.length) { missed++; errors.push({ key, reason: 'empty-query', primary: p }); continue; }
    let hit = null;
    let usedQuery = null;
    let cacheUsed = false;
    const triedQueries = [];
    for (const q of queries) {
      triedQueries.push(q);
      if (q in cache) {
        const c = cache[q];
        if (c && c.lat != null && c.lng != null) { hit = c; usedQuery = q; cacheUsed = true; break; }
        continue; // cached null — try next strategy
      }
      if (NO_GEOCODE) continue;
      try {
        const r = await nominatimLookup(q);
        cache[q] = r ? { lat: r.lat, lng: r.lng, display: r.display } : null;
        saveCache(cache);
        if (r) { hit = r; usedQuery = q; break; }
      } catch (e) {
        errors.push({ key, reason: 'fetch-failed', query: q, error: String(e.message || e) });
      }
      await sleep(NOMINATIM_DELAY_MS);
    }
    if (hit) {
      p.lat = hit.lat; p.lng = hit.lng;
      if (cacheUsed) fromCache++; else geocoded++;
    } else {
      missed++;
      errors.push({ key, reason: 'no-result', tried: triedQueries, primary: p });
    }
  }
  console.log(`[geocode] hit=${geocoded} cache=${fromCache} miss=${missed}`);

  if (errors.length) {
    fs.writeFileSync(ERRORS_FILE, JSON.stringify(errors, null, 2));
    console.log(`[errors] ${errors.length} written to import-errors.json`);
  }

  if (DRY_RUN) {
    const sample = entries.slice(0, 3).map(([k, e]) => ({
      key: k,
      primary: e.primary,
      sources: e.sources,
      styles: [...e.styles],
    }));
    console.log('[dry-run] sample:', JSON.stringify(sample, null, 2));
    await prisma.$disconnect();
    return;
  }

  // --- write pass ---
  let citiesUpserted = 0, placesUpserted = 0, sourcesUpserted = 0;
  const usedSlugs = new Set();

  for (const [key, entry] of entries) {
    const p = entry.primary;
    if (p.lat == null || p.lng == null) continue; // skip un-geocoded

    // City upsert
    const citySlug = slugify(p.city);
    let cityRow = await prisma.city.findUnique({
      where: { countryCode_slug: { countryCode: p.countryCode, slug: citySlug } },
    });
    if (!cityRow) {
      cityRow = await prisma.city.create({
        data: { name: p.city, slug: citySlug, countryCode: p.countryCode, isVisible: false },
      });
      citiesUpserted++;
    }

    // Slug = name-city. Stable across runs so re-runs are idempotent.
    // Collisions only happen for two genuinely different pizzerias with the same
    // name in the same city — rare. If hit within a single run, suffix; otherwise
    // an existing DB row with the same slug IS the same place (upsert no-ops).
    const baseSlug = slugify(`${p.name}-${p.city}`);
    let placeSlug = baseSlug;
    let n = 1;
    while (usedSlugs.has(placeSlug)) {
      n++;
      placeSlug = `${baseSlug}-${n}`;
      if (n > 50) break;
    }
    usedSlugs.add(placeSlug);

    const styles = [...entry.styles];

    const place = await prisma.place.upsert({
      where: { slug: placeSlug },
      update: {}, // never overwrite on re-run; PlaceSource is the merge surface
      create: {
        name: p.name,
        addressLine: p.addressLine || '',
        city: p.city,
        region: p.region,
        postalCode: p.postalCode,
        country: p.countryName || CODE_TO_COUNTRY_NAME[p.countryCode] || p.countryCode,
        lat: p.lat,
        lng: p.lng,
        priceLevel: p.priceLevel,
        stylesJson: JSON.stringify(styles),
        phone: p.phone,
        heroImageUrl: p.heroImageUrl,
        slug: placeSlug,
        cityId: cityRow.id,
        status: 'active',
        isVisible: false,
      },
    });
    placesUpserted++;

    for (const s of entry.sources) {
      await prisma.placeSource.upsert({
        where: { placeId_source: { placeId: place.id, source: s.source } },
        update: { rank: s.rank },
        create: { placeId: place.id, source: s.source, rank: s.rank },
      });
      sourcesUpserted++;
    }
  }

  console.log(`[write] cities=${citiesUpserted} places=${placesUpserted} sources=${sourcesUpserted}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
