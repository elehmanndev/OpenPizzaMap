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
const { decodeEntities } = require('./lib/utils');
const { boundingBox, haversineKm } = require('../src/services/geo');

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
  { file: 'michelin-scrape.json',                     source: 'michelin',       style: null,                  shape: 'michelin' },
  { file: 'lamejorpizza-scrape.json',                 source: 'lamejorpizza',   style: 'neapolitan',          shape: 'lamejorpizza' },
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

// ----- helpers (decodeEntities lives in lib/utils.js so the enricher can share it) -----

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

// Strip prefixes that import sources flip-flop on. Slug-based dedup misses
// pairs like "Pizzeria Starita a Materdei" / "Starita a Materdei" because
// the slug differs by one token. Normalising both sides catches those at
// import time before they create a duplicate row. Loop until no further
// prefix is removed so a row like "10 Antica Pizzeria Ciro" collapses to
// "ciro" cleanly. Suffix words (`bistrot`, `restaurant`) are NOT stripped
// — those frequently distinguish a venue's standalone bar from its main
// pizzeria at the same address (see Pass B of the dedup audit).
const NAME_PREFIX_RE = /^(pizzeria|pizzaria|antica|the|le|la|il|el|los|las|\d+\s+|–|—|-)\s*/i;
function normalizeName(name) {
  let s = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Loop because the same row can have stacked prefixes ("10 Pizzeria Diego").
  for (let i = 0; i < 5; i++) {
    const next = s.replace(NAME_PREFIX_RE, '').trim();
    if (next === s) break;
    s = next;
  }
  return s;
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

// La Mejor Pizza (Spain championship 2025). The scraper writes one record
// per venue with quality_pass already evaluated against an award list +
// Google rating threshold. We honour that gate here by returning null for
// quality_pass !== true so the dispatch loop skips them. Address parts come
// out of the Spanish-format detail page and cover street + postal + region
// (autonomous community) in addition to city; lat/lng are read directly from
// the page's `mapInitPosition` JS literal so no geocoder call is needed.
function normalizeLamejorpizza(rec) {
  if (rec.quality_pass !== true) return null;
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: rec.street || null,
    city: rec.city || null,
    region: rec.community || null,
    postalCode: rec.postalCode || null,
    countryCode: 'ES',
    countryName: 'Spain',
    phone: rec.phone || null,
    websiteUrl: null,
    priceLevel: 2,
    heroImageUrl: rec.heroImageUrl || null,
    rank: null,
    lat: typeof rec.lat === 'number' ? rec.lat : null,
    lng: typeof rec.lng === 'number' ? rec.lng : null,
  };
}

// Michelin scraper output. Cards have lat/lng + country (ISO2) inline.
// Distinction values: '' / 'bib' / '1 star' / '2 stars' / '3 stars'. We encode
// these into PlaceSource.rank so the surface Place row stays clean and the
// distinction is queryable later for badges:
//   bib = 1, 1 star = 2, 2 stars = 3, 3 stars = 4, '' = null.
function michelinDistinctionToRank(d) {
  if (!d) return null;
  const s = String(d).toLowerCase().trim();
  if (s === 'bib') return 1;
  if (/^1\s*star/.test(s)) return 2;
  if (/^2\s*star/.test(s)) return 3;
  if (/^3\s*star/.test(s)) return 4;
  return null;
}

function normalizeMichelin(rec) {
  const det = rec.detail || {};
  const code = (rec.country || '').toUpperCase() || null;
  return {
    name: decodeEntities(rec.name || '').trim(),
    addressLine: det.addressLine ? decodeEntities(det.addressLine).trim() : null,
    city: rec.city ? decodeEntities(rec.city).trim() : null,
    region: rec.region || null,
    postalCode: det.postalCode || null,
    countryCode: code,
    countryName: code ? CODE_TO_COUNTRY_NAME[code] : null,
    phone: det.phone || null,
    websiteUrl: det.website || null,
    priceLevel: typeof rec.priceLevel === 'number' ? rec.priceLevel : 2,
    heroImageUrl: det.heroImageUrl || null,
    rank: michelinDistinctionToRank(rec.distinction),
    lat: typeof rec.lat === 'number' ? rec.lat : null,
    lng: typeof rec.lng === 'number' ? rec.lng : null,
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
      else if (cfg.shape === 'michelin') norm = normalizeMichelin(rec);
      else if (cfg.shape === 'lamejorpizza') norm = normalizeLamejorpizza(rec);
      else norm = normalizeTasteatlas(rec);
      // normalizeLamejorpizza returns null for rows that didn't pass the
      // scraper-side quality gate — silently skip them here.
      if (!norm || !norm.name || !norm.city || !norm.countryCode) {
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

async function nominatimLookup(query, attempt = 1) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  // 10-second hard timeout per request — without this, a stuck Nominatim
  // response hangs the entire import (the previous run sat dead for 11 min
  // before being killed because there was no AbortController).
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': NOMINATIM_USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    // 429 = soft ban from Nominatim's public server (1 req/sec policy). Back off
    // hard — they typically clear in 30-60s once you stop. Up to 4 attempts with
    // 15s × attempt of cooldown buys ~1.5 min before giving up on a single query.
    if (res.status === 429) {
      if (attempt < 4) {
        await new Promise(r => setTimeout(r, 15000 * attempt));
        return nominatimLookup(query, attempt + 1);
      }
      throw new Error(`nominatim 429`);
    }
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const r = arr[0];
    return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name, class: r.class, type: r.type };
  } catch (e) {
    const msg = String(e && e.name === 'AbortError' ? 'timeout' : (e && e.message) || e);
    if (attempt < 3 && /timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)) {
      // Brief backoff before retrying — total of up to 3 attempts per query.
      await new Promise(r => setTimeout(r, 1500 * attempt));
      return nominatimLookup(query, attempt + 1);
    }
    throw new Error(`nominatim: ${msg}`);
  } finally {
    clearTimeout(timer);
  }
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
  // Progress log every Nth processed entry so a stall is diagnosable. Prints
  // the in-flight query before the network call so you can see exactly which
  // address is hanging if Nominatim wedges.
  let geocoded = 0, fromCache = 0, missed = 0, alreadyHad = 0, processed = 0;
  const needsGeocode = entries.filter(([, e]) => !(e.primary.lat && e.primary.lng)).length;
  console.log(`[geocode] ${needsGeocode}/${entries.length} entries need geocoding`);
  for (const [key, entry] of entries) {
    processed++;
    const p = entry.primary;
    if (p.lat && p.lng) { alreadyHad++; continue; }
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
      process.stdout.write(`[geocode ${processed}/${entries.length}] → ${q.slice(0, 80)}\n`);
      try {
        const r = await nominatimLookup(q);
        cache[q] = r ? { lat: r.lat, lng: r.lng, display: r.display } : null;
        saveCache(cache);
        if (r) { hit = r; usedQuery = q; break; }
      } catch (e) {
        console.warn(`[geocode ${processed}/${entries.length}] error: ${String(e.message || e)}`);
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
    if (processed % 25 === 0) {
      console.log(`[geocode progress] ${processed}/${entries.length} — net=${geocoded} cache=${fromCache} miss=${missed} skipped=${alreadyHad}`);
    }
  }
  console.log(`[geocode] hit=${geocoded} cache=${fromCache} miss=${missed} alreadyHadCoords=${alreadyHad}`);

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
  // Merge policy: fill-only-if-null. New sources can ADD missing fields
  // (image, website, phone, address, postal, region) on existing rows but
  // never overwrite values that are already populated. This preserves the
  // first source's data + any later human edits, while letting later
  // higher-quality sources (e.g. 50TP filling a phone AVPN didn't have)
  // enrich the row. Coords are deliberately NOT overwritten — once geocoded,
  // a row's lat/lng stay put. Styles merge as a union via stylesJson.
  let citiesUpserted = 0, placesCreated = 0, placesEnriched = 0, placesUntouched = 0, sourcesUpserted = 0;
  const usedSlugs = new Set();

  // Treat empty string as "missing" — older rows landed addressLine='' rather
  // than null because of `addressLine: p.addressLine || ''` in the create path.
  const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');

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
    // an existing DB row with the same slug IS the same place (we enrich it).
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

    // Dedup fallback: normalise the candidate name and search for an
    // existing row in the same country within a 200 m bbox whose
    // normalised name matches. Catches the slug-miss class (e.g.
    // "Pizzeria Starita a Materdei" already in DB, incoming
    // "Starita a Materdei" — different slug, same place). 200 m is
    // generous enough to absorb the geocoder drift we saw between
    // 50TP and AVPN imports without tripping on neighbouring shops.
    const candidateCountry = p.countryName || CODE_TO_COUNTRY_NAME[p.countryCode] || p.countryCode;
    let existing = null;
    if (p.lat != null && p.lng != null && candidateCountry) {
      const candidateNorm = normalizeName(p.name);
      if (candidateNorm) {
        const box = boundingBox(Number(p.lat), Number(p.lng), 0.2);
        const nearby = await prisma.place.findMany({
          where: {
            country: candidateCountry,
            lat: { gte: box.minLat, lte: box.maxLat },
            lng: { gte: box.minLng, lte: box.maxLng },
          },
          select: { id: true, name: true, slug: true, lat: true, lng: true },
        });
        for (const row of nearby) {
          if (normalizeName(row.name) !== candidateNorm) continue;
          if (haversineKm(Number(row.lat), Number(row.lng), Number(p.lat), Number(p.lng)) > 0.2) continue;
          // Fetch the full row so the enrichment branch sees every field.
          existing = await prisma.place.findUnique({ where: { id: row.id } });
          break;
        }
      }
    }
    // Fall through to the slug-based lookup if the normalised match missed.
    if (!existing) existing = await prisma.place.findUnique({ where: { slug: placeSlug } });

    let place;
    if (!existing) {
      place = await prisma.place.create({
        data: {
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
      placesCreated++;
    } else {
      // Build a fill-only patch — never overwrite a populated field.
      const patch = {};
      const candidate = {
        addressLine: p.addressLine,
        region: p.region,
        postalCode: p.postalCode,
        phone: p.phone,
        websiteUrl: p.websiteUrl || null,
        heroImageUrl: p.heroImageUrl,
      };
      for (const [field, nextVal] of Object.entries(candidate)) {
        if (isEmpty(existing[field]) && !isEmpty(nextVal)) patch[field] = nextVal;
      }
      // Merge styles as a union of existing JSON + new.
      if (styles.length) {
        let prev = [];
        try { prev = JSON.parse(existing.stylesJson || '[]') || []; } catch {}
        const merged = [...new Set([...prev, ...styles])];
        if (merged.length !== prev.length) patch.stylesJson = JSON.stringify(merged);
      }
      // If existing row's image is an external URL we already self-hosted into
      // /uploads/ for, don't replace with another external URL — keep the local.
      if (typeof existing.heroImageUrl === 'string' && existing.heroImageUrl.startsWith('/uploads/')) {
        delete patch.heroImageUrl;
      }
      if (Object.keys(patch).length) {
        place = await prisma.place.update({ where: { id: existing.id }, data: patch });
        placesEnriched++;
      } else {
        place = existing;
        placesUntouched++;
      }
    }

    for (const s of entry.sources) {
      await prisma.placeSource.upsert({
        where: { placeId_source: { placeId: place.id, source: s.source } },
        update: { rank: s.rank },
        create: { placeId: place.id, source: s.source, rank: s.rank },
      });
      sourcesUpserted++;
    }
  }

  console.log(`[write] cities=${citiesUpserted} created=${placesCreated} enriched=${placesEnriched} untouched=${placesUntouched} sources=${sourcesUpserted}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
