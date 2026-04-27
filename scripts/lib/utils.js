// Shared helpers between scripts/enricher.js and scripts/scrape-venue.js
// (and any future scrapers). Extracted on 2026-04-26 — both files were inlining
// identical copies of normalizeName / jaroWinkler / haversineM / fetchWithTimeout
// / parseSchemaOrgFromHtml / inferStylesFromText / ddgSearch.
//
// New helpers added here that didn't exist in enricher.js:
//   slugify       — for Place.slug + uploads filenames
//   canonCity     — strip diacritics + lowercase + trim, for cross-locale
//                   comparisons (Sabadell vs sabadell, Napoli vs naples)
//   dedupKey      — slugify(name) + '|' + slugify(city), the importer's pair key
//
// Default User-Agent string. Override per-callsite via fetchWithTimeout's
// opts.headers — both the enricher and scrape-venue identify themselves as
// distinct tools (eric@openpizzamap.com is the policy contact for both).
const DEFAULT_UA = 'OpenPizzaMap-lib/0.1 (eric@openpizzamap.com)';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');

// HTML entity decoder — covers numeric (&#NNN;, &#xHEX;) plus the named
// entities scrapers actually pull through: smart quotes, dashes, and the
// Western-European accents that show up in pizzeria names + cities.
// Anything not in the table is left as-is.
const NAMED_ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', shy: '',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  sbquo: '‚', bdquo: '„', mdash: '—', ndash: '–',
  hellip: '…', bull: '•', middot: '·', deg: '°',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»',
  // Italian / Spanish / Portuguese / French
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë',
  igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø',
  Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø',
  ugrave: 'ù', uacute: 'ú', ucirc: 'û', uuml: 'ü',
  Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü',
  ntilde: 'ñ', Ntilde: 'Ñ',
  ccedil: 'ç', Ccedil: 'Ç',
  szlig: 'ß',
  yacute: 'ý', yuml: 'ÿ', Yacute: 'Ý',
};
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return _; } })
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(parseInt(n, 10)); } catch { return _; } })
    .replace(/&([a-zA-Z]+);/g, (m, name) => Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : m);
}

function normalizeName(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[\(\[].*?[\)\]]/g, ' ')
    .replace(/&|\+/g, ' ')
    .replace(/\bdi\s+ciro\s+salvo\b/g, ' ')
    .replace(/\b(pizzeria|ristorante|trattoria|osteria|restaurant|kitchen|cafe|bar|the|la|le|il|al|by)\b/g, ' ')
    .replace(/\b(londra|london|napoli|naples|roma|rome|milano|milan|firenze|florence|paris|parigi|new\s+york|nyc|brooklyn)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Jaro-Winkler similarity, 0..1. Cheap, well-known string distance — works well
// for short restaurant names where Levenshtein is too noisy.
function jaroWinkler(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false), bm = new Array(b.length).fill(false);
  let matches = 0, transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - range), end = Math.min(i + range + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bm[j]) continue;
      if (a[i] !== b[j]) continue;
      am[i] = bm[j] = true; matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const tr = transpositions / 2;
  const jaro = (matches / a.length + matches / b.length + (matches - tr) / matches) / 3;
  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++; else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

function haversineM(lat1, lng1, lat2, lng2) {
  const toRad = (x) => x * Math.PI / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// fetchWithTimeout: Promise<Response> that aborts after timeoutMs.
// `opts.headers` merges over our default { User-Agent, Accept }.
async function fetchWithTimeout(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: opts.method || 'GET',
      body: opts.body,
      headers: {
        'User-Agent': opts.userAgent || DEFAULT_UA,
        'Accept': opts.accept || '*/*',
        ...(opts.headers || {}),
      },
      signal: ctrl.signal,
    });
  } finally { clearTimeout(t); }
}

// slugify: lowercase, strip accents, non-alnum to dashes. Used for Place.slug
// (`name-city`) and for staging filenames. Stable across runs so re-imports
// upsert idempotently.
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// canonCity: looser comparison key (drops diacritics + lowercase). Useful when
// matching free-text city names from different sources ("Napoli" vs "naples").
function canonCity(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim();
}

function dedupKey(name, city) {
  return slugify(name) + '|' + slugify(city);
}

// Style inference from arbitrary text. Used by scraper output ("our pizza is
// neapolitan-style"), JSON-LD servesCuisine, OSM cuisine tags, page copy.
const STYLE_PATTERNS = [
  { slug: 'neapolitan', re: /\b(neapolitan|napoletan[ao]|naples[\-\s]style|stg vera pizza|verace pizza)\b/i },
  { slug: 'al-taglio',  re: /\b(al\s*taglio|by\s*the\s*slice|al-taglio|pizza\s*al\s*trancio)\b/i },
  { slug: 'ny',         re: /\b(new\s*york[\-\s]*style|ny[\-\s]*style|new\s*york\s*pizza)\b/i },
  { slug: 'detroit',    re: /\b(detroit[\-\s]*(style|square)|detroit\s*pizza)\b/i },
  { slug: 'chicago',    re: /\b(chicago(\s+deep\s+dish)?|deep[\-\s]*dish|tavern[\-\s]*style)\b/i },
  { slug: 'new-haven',  re: /\b(new[\-\s]*haven|apizza|coal[\-\s]*fired)\b/i },
  { slug: 'italian',    re: /\b(pinsa|romana|roman[\-\s]*style|pizza\s*in\s*pala)\b/i },
];

function inferStylesFromText(text) {
  const found = new Set();
  const t = String(text || '');
  if (!t) return [];
  for (const { slug, re } of STYLE_PATTERNS) if (re.test(t)) found.add(slug);
  return [...found];
}

// parseSchemaOrgFromHtml: pulls schema.org Restaurant / FoodEstablishment /
// LocalBusiness fields from any embedded <script type="application/ld+json">
// blocks. Returns the union of fields seen across all blocks.
//
// Returned shape (all optional):
//   addressLine, postalCode, region, country, lat, lng,
//   phone, website, instagramUrl, openingHours, priceRange, priceLevel,
//   heroImageUrl, description, styles[], aggregateRating, reviewCount,
//   acceptsReservations, hasMenu
function parseSchemaOrgFromHtml(html) {
  const out = {
    addressLine: null, postalCode: null, region: null, country: null,
    lat: null, lng: null,
    phone: null, website: null, instagramUrl: null,
    openingHours: null, priceRange: null, priceLevel: null,
    heroImageUrl: null, description: null,
    styles: [],
    aggregateRating: null, reviewCount: null,
    acceptsReservations: null, hasMenu: null,
  };
  const ldMatches = [...html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of ldMatches) {
    let obj;
    try { obj = JSON.parse(m[1].trim()); } catch { continue; }
    const items = Array.isArray(obj) ? obj : (obj['@graph'] || [obj]);
    for (const it of items) {
      if (!it) continue;
      const t = it['@type'];
      const isVenue = t === 'Restaurant' || t === 'FoodEstablishment' || t === 'LocalBusiness'
        || (Array.isArray(t) && t.some(x => /Restaurant|FoodEstablishment|LocalBusiness/.test(x)));
      if (!isVenue) continue;

      const a = it.address || {};
      if (!out.addressLine && a.streetAddress) out.addressLine = a.streetAddress;
      if (!out.postalCode && a.postalCode) out.postalCode = a.postalCode;
      if (!out.region && (a.addressRegion || a.addressLocality)) out.region = a.addressRegion || a.addressLocality;
      if (!out.country && a.addressCountry) out.country = typeof a.addressCountry === 'string' ? a.addressCountry : a.addressCountry.name;

      const g = it.geo || {};
      if (out.lat == null && (g.latitude != null)) out.lat = parseFloat(g.latitude);
      if (out.lng == null && (g.longitude != null)) out.lng = parseFloat(g.longitude);

      if (!out.phone && it.telephone) out.phone = String(it.telephone).trim();
      if (!out.website && it.url && /^https?:\/\//.test(it.url)) out.website = it.url;

      // Schema.org openingHours: string or array of strings, e.g. "Mo-Fr 12:00-23:00".
      if (it.openingHours) {
        const hrs = Array.isArray(it.openingHours) ? it.openingHours.join('; ') : String(it.openingHours);
        out.openingHours = out.openingHours || hrs;
      }
      // openingHoursSpecification: array of objects with dayOfWeek / opens / closes.
      if (it.openingHoursSpecification) {
        const specs = Array.isArray(it.openingHoursSpecification) ? it.openingHoursSpecification : [it.openingHoursSpecification];
        const lines = specs.map(s => {
          const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek : (s.dayOfWeek ? [s.dayOfWeek] : []);
          const dayShort = days.map(d => String(d).split('/').pop().slice(0, 2)).join(',');
          return `${dayShort} ${s.opens || '?'}-${s.closes || '?'}`;
        }).filter(Boolean);
        if (lines.length) out.openingHours = out.openingHours || lines.join('; ');
      }

      if (!out.priceRange && it.priceRange) {
        out.priceRange = it.priceRange;
        out.priceLevel = priceRangeToLevel(it.priceRange);
      }

      if (!out.heroImageUrl) {
        if (Array.isArray(it.image) && it.image.length) out.heroImageUrl = (typeof it.image[0] === 'string') ? it.image[0] : (it.image[0] && it.image[0].url) || null;
        else if (typeof it.image === 'string') out.heroImageUrl = it.image;
        else if (it.image && it.image.url) out.heroImageUrl = it.image.url;
      }

      if (!out.description && typeof it.description === 'string') out.description = it.description;

      if (typeof it.servesCuisine === 'string') out.styles.push(...inferStylesFromText(it.servesCuisine));
      else if (Array.isArray(it.servesCuisine)) out.styles.push(...inferStylesFromText(it.servesCuisine.join(' ')));

      if (it.aggregateRating) {
        const r = it.aggregateRating;
        if (out.aggregateRating == null && r.ratingValue != null) out.aggregateRating = parseFloat(r.ratingValue);
        if (out.reviewCount == null && (r.reviewCount != null || r.ratingCount != null)) out.reviewCount = parseInt(r.reviewCount ?? r.ratingCount, 10);
      }

      if (out.acceptsReservations == null && it.acceptsReservations != null) out.acceptsReservations = !!it.acceptsReservations;
      if (out.hasMenu == null && it.hasMenu) out.hasMenu = typeof it.hasMenu === 'string' ? it.hasMenu : (it.hasMenu.url || null);

      // sameAs is often where Instagram/Facebook URLs hide.
      const sameAs = it.sameAs;
      if (sameAs) {
        const arr = Array.isArray(sameAs) ? sameAs : [sameAs];
        for (const s of arr) {
          if (!out.instagramUrl && /instagram\.com\//i.test(s)) out.instagramUrl = s;
        }
      }
    }
  }
  // dedupe styles
  out.styles = [...new Set(out.styles)];
  return out;
}

// "$" → 1, "$$" → 2, "$$$" → 3, "$$$$" → 4. Also handles € equivalents.
function priceRangeToLevel(pr) {
  if (typeof pr !== 'string') return null;
  const m = pr.match(/[$€£¥]+/);
  if (!m) return null;
  return Math.min(Math.max(m[0].length, 1), 4);
}

// DuckDuckGo HTML search — the only search engine that tolerates polite scraping.
// Returns up to 8 result URLs, decoded if wrapped in DDG's redirect.
async function ddgSearch(query, opts = {}) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const r = await fetchWithTimeout(url, {
    accept: 'text/html',
    userAgent: opts.userAgent,
    headers: { 'Referer': 'https://duckduckgo.com/' },
  }, 20000);
  if (!r.ok) throw new Error(`ddg ${r.status}`);
  const html = await r.text();
  const links = [...html.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"/g)].map(m => m[1]);
  return links.slice(0, 8).map(decodeDdgLink).filter(Boolean);
}

function decodeDdgLink(href) {
  try {
    if (href.startsWith('//duckduckgo.com/l/')) {
      const u = new URL('https:' + href);
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
    if (href.startsWith('https://duckduckgo.com/l/')) {
      const u = new URL(href);
      const real = u.searchParams.get('uddg');
      if (real) return decodeURIComponent(real);
    }
    return href;
  } catch { return null; }
}

// Aggregator domains we don't treat as the venue's own website. scrape-venue
// uses these as JSON-LD sources but never adopts as Place.websiteUrl.
const AGGREGATOR_HOSTS = /(facebook|instagram|tripadvisor|yelp|opentable|thefork|google|maps|youtube|wikipedia|wikidata|tiktok|twitter|x\.com|reddit|theinfatuation|eater|michelin|guide\.michelin|tasteatlas|50toppizza|pizzanapoletana|theguardian|nytimes|timeout|condenast|restaurantguru|carta\.menu|paginasamarillas|glovoapp|justeat|deliveroo|ubereats|covermanager|resy|sevenrooms)/i;

// True if the URL plausibly points at the venue's own website (not an aggregator)
// AND any 4+ char token of the venue name appears in the URL.
function plausibleVenueUrl(url, name) {
  if (!url || !/^https?:/.test(url)) return false;
  const lower = url.toLowerCase();
  if (AGGREGATOR_HOSTS.test(lower)) return false;
  const tokens = normalizeName(name).split(' ').filter(t => t.length >= 4);
  if (tokens.length === 0) return true;
  return tokens.some(t => lower.includes(t));
}

// True if the URL is an aggregator we still want to fetch for JSON-LD signals
// (RestaurantGuru, TripAdvisor, carta.menu have great schema.org coverage).
function isAggregatorUrl(url) {
  if (!url) return false;
  return /(restaurantguru|carta\.menu|tripadvisor)/i.test(url);
}

module.exports = {
  DEFAULT_UA,
  sleep,
  isEmpty,
  decodeEntities,
  normalizeName,
  jaroWinkler,
  haversineM,
  fetchWithTimeout,
  slugify,
  canonCity,
  dedupKey,
  STYLE_PATTERNS,
  inferStylesFromText,
  parseSchemaOrgFromHtml,
  priceRangeToLevel,
  ddgSearch,
  decodeDdgLink,
  plausibleVenueUrl,
  isAggregatorUrl,
  AGGREGATOR_HOSTS,
};
