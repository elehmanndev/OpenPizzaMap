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
  { file: 'avpn-scrape.json',                         source: 'avpn',           style: 'neapolitan',          shape: 'avpn' },
  { file: 'eater-scrape.json',                        source: 'eater',          style: null,                  shape: 'eater' },
  { file: '50toppizza-scrape.json',                   source: '50toppizza',     style: null,                  shape: '50tp' },
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
  bruxelles: 'Brussels', anversa: 'Antwerp', monaco: 'Munich',
  copenaghen: 'Copenhagen', mosca: 'Moscow', praga: 'Prague',
  varsavia: 'Warsaw', stoccolma: 'Stockholm', zurigo: 'Zurich',
  ginevra: 'Geneva', lione: 'Lyon', nizza: 'Nice', marsiglia: 'Marseille',
  siviglia: 'Seville', valencia: 'Valencia', citta: 'City',
  'new york': 'New York', 'new york city': 'New York',
  'sao paulo': 'São Paulo', 'são paulo': 'São Paulo',
  'rio de janeiro': 'Rio de Janeiro',
  buenos: 'Buenos Aires', 'buenos aires': 'Buenos Aires',
  cdmx: 'Mexico City', 'ciudad de mexico': 'Mexico City', 'ciudad de méxico': 'Mexico City',
  pechino: 'Beijing', tokio: 'Tokyo',
};

// country display name → ISO2.
// AVPN listings use Italian country names (Italia, Stati Uniti d'America, Giappone…),
// so this table needs both English and Italian forms for global coverage.
const COUNTRY_TO_CODE = {
  // Europe
  'italia': 'IT', 'italy': 'IT',
  'francia': 'FR', 'france': 'FR',
  'spagna': 'ES', 'spain': 'ES', 'españa': 'ES',
  'regno unito': 'GB', 'united kingdom': 'GB', 'uk': 'GB', 'great britain': 'GB', 'inghilterra': 'GB', 'england': 'GB', 'scozia': 'GB', 'scotland': 'GB',
  'irlanda': 'IE', 'ireland': 'IE',
  'austria': 'AT', 'österreich': 'AT',
  'germania': 'DE', 'germany': 'DE', 'deutschland': 'DE',
  'svizzera': 'CH', 'switzerland': 'CH',
  'belgio': 'BE', 'belgium': 'BE',
  'paesi bassi': 'NL', 'olanda': 'NL', 'netherlands': 'NL', 'holland': 'NL',
  'lussemburgo': 'LU', 'luxembourg': 'LU',
  'portogallo': 'PT', 'portugal': 'PT',
  'grecia': 'GR', 'greece': 'GR',
  'svezia': 'SE', 'sweden': 'SE',
  'norvegia': 'NO', 'norway': 'NO',
  'danimarca': 'DK', 'denmark': 'DK',
  'finlandia': 'FI', 'finland': 'FI',
  'islanda': 'IS', 'iceland': 'IS',
  'polonia': 'PL', 'poland': 'PL',
  'repubblica ceca': 'CZ', 'czechia': 'CZ', 'czech republic': 'CZ',
  'slovacchia': 'SK', 'slovakia': 'SK',
  'ungheria': 'HU', 'hungary': 'HU',
  'romania': 'RO',
  'bulgaria': 'BG',
  'croazia': 'HR', 'croatia': 'HR',
  'slovenia': 'SI',
  'serbia': 'RS',
  'malta': 'MT',
  'cipro': 'CY', 'cyprus': 'CY',
  'estonia': 'EE',
  'lettonia': 'LV', 'latvia': 'LV',
  'lituania': 'LT', 'lithuania': 'LT',
  'russia': 'RU', 'russian federation': 'RU',
  'ucraina': 'UA', 'ukraine': 'UA',
  'turchia': 'TR', 'turkey': 'TR', 'türkiye': 'TR',
  'albania': 'AL',
  'principato di monaco': 'MC', 'monaco': 'MC',
  // Americas
  'united states of america': 'US', 'united states': 'US', 'usa': 'US', 'stati uniti': 'US', "stati uniti d'america": 'US', "stati uniti d&#39;america": 'US',
  'canada': 'CA',
  'messico': 'MX', 'mexico': 'MX', 'méxico': 'MX',
  'brasile': 'BR', 'brazil': 'BR', 'brasil': 'BR',
  'argentina': 'AR',
  'cile': 'CL', 'chile': 'CL',
  'uruguay': 'UY',
  'colombia': 'CO',
  'peru': 'PE', 'perù': 'PE',
  'venezuela': 'VE',
  'panama': 'PA', 'panamá': 'PA',
  'costa rica': 'CR',
  'ecuador': 'EC',
  'porto rico': 'PR', 'puerto rico': 'PR',
  'repubblica dominicana': 'DO', 'dominican republic': 'DO',
  // Asia / Oceania / Africa / Middle East
  'giappone': 'JP', 'japan': 'JP',
  'cina': 'CN', 'china': 'CN',
  'corea del sud': 'KR', 'south korea': 'KR', 'korea': 'KR',
  'thailandia': 'TH', 'thailand': 'TH',
  'singapore': 'SG',
  'malaysia': 'MY', 'malesia': 'MY',
  'indonesia': 'ID',
  'filippine': 'PH', 'philippines': 'PH',
  'vietnam': 'VN',
  'india': 'IN',
  'taiwan': 'TW',
  'hong kong': 'HK',
  'australia': 'AU',
  'nuova zelanda': 'NZ', 'new zealand': 'NZ',
  'emirati arabi uniti': 'AE', 'united arab emirates': 'AE', 'uae': 'AE',
  'qatar': 'QA',
  'arabia saudita': 'SA', 'saudi arabia': 'SA',
  'kuwait': 'KW',
  'bahrein': 'BH', 'bahrain': 'BH',
  'oman': 'OM',
  'libano': 'LB', 'lebanon': 'LB',
  'israele': 'IL', 'israel': 'IL',
  'giordania': 'JO', 'jordan': 'JO',
  'egitto': 'EG', 'egypt': 'EG',
  'marocco': 'MA', 'morocco': 'MA',
  'tunisia': 'TN',
  'sud africa': 'ZA', 'south africa': 'ZA',
  'kenya': 'KE',
  // Long-tail
  'anguilla': 'AI',
  'armenia': 'AM',
  'bolivia': 'BO',
  'paraguay': 'PY',
  'macedonia': 'MK', 'repubblica di macedonia': 'MK', 'north macedonia': 'MK',
  'taiwan': 'TW',
  'corea del sud': 'KR', 'repubblica di corea': 'KR', 'repubblica di corea (corea del sud)': 'KR',
  // 50 Top Pizza Europe ranking quirks
  'england': 'GB', 'wales': 'GB', 'northern ireland': 'GB',
  'the netherlands': 'NL',
  'republic of north macedonia': 'MK',
};

const CODE_TO_COUNTRY_NAME = {
  IT: 'Italy', FR: 'France', ES: 'Spain', GB: 'United Kingdom',
  IE: 'Ireland', AT: 'Austria', DE: 'Germany', CH: 'Switzerland',
  BE: 'Belgium', NL: 'Netherlands', LU: 'Luxembourg', PT: 'Portugal',
  GR: 'Greece', SE: 'Sweden', NO: 'Norway', DK: 'Denmark', FI: 'Finland', IS: 'Iceland',
  PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  HR: 'Croatia', SI: 'Slovenia', RS: 'Serbia', MT: 'Malta', CY: 'Cyprus',
  EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', RU: 'Russia', UA: 'Ukraine',
  TR: 'Türkiye', AL: 'Albania', MC: 'Monaco',
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil',
  AR: 'Argentina', CL: 'Chile', UY: 'Uruguay', CO: 'Colombia', PE: 'Peru',
  VE: 'Venezuela', PA: 'Panama', CR: 'Costa Rica', EC: 'Ecuador',
  PR: 'Puerto Rico', DO: 'Dominican Republic',
  JP: 'Japan', CN: 'China', KR: 'South Korea', TH: 'Thailand', SG: 'Singapore',
  MY: 'Malaysia', ID: 'Indonesia', PH: 'Philippines', VN: 'Vietnam', IN: 'India',
  TW: 'Taiwan', HK: 'Hong Kong', AU: 'Australia', NZ: 'New Zealand',
  AE: 'United Arab Emirates', QA: 'Qatar', SA: 'Saudi Arabia', KW: 'Kuwait',
  BH: 'Bahrain', OM: 'Oman', LB: 'Lebanon', IL: 'Israel', JO: 'Jordan',
  EG: 'Egypt', MA: 'Morocco', TN: 'Tunisia', ZA: 'South Africa', KE: 'Kenya',
  AI: 'Anguilla', AM: 'Armenia', BO: 'Bolivia', PY: 'Paraguay', MK: 'North Macedonia',
};

// ----- helpers -----
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
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
  // Strip suffixes like "- USA", "(Olanda)", commas: "Taiwan, Repubblica di Cina" → "taiwan"
  const stripped = s.split(/\s+-\s+|,/)[0].replace(/\s*\([^)]*\)\s*/g, '').trim();
  if (stripped && COUNTRY_TO_CODE[stripped]) return COUNTRY_TO_CODE[stripped];
  if (s && COUNTRY_TO_CODE[s]) return COUNTRY_TO_CODE[s];
  // Also try the parenthetical: "Paesi Bassi (Olanda)" → "olanda"
  const paren = (s.match(/\(([^)]+)\)/) || [])[1];
  if (paren && COUNTRY_TO_CODE[paren.trim()]) return COUNTRY_TO_CODE[paren.trim()];
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

// Eater pages embed venues as JSON in __NEXT_DATA__; address is a single
// comma-joined string like "8433 S Pulaski Rd, Chicago, IL, 60652, US".
function parseEaterAddress(addr) {
  if (!addr || typeof addr !== 'string') return {};
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  // Common shape: [street, city, state, postal, country]. Country is always the last.
  // Postal may be missing for some venues; state may be a two-letter US abbr.
  if (parts.length < 2) return { street: parts[0] || null };
  const out = { street: null, city: null, region: null, postalCode: null, country: null };
  out.country = parts[parts.length - 1];
  // Walk backward looking for a postal-code-like token (2-7 digits).
  let cursor = parts.length - 2;
  if (/^\d[\d\- ]{1,7}\d$/.test(parts[cursor] || '') || /^\d{4,6}$/.test(parts[cursor] || '')) {
    out.postalCode = parts[cursor]; cursor--;
  }
  // Region is typically a 2-letter state abbreviation right before postal.
  if (cursor >= 0 && /^[A-Z]{2}$/.test(parts[cursor] || '')) {
    out.region = parts[cursor]; cursor--;
  }
  if (cursor >= 0) { out.city = parts[cursor]; cursor--; }
  if (cursor >= 0) {
    out.street = parts.slice(0, cursor + 1).join(', ');
  } else {
    out.street = parts[0];
  }
  return out;
}

function normalizeEater(rec) {
  const parsed = parseEaterAddress(rec.address);
  // Country: Eater uses two-letter codes ("US", "CA"). canonCountryCode handles
  // longer names but not bare two-letter codes — short-circuit those.
  let code = null;
  if (parsed.country && /^[A-Za-z]{2}$/.test(parsed.country)) code = parsed.country.toUpperCase();
  if (!code) code = canonCountryCode(parsed.country, null);
  if (!code) code = canonCountryCode(rec.city_hint, null); // very weak fallback
  // Default Eater pages we've configured are all US.
  if (!code) code = 'US';
  const cityName = parsed.city || rec.city_hint || null;
  // Per-record style hints from the page (e.g. "best Detroit-style pizza in Chicago" → detroit).
  const extraStyles = rec.style_hint ? [rec.style_hint] : [];
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: parsed.street || rec.address || null,
    city: cityName,
    region: parsed.region || null,
    postalCode: parsed.postalCode || null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : (parsed.country || null),
    phone: rec.phone || null,
    websiteUrl: rec.website || null,
    priceLevel: 2,
    heroImageUrl: rec.image || null,
    rank: typeof rec.rank === 'number' ? rec.rank : null,
    lat: typeof rec.lat === 'number' ? rec.lat : null,
    lng: typeof rec.lng === 'number' ? rec.lng : null,
    extraStyles,
  };
}

// 50 Top Pizza ranking pages give name + city + (region or country) + image + rank.
// Italy lists: descLine2 is the Italian region ("Campania", "Lazio"). Country = Italy.
// Europe lists: descLine2 is the country in English ("Spain", "England"). Region unknown.
function normalize50TopPizza(rec) {
  const isItaly = rec.list_scope === 'italy';
  let countryRaw;
  let region;
  if (isItaly) {
    countryRaw = rec.default_country || 'Italy';
    region = rec.descLine2 || null;
  } else {
    countryRaw = rec.descLine2 || rec.default_country || null;
    region = null;
  }
  const code = canonCountryCode(countryRaw, null);
  const city = canonCityName(rec.descLine1, null);
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: null, // unknown — geocoder will fall back to city + country
    city,
    region,
    postalCode: null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : countryRaw,
    phone: null,
    websiteUrl: null,
    priceLevel: 2,
    heroImageUrl: rec.heroImageUrl || null,
    rank: typeof rec.rank === 'number' ? rec.rank : null,
    lat: null,
    lng: null,
  };
}

function normalizeAvpn(rec) {
  // rec shape: { name, city, province, region, country, detail: { addressLine, postalCode, cityFull, countryFull, phone, website, heroImageUrl, lat, lng, ... } }
  const d = rec.detail || {};
  // Prefer the listing row's city (Italian like "Napoli") for canonical lookup.
  const code = canonCountryCode(rec.country, null) || canonCountryCode(d.countryFull, null);
  const city = canonCityName(rec.city, null) || canonCityName(d.cityFull, null);
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: d.addressLine ? decodeEntities(d.addressLine).trim() : null,
    city,
    region: rec.region || d.regionFull || null,
    postalCode: d.postalCode || null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : (rec.country || d.countryFull || null),
    phone: d.phone || null,
    websiteUrl: d.website || null,
    priceLevel: 2,
    heroImageUrl: d.heroImageUrl || null,
    rank: null,
    lat: typeof d.lat === 'number' ? d.lat : null,
    lng: typeof d.lng === 'number' ? d.lng : null,
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
      let norm;
      if (cfg.shape === 'great') norm = normalizeGreat(rec);
      else if (cfg.shape === 'avpn') norm = normalizeAvpn(rec);
      else if (cfg.shape === 'eater') norm = normalizeEater(rec);
      else if (cfg.shape === '50tp') norm = normalize50TopPizza(rec);
      else norm = normalizeTasteatlas(rec);
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
    for (const f of ['addressLine', 'postalCode', 'region', 'phone', 'heroImageUrl', 'websiteUrl', 'lat', 'lng']) {
      if (entry.primary[f] == null && it.norm[f] != null) entry.primary[f] = it.norm[f];
    }
    entry.sources.push({ source: it.source, rank: it.norm.rank, file: it.file });
    if (it.style) entry.styles.add(it.style);
    if (Array.isArray(it.norm.extraStyles)) {
      for (const s of it.norm.extraStyles) entry.styles.add(s);
    }
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
        websiteUrl: p.websiteUrl || null,
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
