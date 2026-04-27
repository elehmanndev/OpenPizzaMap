#!/usr/bin/env node
// Single-purpose data-quality + enrichment workhorse for OpenPizzaMap.
//
// Phases (run sequentially by default — pass --phase=NAME to run a single one):
//
//   1. validate   — Identify places stuck on city-center fallback coords
//                   (multiple unrelated venues at the same exact lat/lng).
//                   Hide them (isVisible=false) so the map stops lying.
//
//   2. dedup      — Find pairs/groups of places within 100m of each other
//                   whose normalized names match (Jaro-Winkler >= 0.85).
//                   Merge into one canonical row: union sources, union
//                   styles, fill-only-if-null on metadata. Delete losers.
//
//   3. overpass   — Query OpenStreetMap Overpass API by coords + name for
//                   every place missing website/phone/hours. Pull what's
//                   there. Free, no API key.
//
//   4. web        — For every place that has a websiteUrl but is missing
//                   opening hours or styles, fetch the homepage and parse
//                   schema.org JSON-LD + scan copy for style keywords.
//
//   5. search     — For every place WITHOUT a websiteUrl, run a polite
//                   DuckDuckGo HTML search to discover one, then re-run
//                   the web phase on the discovered URL.
//
// Usage:
//   node scripts/enricher.js                       # all phases
//   node scripts/enricher.js --phase=validate
//   node scripts/enricher.js --phase=dedup
//   node scripts/enricher.js --phase=overpass --limit 50
//   node scripts/enricher.js --skip=search         # all except search
//
// Self-paced: every external request is rate-limited and retried on transient
// failure. Designed to run unattended for 30–90 min and resume idempotently.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const {
  sleep, isEmpty, decodeEntities,
  normalizeName, jaroWinkler, haversineM,
  fetchWithTimeout, parseSchemaOrgFromHtml,
  STYLE_PATTERNS, inferStylesFromText,
  ddgSearch, decodeDdgLink, plausibleVenueUrl,
} = require('./lib/utils');

const ROOT = path.resolve(__dirname, '..');
const REPORT_FILE = path.join(ROOT, 'enricher-report.json');

const args = process.argv.slice(2);
const arg = (name) => {
  // Support both `--phase value` and `--phase=value` forms.
  const eq = args.find(a => a.startsWith(name + '='));
  if (eq) return eq.slice(name.length + 1);
  const i = args.indexOf(name);
  if (i === -1) return null;
  const next = args[i + 1];
  if (!next || next.startsWith('--')) return true;
  return next;
};
const argMulti = (name) => {
  const v = arg(name);
  if (v === null || v === true) return null;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
};
const PHASE = arg('--phase');               // null | 'clean' | 'validate' | 'dedup' | 'overpass' | 'web' | 'search'
const SKIP = argMulti('--skip') || [];      // ['search', 'web']
const LIMIT = (() => { const v = arg('--limit'); return v && v !== true ? parseInt(v, 10) : null; })();
const DRY_RUN = arg('--dry-run') === true;  // log proposed mutations without writing
const NO_RESOLVE = arg('--no-resolve') === true; // skip web disambiguation in dedup
const RESOLVE_BUDGET = (() => { const v = arg('--resolve-budget'); return v && v !== true ? parseInt(v, 10) : 200; })();

const UA = 'OpenPizzaMap-enricher/0.2 (eric@openpizzamap.com)';
// Local fetch wrapper that pins the enricher's UA; keeps callers terse.
const fetchUA = (url, opts = {}, timeoutMs) => fetchWithTimeout(url, { ...opts, userAgent: UA }, timeoutMs);

// ─── PHASE 0: clean (decode lingering HTML entities in user-visible fields) ─
// Earlier importers escaped &rsquo;, &uuml;, etc. Stale rows still carry them
// (e.g. "Marco&rsquo;s Coal Fired", "Osnabr&uuml;ck"). This pass decodes them
// in-place. Idempotent — reruns are a no-op once everything's clean.
const CLEAN_PLACE_FIELDS = ['name', 'addressLine', 'city', 'region', 'descriptionHtml', 'seoTitle', 'seoDescription'];
async function phaseClean(prisma, report) {
  console.log('\n[clean] decoding HTML entities in stored text…');
  const all = await prisma.place.findMany({
    select: { id: true, name: true, addressLine: true, city: true, region: true, descriptionHtml: true, seoTitle: true, seoDescription: true },
  });
  let placeUpdates = 0, placeFieldsTouched = 0;
  for (const p of all) {
    const patch = {};
    for (const f of CLEAN_PLACE_FIELDS) {
      const v = p[f];
      if (typeof v !== 'string') continue;
      const decoded = decodeEntities(v);
      if (decoded !== v) { patch[f] = decoded; placeFieldsTouched++; }
    }
    if (!Object.keys(patch).length) continue;
    placeUpdates++;
    if (DRY_RUN) {
      const sample = Object.entries(patch)[0];
      console.log(`[clean:DRY] place #${p.id} ${Object.keys(patch).join(',')}: "${p[sample[0]]}" → "${sample[1]}"`);
    } else {
      await prisma.place.update({ where: { id: p.id }, data: patch });
    }
  }
  // Same for City rows so "Osnabrück" lands clean wherever it's referenced.
  const cities = await prisma.city.findMany({ select: { id: true, name: true } });
  let cityUpdates = 0;
  for (const c of cities) {
    if (typeof c.name !== 'string') continue;
    const decoded = decodeEntities(c.name);
    if (decoded === c.name) continue;
    cityUpdates++;
    if (DRY_RUN) console.log(`[clean:DRY] city #${c.id}: "${c.name}" → "${decoded}"`);
    else await prisma.city.update({ where: { id: c.id }, data: { name: decoded } });
  }
  report.clean = { placeUpdates, placeFieldsTouched, cityUpdates, dryRun: DRY_RUN };
  console.log(`[clean] done — ${placeUpdates} place rows touched (${placeFieldsTouched} fields), ${cityUpdates} city rows`);
}

// ─── PHASE 1: validate (kill city-center fallbacks) ─────────────────────────
async function phaseValidate(prisma, report) {
  console.log('\n[validate] scanning for coord collisions…');
  const all = await prisma.place.findMany({
    select: { id: true, name: true, city: true, lat: true, lng: true, isVisible: true, addressLine: true },
  });
  const byCoord = new Map();
  for (const r of all) {
    const k = r.lat.toString() + ',' + r.lng.toString();
    if (!byCoord.has(k)) byCoord.set(k, []);
    byCoord.get(k).push(r);
  }
  // Any coord with 3+ unrelated places is almost certainly a city-center
  // fallback. We hide every place there until they get a real address.
  const fallbackCoords = [...byCoord.entries()].filter(([, v]) => v.length >= 3);
  let hidden = 0;
  for (const [k, places] of fallbackCoords) {
    const ids = places.filter(p => p.isVisible).map(p => p.id);
    if (!ids.length) continue;
    const r = await prisma.place.updateMany({ where: { id: { in: ids } }, data: { isVisible: false } });
    hidden += r.count;
    console.log(`[validate] ${k} (${places[0].city}) — hid ${r.count}/${places.length} places`);
  }
  report.validate = { collisionPoints: fallbackCoords.length, placesHidden: hidden };
  console.log(`[validate] done — ${fallbackCoords.length} collision points, ${hidden} places hidden`);
}

// Extract a comparable street-address key. Returns { street, number } or null.
// "Via dei Tribunali 94"   → { street: 'tribunali', number: '94' }
// "Via Tribunali, 94"      → { street: 'tribunali', number: '94' }   ← dupe of above
// "Via Senese, 155r, 50124 Firenze FI" → { street: 'senese', number: '155r' }
// "via Tribunali, 31"      → { street: 'tribunali', number: '31' }   ← different number, NOT dupe
// "Piazza Sannazzaro"      → { street: 'sannazzaro', number: null }  ← partial, ambiguous
const STREET_TYPES = /\b(via|viale|vialetto|piazza|piazzale|p\.za|p\.zza|corso|largo|vicolo|strada|calle|carrer|carrera|rue|avenue|ave|av|boulevard|blvd|street|st|road|rd|drive|dr|lane|ln|place|pl|court|ct|square|sq)\b/g;
const ADDR_FILLER = /\b(the|la|le|il|los|las|de|del|della|dei|degli|di|du|des|el|en|a|al)\b/g;
function addressKey(line, cityName) {
  if (!line) return null;
  const norm = String(line).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[.,;:()]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!norm) return null;
  // First standalone 1–4 digit number, optional letter suffix (155r). Skip 5-digit postcodes.
  const numMatch = norm.match(/(?:^|\s)(\d{1,4})([a-z]?)(?=\s|$|\/)/);
  const number = numMatch ? (numMatch[1] + numMatch[2]) : null;
  let stripped = norm
    .replace(/\b\d{4,}\b/g, ' ')           // postal codes
    .replace(/\b\d{1,4}[a-z]?\b/g, ' ')    // any house numbers
    .replace(STREET_TYPES, ' ')
    .replace(ADDR_FILLER, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // Drop city tokens themselves (so "Firenze FI" doesn't end up as the street).
  if (cityName) {
    const cityTokens = String(cityName).toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length >= 3);
    if (cityTokens.length) {
      const re = new RegExp('\\b(' + cityTokens.join('|') + ')\\b', 'g');
      stripped = stripped.replace(re, ' ').replace(/\s+/g, ' ').trim();
    }
  }
  // Drop tokens ≤ 2 chars (state codes "FI", "WA"). Sort for order-invariance.
  const tokens = stripped.split(' ').filter(t => t.length >= 3);
  if (!tokens.length) return null;
  return { street: tokens.sort().join(' '), number };
}

// Normalize a city name for equality checks. Strips the Italian-province
// suffix "(LT)", "(MB)", etc. so "Gaeta (LT)" matches "Gaeta", which is the
// same source-data warts that bite the 50TP importer.
function normCity(c) {
  return String(c || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

// Extract a parenthetical/bracketed label from a raw name.
// "Tutta Bella (Columbia City)" → "columbia city"
// "Forno Rosso (Randolph St.)"  → "randolph st"
// "Plain Pizzeria"              → ''
function parenLabel(name) {
  if (!name) return '';
  const m = String(name).match(/[\(\[]([^\)\]]+)[\)\]]/);
  if (!m) return '';
  return m[1].toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Pair-classification verdict.
//   'merge-address' — both rows have full street+number, identical → safe auto-merge
//   'merge-orphan'  — one row has full address, the other has none, same name+city → auto-merge
//   'ambiguous'     — same street but at least one missing number, same name+city → web disambiguation
//   'skip'          — different addresses, or insufficient signal
function classifyPair(a, b) {
  const ka = addressKey(a.addressLine, a.city);
  const kb = addressKey(b.addressLine, b.city);
  const an = normalizeName(a.name);
  const bn = normalizeName(b.name);
  if (!an || !bn) return 'skip';

  // Hard reject: parenthetical branch labels (Tutta Bella "(Columbia City)" vs
  // "(Stone Way)" — both labelled differently means they're different branches.
  // Mixed labelled/unlabelled is also suspicious — the unlabelled one might be
  // a third branch or HQ, so we kick it to ambiguous review.
  const la = parenLabel(a.name), lb = parenLabel(b.name);
  if (la && lb && la !== lb) return 'skip';
  if ((la && !lb) || (!la && lb)) return 'ambiguous';

  // Name compatibility: identical OR token-subset (catches "Starita a Materdei"
  // ⊂ "Pizzeria Starita a Materdei"). Pizzeria/the/etc. already stripped by normalize.
  // BUT a digit-only token on either side ("La Notizia 94") is a hard differentiator
  // — chains often suffix branch numbers — so we reject mismatched digit tokens.
  const at = new Set(an.split(' ').filter(Boolean));
  const bt = new Set(bn.split(' ').filter(Boolean));
  const aDigits = [...at].filter(t => /^\d+$/.test(t));
  const bDigits = [...bt].filter(t => /^\d+$/.test(t));
  if (aDigits.join(' ') !== bDigits.join(' ')) return 'skip';
  const [small, big] = at.size <= bt.size ? [at, bt] : [bt, at];
  // Single-token subsets are too weak ("Salvo" ⊂ "Francesco & Salvatore Salvo"
  // — could be different establishments sharing a surname). Require size ≥ 2,
  // unless the names are exactly equal (e.g. Lucali/Lucali — same place,
  // double-geocoded).
  const tokenSubset = small.size >= 2 && [...small].every(t => big.has(t));
  const nameOK = an === bn || tokenSubset;
  if (!nameOK) return 'skip';

  // Tier 1: both addresses have street+number. Equal street+number = same place,
  // anywhere on the planet. Different number = different branch, no merge.
  if (ka?.number && kb?.number) {
    return (ka.street === kb.street && ka.number === kb.number) ? 'merge-address' : 'skip';
  }

  // Tier 2 / 3: only valid when the rows share a city.
  const sameCity = normCity(a.city) === normCity(b.city) && normCity(a.city).length > 0;
  if (!sameCity) return 'skip';

  // Tier 2: orphan twin — one row has full address, the other has no address at all.
  const aHasFull = !!(ka && ka.number);
  const bHasFull = !!(kb && kb.number);
  if ((aHasFull && !kb) || (bHasFull && !ka)) return 'merge-orphan';

  // Tier 3: same street, one or both missing number. Web disambiguation needed.
  if (ka && kb && ka.street === kb.street) return 'ambiguous';
  // One row has just a street name (no number) and the other has nothing.
  if ((ka && !ka.number && !kb) || (kb && !kb.number && !ka)) return 'ambiguous';

  return 'skip';
}

// ─── Web disambiguation for tier-3 ambiguous pairs ─────────────────────────
// Uses Nominatim's full-text search (the same OSM endpoint the importer geocodes
// with) to look up each venue by `name, city`. Returns the structured OSM
// address — house_number + road + postcode + country, parsed, no scraping
// fragility. Caches results so re-runs don't re-hit the network. Honors the
// project's existing 1.1s Nominatim throttle.
async function nominatimResolve(name, city) {
  const q = `${name}, ${city || ''}`.trim().replace(/^,\s*/, '');
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
              `&format=json&limit=1&addressdetails=1&namedetails=1`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 429) throw new Error('429');
    if (!res.ok) throw new Error(`http ${res.status}`);
    const arr = await res.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    const r = arr[0];
    const a = r.address || {};
    const houseNumber = a.house_number || null;
    const road = a.road || a.pedestrian || a.footway || null;
    if (!road) return null;
    const addressLine = houseNumber ? `${road}, ${houseNumber}` : road;
    return {
      canonical: addressLine,
      postalCode: a.postcode || null,
      region: a.state || a.region || null,
      country: a.country || null,
      lat: parseFloat(r.lat),
      lng: parseFloat(r.lon),
      display: r.display_name,
      osmType: r.osm_type,
      osmClass: r.class,
      type: r.type,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveCanonicalAddresses(places, ambiguous, report) {
  const cachePath = path.join(ROOT, 'dedup-web-cache.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch {}
  // Purge stale DDG-403 errors from prior run — Nominatim is a different beast.
  let purged = 0;
  for (const k of Object.keys(cache)) {
    if (cache[k] && cache[k].error && /ddg/i.test(cache[k].error)) { delete cache[k]; purged++; }
  }
  if (purged) console.log(`[dedup:resolve] purged ${purged} stale DDG entries from cache`);

  const cacheKey = (p) => `${normalizeName(p.name)}|${normCity(p.city)}`;
  const byKey = new Map();
  for (const [a, b] of ambiguous) {
    for (const p of [a, b]) {
      const k = cacheKey(p);
      if (!byKey.has(k)) byKey.set(k, p);
    }
  }
  const need = [...byKey.entries()].filter(([k]) => !cache[k]);
  console.log(`[dedup:resolve] ${byKey.size} unique venues across ambiguous pairs; ${need.length} need Nominatim lookup, ${byKey.size - need.length} cached`);

  let lookups = 0, hits = 0;
  for (const [k, p] of need) {
    if (lookups >= RESOLVE_BUDGET) {
      console.log(`[dedup:resolve] hit budget cap (${RESOLVE_BUDGET}); ${need.length - lookups} venues left for next run`);
      break;
    }
    lookups++;
    try {
      const r = await nominatimResolve(p.name, p.city);
      if (r && r.canonical) {
        hits++;
        cache[k] = {
          canonical: r.canonical,
          source: 'nominatim',
          jsonLd: {
            addressLine: r.canonical,
            postalCode: r.postalCode,
            region: r.region,
            phone: null,
            website: null,
            openingHours: null,
            heroImageUrl: null,
          },
          osm: { type: r.osmType, class: r.osmClass, kind: r.type, lat: r.lat, lng: r.lng, display: r.display },
          ts: Date.now(),
        };
      } else {
        cache[k] = { canonical: null, ts: Date.now() };
      }
    } catch (e) {
      cache[k] = { error: String(e.message || e), ts: Date.now() };
    }
    if (lookups % 10 === 0) {
      fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
      console.log(`[dedup:resolve] ${lookups}/${need.length} (hits: ${hits})`);
    }
    await sleep(1100); // Nominatim 1 req/sec policy + a hair
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
  console.log(`[dedup:resolve] ${lookups} venues queried, ${hits} canonical addresses found, cache → dedup-web-cache.json`);
  report.resolve = { unique: byKey.size, queried: lookups, hits };
  return cache;
}

// True when Nominatim's resolution for `row` is consistent with `row`'s existing
// DB address. We only validate when the DB has a full street+number — partial
// addresses can't disagree. Mismatches mean Nominatim is pointing at the wrong
// POI (the famous-Sorbillo trap: queries for "Gino Sorbillo" and "Gino e Toto
// Sorbillo" both return the same OSM result, but the DB row that has a full
// address proves Nominatim wrong.)
function nominatimMatchesDB(row, resolvedKey) {
  const dbKey = addressKey(row.addressLine, row.city);
  if (!dbKey?.number) return true;  // DB has nothing to disagree with
  return dbKey.street === resolvedKey.street && dbKey.number === resolvedKey.number;
}

// Decide a tier-3 pair's fate using the web cache.
//   'merge'    — both rows resolve to the same canonical address (or one matches
//                the other's existing address). Returns the canonical streetAddress
//                so the merge step can fill it on the canon row.
//   'branches' — both rows resolve, to different canonical addresses
//   'unknown'  — at least one row didn't resolve, OR Nominatim disagrees with a
//                row's existing full DB address; leave for manual review
function resolveVerdict(a, b, cache) {
  const ka = `${normalizeName(a.name)}|${normCity(a.city)}`;
  const kb = `${normalizeName(b.name)}|${normCity(b.city)}`;
  const ra = cache[ka], rb = cache[kb];
  const akey = ra?.canonical ? addressKey(ra.canonical, a.city) : null;
  const bkey = rb?.canonical ? addressKey(rb.canonical, b.city) : null;

  // Distrust check: if Nominatim's resolution for either row disagrees with
  // that row's DB full address, we can't trust the resolution at all.
  if (akey && !nominatimMatchesDB(a, akey)) return { verdict: 'unknown' };
  if (bkey && !nominatimMatchesDB(b, bkey)) return { verdict: 'unknown' };

  // Both resolved: same street+number → dupe; different → branches.
  if (akey?.number && bkey?.number) {
    if (akey.street === bkey.street && akey.number === bkey.number) {
      return { verdict: 'merge', canonical: ra.canonical, jsonLd: ra.jsonLd };
    }
    if (akey.street !== bkey.street) return { verdict: 'branches' };
    return { verdict: 'branches' };
  }
  // One resolved, the other didn't — compare the resolved canonical to the
  // unresolved row's existing address.
  const resolved = akey?.number ? { row: a, key: akey, canonical: ra.canonical, jsonLd: ra.jsonLd } :
                    bkey?.number ? { row: b, key: bkey, canonical: rb.canonical, jsonLd: rb.jsonLd } : null;
  if (!resolved) return { verdict: 'unknown' };
  const otherRow = resolved.row === a ? b : a;
  const otherKey = addressKey(otherRow.addressLine, otherRow.city);
  if (otherKey?.number && otherKey.street === resolved.key.street && otherKey.number === resolved.key.number) {
    return { verdict: 'merge', canonical: resolved.canonical, jsonLd: resolved.jsonLd };
  }
  if (otherKey?.number) return { verdict: 'branches' };
  return { verdict: 'merge', canonical: resolved.canonical, jsonLd: resolved.jsonLd };
}

// ─── PHASE 2: dedup (address-equality merge + web disambiguation) ──────────
async function phaseDedup(prisma, report) {
  console.log('\n[dedup] scanning for duplicates by address-equality…');
  const all = await prisma.place.findMany({
    include: { sources: true, styles: { include: { style: true } } },
  });

  // Tier-1 pairs are address-keyed (no spatial index needed — same street+number
  // anywhere is a dupe). Tier-2/3 pairs are scoped to same-city, so we bucket
  // by normalized city (province suffixes stripped) for those.
  const byCity = new Map();
  for (const p of all) {
    const c = normCity(p.city);
    if (!c) continue;
    if (!byCity.has(c)) byCity.set(c, []);
    byCity.get(c).push(p);
  }

  const parent = new Map(all.map(p => [p.id, p.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  // Tier 1 — global address-key bucket. Anywhere in the world, same street+number
  // and compatible name = dupe.
  const byAddrKey = new Map();
  for (const p of all) {
    const k = addressKey(p.addressLine, p.city);
    if (!k || !k.number) continue;
    const bk = `${k.street}|${k.number}`;
    if (!byAddrKey.has(bk)) byAddrKey.set(bk, []);
    byAddrKey.get(bk).push(p);
  }
  let tier1Links = 0;
  for (const group of byAddrKey.values()) {
    if (group.length < 2) continue;
    // Walk pairs and union those whose names are compatible (token-subset).
    for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) {
      if (classifyPair(group[i], group[j]) === 'merge-address') { union(group[i].id, group[j].id); tier1Links++; }
    }
  }

  // Tier 2/3 — same-city pairs. For tier-2 (orphan) we union immediately; for
  // tier-3 (ambiguous) we collect for later web disambiguation.
  let tier2Links = 0;
  const ambiguous = [];
  for (const cityRows of byCity.values()) {
    if (cityRows.length < 2) continue;
    for (let i = 0; i < cityRows.length; i++) for (let j = i + 1; j < cityRows.length; j++) {
      const verdict = classifyPair(cityRows[i], cityRows[j]);
      if (verdict === 'merge-orphan') { union(cityRows[i].id, cityRows[j].id); tier2Links++; }
      else if (verdict === 'ambiguous') ambiguous.push([cityRows[i], cityRows[j]]);
    }
  }
  console.log(`[dedup] tier-1 (address-equal): ${tier1Links} pairs linked`);
  console.log(`[dedup] tier-2 (orphan-twin):   ${tier2Links} pairs linked`);
  console.log(`[dedup] tier-3 (ambiguous):     ${ambiguous.length} pairs need disambiguation`);

  // Web disambiguation. Resolves canonical street addresses for venues in
  // ambiguous pairs, then re-classifies each pair: merge / branches / unknown.
  // Carries a JSON-LD payload alongside merge verdicts so the merge step can
  // backfill empty cells (address, phone, hours, image, website) on the canon.
  const enrichByCanon = new Map();  // canon-side place id → JSON-LD payload
  const stillAmbiguous = [];
  let tier3Links = 0, branchesDropped = 0;
  if (ambiguous.length && !NO_RESOLVE) {
    const cache = await resolveCanonicalAddresses(all, ambiguous, report);
    for (const [a, b] of ambiguous) {
      const r = resolveVerdict(a, b, cache);
      if (r.verdict === 'merge') {
        union(a.id, b.id);
        tier3Links++;
        // Stash the JSON-LD payload against BOTH ids — the merge step picks the
        // canon and reads its payload to backfill nulls.
        if (r.jsonLd) {
          enrichByCanon.set(a.id, r.jsonLd);
          enrichByCanon.set(b.id, r.jsonLd);
        }
      } else if (r.verdict === 'branches') {
        branchesDropped++;
      } else {
        stillAmbiguous.push([a, b]);
      }
    }
    console.log(`[dedup] tier-3 → merge: ${tier3Links}, branches: ${branchesDropped}, still ambiguous: ${stillAmbiguous.length}`);
    // Replace the ambiguous list with the unresolved residue so the candidates
    // file holds only what still needs human review.
    ambiguous.length = 0;
    ambiguous.push(...stillAmbiguous);
  } else if (NO_RESOLVE) {
    console.log(`[dedup] --no-resolve set; skipping web disambiguation`);
  }

  // Collect components.
  const groups = new Map();
  for (const p of all) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  let merges = [...groups.values()].filter(g => g.length > 1);

  // Integrity checks. Reject clusters that fail either:
  //   (a) 2+ rows with DIFFERENT full street+number addresses — transitive
  //       closure crossed a real-branch boundary (e.g. unlabelled "L'Antica
  //       Pizzeria" linking Baker Street + Soho via tier-2 orphan).
  //   (b) Rows have NO common name token after normalize — different venues
  //       converging on a parent OSM POI (e.g. Mercato Metropolitano food
  //       court, or Forno Rosso colliding with Sapori Napoletani because
  //       Nominatim returned the same address for both).
  const split = [];
  for (const cluster of merges) {
    const fullKeys = new Set();
    for (const p of cluster) {
      const k = addressKey(p.addressLine, p.city);
      if (k && k.number) fullKeys.add(`${k.street}|${k.number}`);
    }
    let nameIntersection = null;
    for (const p of cluster) {
      const tokens = new Set(normalizeName(p.name).split(' ').filter(Boolean));
      nameIntersection = nameIntersection === null ? tokens : new Set([...nameIntersection].filter(t => tokens.has(t)));
    }
    const addressOK = fullKeys.size <= 1;
    const nameOK = nameIntersection && nameIntersection.size > 0;
    if (addressOK && nameOK) { split.push(cluster); continue; }
    const reason = !addressOK ? `${fullKeys.size} distinct addresses` : `no common name token`;
    console.log(`[dedup] rejecting cluster of ${cluster.length} ("${cluster[0].name}") — ${reason}`);
    for (let i = 0; i < cluster.length; i++) for (let j = i + 1; j < cluster.length; j++) {
      ambiguous.push([cluster[i], cluster[j]]);
    }
  }
  merges = split;
  if (ambiguous.length) {
    const candPath = path.join(ROOT, 'dedup-candidates.json');
    fs.writeFileSync(candPath, JSON.stringify(ambiguous.map(([a, b]) => ({
      a: { id: a.id, name: a.name, city: a.city, addressLine: a.addressLine, lat: a.lat, lng: a.lng },
      b: { id: b.id, name: b.name, city: b.city, addressLine: b.addressLine, lat: b.lat, lng: b.lng },
    })), null, 2));
  }
  console.log(`[dedup] ${merges.length} merge clusters total (${ambiguous.length} pairs in dedup-candidates.json)`);

  // Choose canonical row per cluster (highest-source-count wins; ties → lowest id).
  let merged = 0, deleted = 0;
  for (const cluster of merges) {
    cluster.sort((x, y) => (y.sources.length - x.sources.length) || (x.id - y.id));
    const canon = cluster[0];
    const losers = cluster.slice(1);

    // Build a fill-only-if-null patch from the loser rows.
    const patch = {};
    const fillable = ['addressLine', 'region', 'postalCode', 'phone', 'websiteUrl', 'heroImageUrl', 'openingHours'];
    for (const loser of losers) {
      for (const f of fillable) {
        if (isEmpty(canon[f]) && !isEmpty(loser[f])) { patch[f] = loser[f]; canon[f] = loser[f]; }
      }
      // Upgrade coords ONLY if the canon had a fallback and loser has a non-fallback.
      // (We can't tell here without re-querying; safest is to leave coords alone.
      // The validate phase already hid fallback victims so they shouldn't surface.)
    }
    // Web-resolved canonical JSON-LD: backfill any cell still empty on the canon.
    // Maps schema.org names → Prisma names (only `website` differs from `websiteUrl`).
    const ld = enrichByCanon.get(canon.id);
    if (ld) {
      const ldFill = { addressLine: ld.addressLine, region: ld.region, postalCode: ld.postalCode,
                       phone: ld.phone, websiteUrl: ld.website, heroImageUrl: ld.heroImageUrl, openingHours: ld.openingHours };
      for (const [f, v] of Object.entries(ldFill)) {
        if (isEmpty(canon[f]) && !isEmpty(v)) { patch[f] = v; canon[f] = v; }
      }
    }
    // Merge styles as a union.
    const styleSet = new Set();
    for (const p of cluster) for (const ps of p.styles) styleSet.add(ps.style.slug);
    let prevStyles = [];
    try { prevStyles = JSON.parse(canon.stylesJson || '[]') || []; } catch {}
    const mergedStyles = [...new Set([...prevStyles, ...styleSet])];
    if (mergedStyles.length > prevStyles.length) patch.stylesJson = JSON.stringify(mergedStyles);

    if (DRY_RUN) {
      const loserSummary = losers.map(l => `#${l.id} "${l.name}"`).join(', ');
      const patchKeys = Object.keys(patch);
      console.log(`[dedup:DRY] would merge ${cluster.length} → "${canon.name}" (keep #${canon.id}); drop ${loserSummary}${patchKeys.length ? `; fill [${patchKeys.join(',')}]` : ''}`);
      merged++;
      deleted += losers.length;
      continue;
    }

    // Apply patch.
    if (Object.keys(patch).length) await prisma.place.update({ where: { id: canon.id }, data: patch });

    // Move sources from losers to canonical; delete losers.
    for (const loser of losers) {
      for (const s of loser.sources) {
        await prisma.placeSource.upsert({
          where: { placeId_source: { placeId: canon.id, source: s.source } },
          update: { rank: canon.sources.find(x => x.source === s.source) ? undefined : s.rank },
          create: { placeId: canon.id, source: s.source, rank: s.rank },
        });
      }
      // Move PlaceStyle entries (use createMany ignoreDuplicates if available; we just upsert each).
      for (const ps of loser.styles) {
        try {
          await prisma.placeStyle.create({ data: { placeId: canon.id, styleId: ps.styleId } });
        } catch { /* unique constraint — already attached */ }
      }
      // Delete loser. PlaceSource + PlaceStyle have onDelete: Cascade in schema.
      await prisma.place.delete({ where: { id: loser.id } });
      deleted++;
    }
    merged++;
    console.log(`[dedup] merged ${cluster.length} rows → "${canon.name}" (id=${canon.id}); deleted ${losers.length}`);
  }
  report.dedup = { clusters: merges.length, mergedInto: merged, deletedRows: deleted, dryRun: DRY_RUN };
  console.log(`[dedup] done — ${merged} clusters ${DRY_RUN ? 'would be merged' : 'merged'}, ${deleted} duplicate rows ${DRY_RUN ? 'would be deleted' : 'deleted'}`);
}

// ─── PHASE 3: overpass (OSM enrichment) ─────────────────────────────────────
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
];
let overpassEndpointIdx = 0;

async function overpassQuery(query, attempt = 1) {
  const url = OVERPASS_ENDPOINTS[overpassEndpointIdx % OVERPASS_ENDPOINTS.length];
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (r.status === 429 || r.status === 504) {
      if (attempt < 4) { overpassEndpointIdx++; await sleep(5000 * attempt); return overpassQuery(query, attempt + 1); }
      throw new Error(`overpass ${r.status}`);
    }
    if (!r.ok) throw new Error(`overpass ${r.status}`);
    return await r.json();
  } catch (e) {
    if (attempt < 3) { overpassEndpointIdx++; await sleep(2000 * attempt); return overpassQuery(query, attempt + 1); }
    throw e;
  }
}

function pickOsmMatch(osmElements, name, lat, lng) {
  if (!osmElements || !osmElements.length) return null;
  const wantedNorm = normalizeName(name);
  // Distinct name tokens we'd accept as a "yeah this is the same place" signal.
  // 4+ chars, drop the venue-noun stopwords already stripped by normalizeName.
  const tokens = wantedNorm.split(' ').filter(t => t.length >= 4);
  let best = null, bestScore = 0;
  for (const el of osmElements) {
    const elName = (el.tags && (el.tags.name || el.tags['name:en'] || el.tags.brand)) || '';
    if (!elName) continue;
    const elLat = el.lat || (el.center && el.center.lat);
    const elLng = el.lon || (el.center && el.center.lon);
    if (typeof elLat !== 'number' || typeof elLng !== 'number') continue;
    const dist = haversineM(lat, lng, elLat, elLng);
    if (dist > 500) continue;                          // raised from 250m — AVPN coords drift
    const elNorm = normalizeName(elName);
    const sim = jaroWinkler(wantedNorm, elNorm);
    // Accept if EITHER:
    //   (a) jaro-winkler ≥ 0.7 on full normalized names, OR
    //   (b) the FIRST 4+ char token of our name appears verbatim in the candidate.
    // Requiring the first token (not any) guards against false positives where
    // the venue happens to share a generic word with a neighbour ("Salvatore
    // alla Riviera" matching "Gran bar Riviera" because both contain "riviera").
    // The first distinguishing token is almost always the brand/owner/proper
    // noun, e.g. Mattozzi, Sorbillo, Kalò, Ciro.
    const tokenHit = tokens.length > 0 && elNorm.includes(tokens[0]);
    if (sim < 0.7 && !tokenHit) continue;
    // Score: prefer higher similarity AND closer distance.
    const score = Math.max(sim, tokenHit ? 0.75 : 0) - (dist / 10000);
    if (score > bestScore) { bestScore = score; best = el; }
  }
  return best;
}

function parseCuisineToStyles(cuisine) {
  const styles = inferStylesFromText(cuisine || '');
  // OSM uses semicolon-separated cuisine values. "pizza" alone doesn't tell us
  // a style, but "neapolitan_pizza" does — already covered by inferStylesFromText.
  return styles;
}

async function phaseOverpass(prisma, report) {
  console.log('\n[overpass] querying OSM for missing fields…');
  const targets = await prisma.place.findMany({
    where: {
      isVisible: true,
      OR: [{ websiteUrl: null }, { phone: null }, { openingHours: null }],
    },
    include: { sources: true, styles: { include: { style: true } } },
    orderBy: { id: 'asc' },
  });
  let work = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`[overpass] ${work.length} candidates (of ${targets.length} missing 1+ field)`);

  const styleByslug = new Map((await prisma.style.findMany()).map(s => [s.slug, s.id]));

  let hits = 0, miss = 0, fail = 0, fieldsFilled = 0;
  for (let i = 0; i < work.length; i++) {
    const p = work[i];
    const lat = parseFloat(p.lat), lng = parseFloat(p.lng);
    // Query: amenity=restaurant|fast_food|cafe within 600m. Pizzerias get tagged
    // inconsistently in OSM — a slice shop is often fast_food, an aperitivo
    // place might be cafe. Wider amenity net + wider radius dramatically improves
    // hit rate. The matcher does the actual disambiguation.
    const q = `[out:json][timeout:20];(node(around:600,${lat},${lng})[amenity~"restaurant|fast_food|cafe|bar|pub"];way(around:600,${lat},${lng})[amenity~"restaurant|fast_food|cafe|bar|pub"];);out tags center;`;
    let osm;
    try { osm = await overpassQuery(q); }
    catch (e) { fail++; console.warn(`[overpass] ${p.id} ${p.name}: ${e.message || e}`); await sleep(2000); continue; }

    const match = pickOsmMatch(osm.elements || [], p.name, lat, lng);
    if (!match) { miss++; if ((i + 1) % 10 === 0) console.log(`[overpass] ${i + 1}/${work.length} hit=${hits} miss=${miss} fail=${fail}`); await sleep(1200); continue; }

    const tags = match.tags || {};
    const patch = {};
    if (isEmpty(p.websiteUrl) && (tags.website || tags['contact:website'])) patch.websiteUrl = tags.website || tags['contact:website'];
    if (isEmpty(p.phone) && (tags.phone || tags['contact:phone'])) patch.phone = tags.phone || tags['contact:phone'];
    if (isEmpty(p.openingHours) && tags.opening_hours) patch.openingHours = tags.opening_hours;

    // Style hints from cuisine / description / name.
    const inferStyles = parseCuisineToStyles(`${tags.cuisine || ''} ${tags.description || ''} ${tags.name || ''}`);
    let prevStyles = [];
    try { prevStyles = JSON.parse(p.stylesJson || '[]') || []; } catch {}
    const newStyles = inferStyles.filter(s => !prevStyles.includes(s));
    if (newStyles.length) patch.stylesJson = JSON.stringify([...prevStyles, ...newStyles]);

    if (Object.keys(patch).length) {
      patch.enrichedAt = new Date();
      await prisma.place.update({ where: { id: p.id }, data: patch });
      fieldsFilled += Object.keys(patch).length - 1; // exclude enrichedAt
      // Attach new style rows.
      for (const slug of newStyles) {
        const sid = styleByslug.get(slug);
        if (!sid) continue;
        try { await prisma.placeStyle.create({ data: { placeId: p.id, styleId: sid } }); } catch {}
      }
      hits++;
    } else {
      miss++;
    }
    if ((i + 1) % 10 === 0 || i + 1 === work.length) {
      console.log(`[overpass] ${i + 1}/${work.length} hit=${hits} miss=${miss} fail=${fail} fieldsFilled=${fieldsFilled}`);
    }
    await sleep(1200);
  }
  report.overpass = { processed: work.length, hits, miss, fail, fieldsFilled };
  console.log(`[overpass] done — hits=${hits} miss=${miss} fail=${fail} fieldsFilled=${fieldsFilled}`);
}

// ─── PHASE 4: web (parse the venue's own homepage) ──────────────────────────
async function phaseWeb(prisma, report) {
  console.log('\n[web] fetching venue homepages for hours/style…');
  const targets = await prisma.place.findMany({
    where: {
      isVisible: true,
      websiteUrl: { not: null },
      OR: [{ openingHours: null }, { stylesJson: '[]' }],
    },
    orderBy: { id: 'asc' },
  });
  let work = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`[web] ${work.length} candidates`);

  const styleByslug = new Map((await prisma.style.findMany()).map(s => [s.slug, s.id]));

  let ok = 0, miss = 0, fail = 0, hoursFilled = 0, stylesFilled = 0;
  for (let i = 0; i < work.length; i++) {
    const p = work[i];
    let url = p.websiteUrl;
    if (!/^https?:\/\//.test(url)) url = 'http://' + url;
    let html;
    try {
      const r = await fetchWithTimeout(url, { accept: 'text/html' }, 20000);
      if (!r.ok) { fail++; continue; }
      html = await r.text();
    } catch (e) { fail++; continue; }

    const parsed = parseSchemaOrgFromHtml(html);
    const textStyles = inferStylesFromText(html.replace(/<[^>]+>/g, ' ').slice(0, 50000));
    const allInferredStyles = [...new Set([...parsed.styles, ...textStyles])];

    const patch = {};
    if (isEmpty(p.openingHours) && parsed.openingHours) { patch.openingHours = parsed.openingHours; hoursFilled++; }
    let prevStyles = [];
    try { prevStyles = JSON.parse(p.stylesJson || '[]') || []; } catch {}
    const newStyles = allInferredStyles.filter(s => !prevStyles.includes(s));
    if (newStyles.length) { patch.stylesJson = JSON.stringify([...prevStyles, ...newStyles]); stylesFilled++; }

    if (Object.keys(patch).length) {
      patch.enrichedAt = new Date();
      await prisma.place.update({ where: { id: p.id }, data: patch });
      for (const slug of newStyles) {
        const sid = styleByslug.get(slug);
        if (sid) { try { await prisma.placeStyle.create({ data: { placeId: p.id, styleId: sid } }); } catch {} }
      }
      ok++;
    } else { miss++; }
    if ((i + 1) % 25 === 0 || i + 1 === work.length) {
      console.log(`[web] ${i + 1}/${work.length} ok=${ok} miss=${miss} fail=${fail} hours=${hoursFilled} styles=${stylesFilled}`);
    }
    await sleep(800);
  }
  report.web = { processed: work.length, ok, miss, fail, hoursFilled, stylesFilled };
  console.log(`[web] done — ok=${ok} miss=${miss} fail=${fail} hours=${hoursFilled} styles=${stylesFilled}`);
}

// ─── PHASE 5: search (DuckDuckGo HTML to discover websites) ─────────────────
async function phaseSearch(prisma, report) {
  console.log('\n[search] discovering websites for places without one…');
  const targets = await prisma.place.findMany({
    where: { isVisible: true, websiteUrl: null },
    orderBy: { id: 'asc' },
  });
  let work = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log(`[search] ${work.length} candidates`);

  let found = 0, none = 0, fail = 0;
  for (let i = 0; i < work.length; i++) {
    const p = work[i];
    const q = `${p.name} ${p.city} pizza site`;
    let links;
    try { links = await ddgSearch(q); }
    catch (e) { fail++; await sleep(5000); continue; }
    const candidate = links.find(u => plausibleVenueUrl(u, p.name, p.city));
    if (candidate) {
      await prisma.place.update({ where: { id: p.id }, data: { websiteUrl: candidate, enrichedAt: new Date() } });
      found++;
    } else {
      none++;
    }
    if ((i + 1) % 10 === 0 || i + 1 === work.length) {
      console.log(`[search] ${i + 1}/${work.length} found=${found} none=${none} fail=${fail}`);
    }
    // DDG is strict — keep this slow.
    await sleep(2500);
  }
  report.search = { processed: work.length, found, none, fail };
  console.log(`[search] done — found=${found} none=${none} fail=${fail}`);
}

// ─── main ────────────────────────────────────────────────────────────────────
async function main() {
  const prisma = new PrismaClient();
  const report = { startedAt: new Date().toISOString() };
  const phases = ['clean', 'validate', 'dedup', 'overpass', 'web', 'search'];
  const toRun = PHASE && PHASE !== true ? [PHASE] : phases.filter(p => !SKIP.includes(p));

  console.log(`[enricher] running phases: ${toRun.join(', ')}${LIMIT ? ` (limit=${LIMIT} per phase)` : ''}`);

  try {
    if (toRun.includes('clean'))    await phaseClean(prisma, report);
    if (toRun.includes('validate')) await phaseValidate(prisma, report);
    if (toRun.includes('dedup'))    await phaseDedup(prisma, report);
    if (toRun.includes('overpass')) await phaseOverpass(prisma, report);
    if (toRun.includes('web'))      await phaseWeb(prisma, report);
    if (toRun.includes('search'))   await phaseSearch(prisma, report);
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    console.log(`\n[enricher] report → ${path.relative(ROOT, REPORT_FILE)}`);
    await prisma.$disconnect();
  }
}

main().catch(async (e) => { console.error(e); process.exit(1); });
