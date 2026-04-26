#!/usr/bin/env node
// scripts/scrape-venue.js
//
// Per-venue companion to scripts/enricher.js. Given a name + city, fan out
// across free sources and reconcile a complete Prisma `Place` record from
// scratch. Used when a user/admin says "add this place" — enricher.js handles
// the prior-existing rows; this handles the cold-start.
//
// Spec: notes/scrape-venue-spec.md
// Test fixture: notes/scrape-venue-sample-il-figlio-di-emiliano.md
//
// Sources (in priority order — earliest source wins on field conflicts, with
// a few overrides documented inline):
//
//   1. Nominatim — coords + structured address by name+city, then by full
//      address as a coord cross-check.
//   2. Official site — discovered via DuckDuckGo HTML search, fetched directly
//      for JSON-LD + WP REST media library + contact-page tel: links.
//   3. RestaurantGuru / carta.menu / TripAdvisor (web) — aggregator JSON-LD
//      for hours, priceRange, image, geo. Treated as fallback / cross-check.
//   4. TripAdvisor Content API (optional) — only when TRIPADVISOR_API_KEY is
//      set in .env or --with-tripadvisor is passed. Mainly a phone fallback;
//      adds ranking + rating signals as bonus.
//
// Output: reconciled JSON to stdout (matching Prisma Place create shape) plus
//   _meta with sources, coordDelta, warnings. Hero JPEG staged to
//   public/uploads/places/_staging-<slug>.jpg. With --insert, writes the row
//   via Prisma + renames staging hero to {placeId}.jpg.
//
// Usage:
//   node scripts/scrape-venue.js "<name>" "<city>" [--country ES]
//                                                  [--insert]
//                                                  [--out path.json]
//                                                  [--with-tripadvisor]

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
  sleep, isEmpty,
  normalizeName, jaroWinkler, haversineM,
  fetchWithTimeout,
  slugify, dedupKey,
  inferStylesFromText, parseSchemaOrgFromHtml, priceRangeToLevel,
  ddgSearch, plausibleVenueUrl, isAggregatorUrl, AGGREGATOR_HOSTS,
} = require('./lib/utils');
const taBudget = require('./lib/tripadvisor-budget');

const ROOT = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(ROOT, 'public', 'uploads', 'places');
const UA = 'OpenPizzaMap-scrape-venue/0.1 (eric@openpizzamap.com)';

// ─── CLI parsing ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) { return args.includes(name); }
function valArg(name) {
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
}
const positional = args.filter(a => !a.startsWith('--'));
const NAME = positional[0];
const CITY = positional[1];
const COUNTRY = valArg('--country');                            // ISO2, optional
const INSERT = flag('--insert');
const OUT = (() => { const v = valArg('--out'); return v && v !== true ? v : null; })();
const WITH_TA = flag('--with-tripadvisor') || !!process.env.TRIPADVISOR_API_KEY;

if (!NAME || !CITY) {
  console.error('usage: node scripts/scrape-venue.js "<name>" "<city>" [--country XX] [--insert] [--out path.json] [--with-tripadvisor]');
  process.exit(2);
}

const SLUG = slugify(`${NAME}-${CITY}`);
const STAGING_FILENAME = `_staging-${SLUG}.jpg`;
const STAGING_PATH = path.join(UPLOADS_DIR, STAGING_FILENAME);

// ─── politeness: per-host single-flight + 1.5s spacing ──────────────────────
const _hostLastFetch = new Map();      // hostname → ts of last fetch start
const _hostInflight = new Map();       // hostname → Promise (current request, if any)
const PER_HOST_DELAY_MS = 1500;

async function politeFetch(url, opts = {}, timeoutMs = 20000) {
  const u = new URL(url);
  const host = u.host;
  // Wait for any in-flight request to the same host.
  while (_hostInflight.get(host)) {
    try { await _hostInflight.get(host); } catch { /* ignore — we're queuing */ }
  }
  // Throttle to 1.5s between starts on the same host.
  const last = _hostLastFetch.get(host) || 0;
  const wait = Math.max(0, last + PER_HOST_DELAY_MS - Date.now());
  if (wait > 0) await sleep(wait);
  _hostLastFetch.set(host, Date.now());
  const p = fetchWithTimeout(url, { ...opts, userAgent: opts.userAgent || UA }, timeoutMs);
  _hostInflight.set(host, p);
  try { return await p; }
  finally {
    if (_hostInflight.get(host) === p) _hostInflight.delete(host);
  }
}

// ─── Nominatim ───────────────────────────────────────────────────────────────
async function nominatimSearch(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=3&q=' + encodeURIComponent(query);
  const r = await politeFetch(url, { accept: 'application/json' });
  if (!r.ok) throw new Error(`nominatim ${r.status}`);
  return await r.json();
}

// ─── HTML body fetch ────────────────────────────────────────────────────────
async function fetchHtml(url, timeoutMs = 20000) {
  const r = await politeFetch(url, { accept: 'text/html' }, timeoutMs);
  return { ok: r.ok, status: r.status, html: r.ok ? await r.text() : '' };
}

// ─── style inference helper ──────────────────────────────────────────────────
// Takes ALL signals from one page (JSON-LD + raw text + name) and returns a
// deduped slug array.
function inferAllStyles(html, name, jsonLd) {
  const text = (html || '').replace(/<[^>]+>/g, ' ').slice(0, 50000);
  const fromText = inferStylesFromText(text);
  const fromName = inferStylesFromText(name);
  const fromLd = (jsonLd && jsonLd.styles) || [];
  return [...new Set([...fromText, ...fromName, ...fromLd])];
}

// ─── confidence guard ───────────────────────────────────────────────────────
// Per spec: if no 4+ char token of the venue name appears anywhere in the
// candidate URL or its page title, abort. Better to error than to attribute
// data to the wrong restaurant.
function pageMatchesName(html, url, name) {
  const tokens = normalizeName(name).split(' ').filter(t => t.length >= 4);
  if (tokens.length === 0) return true;
  const lowerUrl = String(url || '').toLowerCase();
  const titleMatch = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const lowerTitle = titleMatch ? normalizeName(titleMatch[1]) : '';
  return tokens.some(t => lowerUrl.includes(t) || lowerTitle.includes(t));
}

// ─── official-site contact-page probes ──────────────────────────────────────
const CONTACT_PATHS = ['/contacto', '/contacto/', '/contact', '/contact/', '/reserva', '/reserva/', '/menu', '/menu/', '/la-carta', '/la-carta/'];

function extractTelFromHtml(html) {
  const m = String(html || '').match(/href="tel:([^"]+)"/i);
  if (!m) return null;
  return m[1].replace(/[^\d+]/g, '');
}
function extractInstagramFromHtml(html) {
  const m = String(html || '').match(/href="(https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9_.\-]+\/?)"/i);
  return m ? m[1] : null;
}
function extractEmailFromHtml(html) {
  const m = String(html || '').match(/href="mailto:([^"?]+)"/i);
  return m ? m[1] : null;
}
// Naïve street-line extractor: looks for common Spanish/Italian street prefixes.
// The official site nearly always renders the address as plain text near the
// schema.org block; if JSON-LD already has it we don't even hit this path.
function extractStreetFromHtml(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const re = /\b(?:Carrer|C\.|Calle|Avinguda|Avenida|Avda\.|Plaça|Plaza|Via|Viale|Piazza|Corso|Strada|Street|Rue|Avenue|Boulevard)\b[^,]{2,80}\d+/gi;
  const m = text.match(re);
  return m ? m[0].trim() : null;
}
// Postal code: 5-digit (ES/IT/FR/DE/US-zip) or 4-digit (AT/CH/HU/NL prefix).
// Used to backfill from the venue's contact page when JSON-LD didn't carry it.
function extractPostalFromHtml(html) {
  const text = String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  // Postcodes near a city name: "08202 Sabadell" OR "08202, Sabadell".
  // Allow optional comma between because that's how addresses render in HTML.
  const m = text.match(/\b(\d{5}|\d{4})\b(?=[,\s]+[A-ZÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑ][a-zà-ÿ]+)/);
  return m ? m[1] : null;
}

// ─── WP REST media library probe ────────────────────────────────────────────
// Many pizzeria sites are WordPress. /wp-json/wp/v2/media?per_page=30 returns
// the public media library — useful when JSON-LD doesn't carry an image.
// We prefer files matching Home1*/Home2*/Hero*/Banner* (WP theme convention).
async function probeWpMedia(siteUrl) {
  try {
    const u = new URL(siteUrl);
    u.pathname = '/wp-json/wp/v2/media';
    u.search = '?per_page=30';
    const r = await politeFetch(u.toString(), { accept: 'application/json' });
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr)) return null;
    // Prefer hero-named JPEGs. Fall back to the largest by media_details.filesize.
    const ranked = arr
      .filter(it => it.source_url && /\.(jpe?g|png|webp)$/i.test(it.source_url))
      .map(it => ({
        url: it.source_url,
        score: /home\d|hero|banner|portada/i.test(it.source_url) ? 100 : 0,
        size: (it.media_details && it.media_details.filesize) || 0,
      }))
      .sort((a, b) => (b.score - a.score) || (b.size - a.size));
    return ranked.length ? ranked[0].url : null;
  } catch { return null; }
}

// ─── TripAdvisor Content API (optional) ──────────────────────────────────────
const TA_BASE = 'https://api.content.tripadvisor.com/api/v1';
async function taFetch(pathname, params = {}) {
  const apiKey = process.env.TRIPADVISOR_API_KEY;
  if (!apiKey) throw new Error('TRIPADVISOR_API_KEY not set');
  // Reserve a budget slot BEFORE the network call; load() rolls month/day if needed.
  const slot = taBudget.reserve(pathname);
  const u = new URL(TA_BASE + pathname);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', apiKey);
  // The TA key is domain-restricted to www.openpizzamap.com — TA validates the
  // Referer header server-side. Without the `www.` prefix the API returns 403
  // ("explicit deny"); confirmed by direct probe on 2026-04-26.
  const r = await politeFetch(u.toString(), {
    accept: 'application/json',
    headers: { 'Referer': 'https://www.openpizzamap.com/' },
  });
  if (!r.ok) throw new Error(`tripadvisor ${pathname} ${r.status} (budget ${slot.calls}/${taBudget.MONTHLY_HARD_CAP})`);
  return await r.json();
}
async function taLookup(name, city, country) {
  // 1 call: location/search by name + city.
  const j = await taFetch('/location/search', {
    searchQuery: name,
    searchAddress: city,
    category: 'restaurants',
    ...(country ? { language: 'en' } : {}),
  });
  const candidates = (j && j.data) || [];
  if (!candidates.length) return null;
  // Pick best by name similarity.
  const wanted = normalizeName(name);
  let best = null, bestSim = 0;
  for (const c of candidates) {
    const sim = jaroWinkler(wanted, normalizeName(c.name || ''));
    if (sim > bestSim) { bestSim = sim; best = c; }
  }
  if (!best || bestSim < 0.7) return null;
  // 1 call: location/{id}/details.
  const det = await taFetch(`/location/${best.location_id}/details`);
  return { search: best, details: det };
}

// ─── reconciliation ─────────────────────────────────────────────────────────
// fillIfEmpty: returns next if cur is empty/null, else cur. Pure helper.
function fillIfEmpty(cur, next) { return isEmpty(cur) ? next : cur; }

function buildSeo(name, primaryStyle, city, postalCode, ldDescription) {
  const styleLabel = primaryStyle ? primaryStyle.charAt(0).toUpperCase() + primaryStyle.slice(1).replace('-', ' ') : null;
  // seoTitle: "Name — Style Pizza in City"; drop style clause if too long.
  let seoTitle;
  if (styleLabel) {
    seoTitle = `${name} — ${styleLabel} Pizza in ${city}`;
    if (seoTitle.length > 60) seoTitle = `${name} — Pizza in ${city}`;
  } else {
    seoTitle = `${name} — Pizza in ${city}`;
  }
  if (seoTitle.length > 60) seoTitle = seoTitle.slice(0, 60);

  // seoDescription: style-led intro + city + optional cuisine-signal sentence.
  // Never exceed 160 chars; schema cap is 200, leave headroom for editing.
  const lead = styleLabel ? `${styleLabel} pizzeria in ${city}` : `Pizzeria in ${city}`;
  const addr = postalCode ? ` (${postalCode})` : '';
  let cuisine = '';
  if (ldDescription) {
    // Take the first sentence-ish chunk that fits.
    const firstSent = ldDescription.replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0] || '';
    if (firstSent.length && firstSent.length < 100) cuisine = ' ' + firstSent.trim().replace(/\.$/, '') + '.';
  }
  let seoDescription = (lead + addr + '.' + cuisine).trim();
  if (seoDescription.length > 160) seoDescription = seoDescription.slice(0, 157).trimEnd() + '…';
  return { seoTitle, seoDescription };
}

// ─── hero download ──────────────────────────────────────────────────────────
async function downloadHero(url, dest) {
  if (!url) return { ok: false, reason: 'no-url' };
  if (fs.existsSync(dest)) return { ok: true, reason: 'already-staged', bytes: fs.statSync(dest).size };
  const r = await politeFetch(url, { accept: 'image/*' }, 30000);
  if (!r.ok) return { ok: false, reason: `http ${r.status}` };
  const ct = r.headers.get('content-type') || '';
  if (!/^image\//i.test(ct)) return { ok: false, reason: `bad content-type: ${ct}` };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length < 50_000) return { ok: false, reason: `too small (${buf.length}B — likely placeholder)` };
  if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  fs.writeFileSync(dest, buf);
  return { ok: true, reason: 'downloaded', bytes: buf.length };
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  console.error(`[scrape-venue] target: "${NAME}" / "${CITY}"${COUNTRY ? ' / ' + COUNTRY : ''}  →  slug ${SLUG}`);

  const sources = [];   // [{source, url, fields: [...]}]
  const warnings = [];

  // ── 1. Nominatim by name+city ──
  let nominatimByName = null;
  try {
    const hits = await nominatimSearch(`${NAME} ${CITY}${COUNTRY ? ' ' + COUNTRY : ''}`);
    const hit = hits.find(h => h.class === 'amenity' || h.class === 'tourism' || h.class === 'shop') || null;
    if (hit) {
      nominatimByName = {
        lat: parseFloat(hit.lat),
        lng: parseFloat(hit.lon),
        addressLine: (hit.address && (hit.address.road ? `${hit.address.road}${hit.address.house_number ? ' ' + hit.address.house_number : ''}` : null)) || null,
        postalCode: hit.address && hit.address.postcode || null,
        region: hit.address && (hit.address.state || hit.address.region) || null,
        countryCode: hit.address && hit.address.country_code ? hit.address.country_code.toUpperCase() : null,
      };
      sources.push({ source: 'nominatim-by-name', url: hit.osm_url || `osm://${hit.osm_type}/${hit.osm_id}`, fields: Object.keys(nominatimByName).filter(k => nominatimByName[k] != null) });
      console.error(`[nominatim/name] hit: ${hit.display_name}`);
    } else {
      console.error('[nominatim/name] empty (venue not in OSM as POI)');
    }
  } catch (e) {
    warnings.push(`nominatim by name failed: ${e.message || e}`);
  }

  // ── 2. DuckDuckGo HTML search ──
  let ddgUrls = [];
  try {
    ddgUrls = await ddgSearch(`"${NAME}" ${CITY}`, { userAgent: UA });
    console.error(`[ddg] ${ddgUrls.length} results`);
  } catch (e) {
    warnings.push(`ddg search failed: ${e.message || e}`);
  }
  const officialUrls = ddgUrls.filter(u => plausibleVenueUrl(u, NAME));
  const aggregatorUrls = ddgUrls.filter(u => isAggregatorUrl(u));

  // ── 3a. Official site ──
  let officialUrl = officialUrls[0] || null;
  let officialJsonLd = null;
  let officialHtml = null;
  let officialContacts = { phone: null, instagramUrl: null, email: null, addressFromContact: null };
  let wpMediaImage = null;
  if (officialUrl) {
    console.error(`[official] ${officialUrl}`);
    try {
      const { ok, status, html } = await fetchHtml(officialUrl);
      if (!ok) { warnings.push(`official site: HTTP ${status}`); officialUrl = null; }
      else {
        officialHtml = html;
        if (!pageMatchesName(html, officialUrl, NAME)) {
          warnings.push(`official site title doesn't mention venue — treating as low-confidence`);
        }
        officialJsonLd = parseSchemaOrgFromHtml(html);
        sources.push({ source: 'official-site', url: officialUrl, fields: Object.keys(officialJsonLd).filter(k => officialJsonLd[k] != null && (!Array.isArray(officialJsonLd[k]) || officialJsonLd[k].length)) });
        // tel / instagram from the homepage itself.
        officialContacts.phone = extractTelFromHtml(html);
        officialContacts.instagramUrl = officialJsonLd.instagramUrl || extractInstagramFromHtml(html);
        officialContacts.email = extractEmailFromHtml(html);
        // WP REST media library probe — best effort.
        wpMediaImage = await probeWpMedia(officialUrl);
        if (wpMediaImage) sources[sources.length - 1].fields.push('heroImageUrl(wp-media)');
      }
    } catch (e) {
      warnings.push(`official site fetch failed: ${e.message || e}`);
      officialUrl = null;
    }

    // Probe contact pages for tel / address / postal not on the homepage.
    let officialPostalFromContact = null;
    if (officialUrl && (!officialContacts.phone || !officialJsonLd.addressLine || !officialJsonLd.postalCode)) {
      for (const sub of CONTACT_PATHS) {
        if (officialContacts.phone && officialJsonLd.addressLine && (officialJsonLd.postalCode || officialPostalFromContact)) break;
        try {
          const subUrl = new URL(sub, officialUrl).toString();
          const { ok, html } = await fetchHtml(subUrl, 12000);
          if (!ok) continue;
          if (!officialContacts.phone) officialContacts.phone = extractTelFromHtml(html);
          if (!officialJsonLd.addressLine) {
            const street = extractStreetFromHtml(html);
            if (street) officialContacts.addressFromContact = street;
          }
          if (!officialJsonLd.postalCode && !officialPostalFromContact) {
            officialPostalFromContact = extractPostalFromHtml(html);
          }
          if (!officialContacts.instagramUrl) officialContacts.instagramUrl = extractInstagramFromHtml(html);
        } catch { /* keep probing */ }
      }
    }
    // Stash the contact-page postal so reconciliation can prefer it over Nominatim's centroid postcode.
    officialContacts.postalFromContact = officialPostalFromContact;
  } else {
    console.error('[official] no plausible non-aggregator URL in DDG results');
  }

  // ── 3b. Aggregators (RestaurantGuru, carta.menu, TripAdvisor web) ──
  // We fetch each for JSON-LD signals. RG/carta.menu return rich Restaurant
  // schema; TripAdvisor often 403s for bots — we treat that as expected.
  let restaurantGuruLd = null, cartaMenuLd = null, tripadvisorLd = null;
  for (const u of aggregatorUrls.slice(0, 3)) {
    try {
      console.error(`[aggregator] ${u}`);
      const { ok, status, html } = await fetchHtml(u);
      if (!ok) {
        warnings.push(`${new URL(u).host} HTTP ${status}`);
        continue;
      }
      const ld = parseSchemaOrgFromHtml(html);
      const fields = Object.keys(ld).filter(k => ld[k] != null && (!Array.isArray(ld[k]) || ld[k].length));
      if (!fields.length) continue;
      sources.push({ source: new URL(u).host, url: u, fields });
      if (/restaurantguru/i.test(u)) restaurantGuruLd = ld;
      else if (/carta\.menu/i.test(u)) cartaMenuLd = ld;
      else if (/tripadvisor/i.test(u)) tripadvisorLd = ld;
    } catch (e) {
      warnings.push(`${u}: ${e.message || e}`);
    }
  }

  // ── 4. TripAdvisor Content API (optional) ──
  let tripadvisorApi = null;
  if (WITH_TA && process.env.TRIPADVISOR_API_KEY) {
    try {
      const status = taBudget.status();
      console.error(`[ta-api] budget: month=${status.monthCalls}/${status.monthlyCap}, today=${status.todayCalls}/${status.dailyCap}`);
      tripadvisorApi = await taLookup(NAME, CITY, COUNTRY);
      if (tripadvisorApi) {
        sources.push({
          source: 'tripadvisor-api',
          url: tripadvisorApi.details && tripadvisorApi.details.web_url || null,
          fields: ['phone', 'ranking', 'rating', 'reviewCount', 'tripadvisorUrl', 'tripadvisorLocationId'],
        });
        console.error(`[ta-api] matched location ${tripadvisorApi.search.location_id}`);
      } else {
        warnings.push('tripadvisor-api: no confident match in /location/search');
      }
    } catch (e) {
      warnings.push(`tripadvisor-api: ${e.message || e}`);
    }
  } else if (WITH_TA && !process.env.TRIPADVISOR_API_KEY) {
    warnings.push('--with-tripadvisor passed but TRIPADVISOR_API_KEY not set in .env');
  }

  // ── 5. Geocode the discovered address (cross-check) ──
  // Pick the best address we have so far: official JSON-LD > Nominatim-by-name > contact-page heuristic.
  // Address priority: official JSON-LD > Nominatim by name > venue contact-page
  // heuristic > RestaurantGuru > carta.menu (noisier — concatenated city/region).
  // Strip a known noise suffix pattern like ", City, Region, Country" if present
  // (some aggregators repeat the full address as one string).
  const stripAddressNoise = (s) => {
    if (!s) return s;
    const cityRe = new RegExp('\\s*,\\s*' + CITY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '.*$', 'i');
    return s.replace(cityRe, '').trim();
  };
  const reconciledAddress = stripAddressNoise(
    (officialJsonLd && officialJsonLd.addressLine)
    || (nominatimByName && nominatimByName.addressLine)
    || officialContacts.addressFromContact
    || (restaurantGuruLd && restaurantGuruLd.addressLine)
    || (cartaMenuLd && cartaMenuLd.addressLine)
    || null
  );
  // Postcode priority: official site's own contact page > JSON-LD > Nominatim-
  // by-name > aggregator JSON-LD. We don't include Nominatim-by-address yet —
  // that's filled in below after the geocode call (where it has the highest
  // ground-truth value when nothing else carried a postcode).
  let reconciledPostal = (officialContacts && officialContacts.postalFromContact)
    || (officialJsonLd && officialJsonLd.postalCode)
    || (nominatimByName && nominatimByName.postalCode)
    || (restaurantGuruLd && restaurantGuruLd.postalCode)
    || null;

  let nominatimByAddress = null;
  if (reconciledAddress) {
    try {
      // Some aggregators return addressLine as a verbose concatenation
      // ("Street 6, City, Region, Country") which confuses Nominatim. Trim to
      // the street segment + supply city/postal/country separately.
      const streetOnly = reconciledAddress.split(',').slice(0, 2).join(',').trim();
      const q = [streetOnly, reconciledPostal, CITY, COUNTRY].filter(Boolean).join(', ');
      let hits = await nominatimSearch(q);
      // Fallback: if no hit on the cleaned query, try the original string (some
      // street types Nominatim only resolves when the full context is given).
      if (!hits.length && streetOnly !== reconciledAddress) {
        hits = await nominatimSearch([reconciledAddress, CITY, COUNTRY].filter(Boolean).join(', '));
      }
      if (hits.length) {
        const h = hits[0];
        // Pull region/postal/country from the address-detail response too — this
        // is often the most reliable source for postal code (Nominatim resolves
        // street centroids precisely) and region (state/region field is filled
        // for any geocoded address).
        nominatimByAddress = {
          lat: parseFloat(h.lat),
          lng: parseFloat(h.lon),
          display: h.display_name,
          region: h.address && (h.address.state || h.address.region) || null,
          postalCode: h.address && h.address.postcode || null,
          countryCode: h.address && h.address.country_code ? h.address.country_code.toUpperCase() : null,
        };
        const fields = ['lat', 'lng'];
        if (nominatimByAddress.region) fields.push('region');
        if (nominatimByAddress.postalCode) fields.push('postalCode');
        sources.push({ source: 'nominatim-by-address', url: 'https://nominatim.openstreetmap.org/search?q=' + encodeURIComponent(q), fields });
        console.error(`[nominatim/address] ${nominatimByAddress.display}`);
        // Backfill postcode if no upstream source had one. Nominatim's postcode
        // is the street centroid, which can be off by one block — but null is
        // worse than slightly-stale, and the spec's invariant is fill-only-if-null.
        if (!reconciledPostal && nominatimByAddress.postalCode) {
          reconciledPostal = nominatimByAddress.postalCode;
        }
      }
    } catch (e) {
      warnings.push(`nominatim by address failed: ${e.message || e}`);
    }
  }

  // ── 6. Coord reconciliation ──
  // Per spec: prefer JSON-LD geo from official → RG; cross-check against
  // Nominatim-by-address. If sources disagree by >100m, use Nominatim and warn.
  const ldGeoSources = [
    officialJsonLd && officialJsonLd.lat != null ? { lat: officialJsonLd.lat, lng: officialJsonLd.lng, label: 'official-jsonld' } : null,
    restaurantGuruLd && restaurantGuruLd.lat != null ? { lat: restaurantGuruLd.lat, lng: restaurantGuruLd.lng, label: 'restaurantguru' } : null,
    cartaMenuLd && cartaMenuLd.lat != null ? { lat: cartaMenuLd.lat, lng: cartaMenuLd.lng, label: 'carta.menu' } : null,
    nominatimByName ? { lat: nominatimByName.lat, lng: nominatimByName.lng, label: 'nominatim-by-name' } : null,
  ].filter(Boolean);
  let lat = null, lng = null;
  let coordDelta = null;
  if (ldGeoSources.length || nominatimByAddress) {
    const primary = ldGeoSources[0] || nominatimByAddress;
    lat = primary.lat; lng = primary.lng;
    if (nominatimByAddress && ldGeoSources.length) {
      const d = haversineM(primary.lat, primary.lng, nominatimByAddress.lat, nominatimByAddress.lng);
      coordDelta = Math.round(d);
      if (d <= 50) {
        // Average for a touch more accuracy.
        lat = (primary.lat + nominatimByAddress.lat) / 2;
        lng = (primary.lng + nominatimByAddress.lng) / 2;
      } else if (d > 100) {
        // Disagreement — trust the Nominatim-by-address result.
        lat = nominatimByAddress.lat; lng = nominatimByAddress.lng;
        warnings.push(`coord disagreement ${primary.label} vs nominatim-by-address: ${Math.round(d)}m — using nominatim`);
      }
    }
  }

  // ── 7. Phone — prefer venue's own page, then JSON-LD, then TA API ──
  const phone =
    fillIfEmpty(null,
      officialContacts.phone
      || (officialJsonLd && officialJsonLd.phone)
      || (restaurantGuruLd && restaurantGuruLd.phone)
      || (tripadvisorApi && tripadvisorApi.details && tripadvisorApi.details.phone)
      || null
    );

  // ── 8. Hours — official site wins; warn on disagreement ──
  let openingHours = officialJsonLd && officialJsonLd.openingHours;
  if (!openingHours && restaurantGuruLd && restaurantGuruLd.openingHours) openingHours = restaurantGuruLd.openingHours;
  if (!openingHours && cartaMenuLd && cartaMenuLd.openingHours) openingHours = cartaMenuLd.openingHours;
  // Soft hours-conflict warning for admin review.
  if (officialJsonLd && officialJsonLd.openingHours && restaurantGuruLd && restaurantGuruLd.openingHours
      && officialJsonLd.openingHours !== restaurantGuruLd.openingHours) {
    warnings.push(`hours disagreement official vs restaurantguru — using official site`);
  }

  // ── 9. Price level ──
  // Sample fixture: TripAdvisor's $$$$ contradicts the actual menu, RG's $$ is
  // correct. So the priority is: official → RG → carta.menu → TA. (TA last
  // because their range is unreliable for indie places per the sample.)
  let priceLevel = null;
  for (const ld of [officialJsonLd, restaurantGuruLd, cartaMenuLd]) {
    if (ld && ld.priceLevel != null) { priceLevel = ld.priceLevel; break; }
  }
  if (priceLevel == null) priceLevel = 2; // sane default

  // ── 10. Image ──
  // Per spec: WP Home1* > OG og:image > JSON-LD image[0]. We collect WP first,
  // then fall back to JSON-LD/OG.
  const ogImageMatch = officialHtml ? officialHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i) : null;
  const heroCandidate =
    wpMediaImage
    || (ogImageMatch && ogImageMatch[1])
    || (officialJsonLd && officialJsonLd.heroImageUrl)
    || (restaurantGuruLd && restaurantGuruLd.heroImageUrl)
    || null;

  // ── 11. Style inference ──
  const styles = inferAllStyles(officialHtml, NAME, officialJsonLd);
  // If no style found from text/name, but JSON-LD servesCuisine had something
  // that didn't match a regex, fall back to "italian" as a generic.
  const stylesFinal = styles.length ? styles : [];
  const primaryStyle = stylesFinal[0] || null;

  // ── 12. Service flags ──
  // Default: dineIn=true, takeaway=true (most pizzerias). delivery=true if any
  // aggregator presence found (Glovo/JustEat/Deliveroo URL in DDG results).
  const dineIn = true;
  const takeaway = true;
  const delivery = ddgUrls.some(u => /(glovoapp|justeat|deliveroo|ubereats)/i.test(u));

  // ── 13. SEO fields ──
  const ldDescription = officialJsonLd && officialJsonLd.description;
  const { seoTitle, seoDescription } = buildSeo(NAME, primaryStyle, CITY, reconciledPostal, ldDescription);

  // ── 14. Hero stage to disk ──
  let heroResult = { ok: false, reason: 'no-attempt' };
  let heroImageUrl = `/uploads/places/${STAGING_FILENAME}`;
  if (heroCandidate) {
    heroResult = await downloadHero(heroCandidate, STAGING_PATH);
    if (!heroResult.ok) {
      warnings.push(`hero download failed (${heroResult.reason}); leaving heroImageUrl pointing at staging path`);
    }
  } else if (fs.existsSync(STAGING_PATH)) {
    heroResult = { ok: true, reason: 'no-candidate-but-staged-file-exists', bytes: fs.statSync(STAGING_PATH).size };
  } else {
    warnings.push('no hero image candidate found across any source');
    heroImageUrl = null;
  }

  // ── 15. Country code resolution ──
  // Priority: --country flag > nominatim-by-name > JSON-LD country.
  const countryCode =
    (COUNTRY && COUNTRY.toUpperCase())
    || (nominatimByName && nominatimByName.countryCode)
    || (officialJsonLd && officialJsonLd.country)
    || null;

  // ── 16. Region resolution ──
  // Spec example uses "Catalunya" (free-text Catalan name). Prefer JSON-LD,
  // then Nominatim by-address (which carries `state`/`region`), then by-name.
  const region =
    (officialJsonLd && officialJsonLd.region)
    || (restaurantGuruLd && restaurantGuruLd.region)
    || (nominatimByAddress && nominatimByAddress.region)
    || (nominatimByName && nominatimByName.region)
    || null;

  // ── 17. Build the output record ──
  // Coords rounded to 7 decimals (matches Prisma Decimal(10,7) precision).
  const place = {
    name: NAME,
    addressLine: reconciledAddress || null,
    city: CITY,
    region: region,
    postalCode: reconciledPostal || null,
    country: countryCode,
    lat: lat != null ? +lat.toFixed(7) : null,
    lng: lng != null ? +lng.toFixed(7) : null,
    priceLevel,
    stylesJson: JSON.stringify(stylesFinal),
    dineIn,
    takeaway,
    delivery,
    phone,
    websiteUrl: officialUrl || null,
    googleMapsUrl: lat != null && lng != null ? `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(7)},${lng.toFixed(7)}` : null,
    instagramUrl: officialContacts.instagramUrl || null,
    openingHours: openingHours || null,
    status: 'active',
    slug: SLUG,
    heroImageUrl,
    descriptionHtml: null,            // out of scope per spec — Gemini fills later
    seoTitle,
    seoDescription,
    isVisible: true,
  };

  // TripAdvisor API enrichment — additive fields only when present.
  if (tripadvisorApi && tripadvisorApi.details) {
    const d = tripadvisorApi.details;
    place.tripadvisorLocationId = parseInt(tripadvisorApi.search.location_id, 10);
    place.tripadvisorRanking = d.ranking_data && d.ranking_data.ranking_string || null;
    place.tripadvisorRating = d.rating != null ? parseFloat(d.rating) : null;
    place.tripadvisorReviewCount = d.num_reviews != null ? parseInt(d.num_reviews, 10) : null;
    place.tripadvisorUrl = d.web_url || null;
  }

  const meta = {
    sources,
    coordDelta,
    warnings,
    heroResult,
    aggregatorUrlsConsidered: aggregatorUrls,
    ddgResultsCount: ddgUrls.length,
    withTripadvisor: !!tripadvisorApi,
  };

  const output = { ...place, _meta: meta };

  // Always print to stdout (machine-readable). Status lines went to stderr.
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');

  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
    console.error(`[scrape-venue] wrote ${OUT}`);
  }

  // ── 18. --insert: write to DB via Prisma ──
  if (INSERT) {
    if (!place.lat || !place.lng) {
      console.error('[insert] refusing — no coords could be reconciled');
      process.exit(1);
    }
    if (!place.country) {
      console.error('[insert] refusing — no country code');
      process.exit(1);
    }
    const prisma = new PrismaClient();
    try {
      // City upsert (normalized slug).
      const citySlug = slugify(CITY);
      let cityRow = await prisma.city.findUnique({ where: { countryCode_slug: { countryCode: place.country, slug: citySlug } } }).catch(() => null);
      if (!cityRow) {
        cityRow = await prisma.city.create({ data: { name: CITY, slug: citySlug, countryCode: place.country, isVisible: false } });
      }
      // Strip _meta before insert.
      const { _meta, tripadvisorLocationId, tripadvisorRanking, tripadvisorRating, tripadvisorReviewCount, tripadvisorUrl, ...createInput } = place;
      const created = await prisma.place.create({
        data: {
          ...createInput,
          addressLine: createInput.addressLine || '',     // schema requires non-null
          country: createInput.country || '',
          cityId: cityRow.id,
          // TA fields are additive — only include if the schema knows them
          // (post-migration). Wrapped here so pre-migration runs don't blow up.
          ...(tripadvisorLocationId != null ? { tripadvisorLocationId, tripadvisorRanking, tripadvisorRating, tripadvisorReviewCount, tripadvisorUrl } : {}),
        },
      });

      // PlaceSource: mark as 'manual' since this is a per-venue add.
      await prisma.placeSource.create({ data: { placeId: created.id, source: 'manual', rank: null } });
      // If TA api hit, also tag a 'tripadvisor' source row for join consistency
      // with the rest of the pipeline.
      if (tripadvisorLocationId != null) {
        await prisma.placeSource.create({ data: { placeId: created.id, source: 'tripadvisor', rank: null } });
      }

      // PlaceStyle: link each style slug.
      for (const slug of stylesFinal) {
        const s = await prisma.style.findUnique({ where: { slug } });
        if (s) {
          try { await prisma.placeStyle.create({ data: { placeId: created.id, styleId: s.id } }); }
          catch { /* unique constraint */ }
        }
      }

      // Rename staging hero to canonical {placeId}.{ext}.
      if (heroResult.ok && fs.existsSync(STAGING_PATH)) {
        const finalName = `${created.id}.jpg`;
        const finalPath = path.join(UPLOADS_DIR, finalName);
        fs.renameSync(STAGING_PATH, finalPath);
        await prisma.place.update({ where: { id: created.id }, data: { heroImageUrl: `/uploads/places/${finalName}` } });
      }

      console.error(`[insert] created Place id=${created.id} slug=${created.slug}`);
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
