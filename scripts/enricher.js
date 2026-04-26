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
  sleep, isEmpty,
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
const PHASE = arg('--phase');               // null | 'validate' | 'dedup' | 'overpass' | 'web' | 'search'
const SKIP = argMulti('--skip') || [];      // ['search', 'web']
const LIMIT = (() => { const v = arg('--limit'); return v && v !== true ? parseInt(v, 10) : null; })();

const UA = 'OpenPizzaMap-enricher/0.2 (eric@openpizzamap.com)';
// Local fetch wrapper that pins the enricher's UA; keeps callers terse.
const fetchUA = (url, opts = {}, timeoutMs) => fetchWithTimeout(url, { ...opts, userAgent: UA }, timeoutMs);

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

// ─── PHASE 2: dedup (coord-radius + name-similarity merge) ──────────────────
async function phaseDedup(prisma, report) {
  console.log('\n[dedup] scanning for nearby duplicates…');
  const all = await prisma.place.findMany({
    include: { sources: true, styles: { include: { style: true } } },
  });
  // Index by city+rough-grid so we don't compare every pair.
  const grid = new Map();
  const KEY = (lat, lng) => `${Math.round(parseFloat(lat) * 1000)},${Math.round(parseFloat(lng) * 1000)}`; // ~110m cells
  for (const p of all) {
    const k = KEY(p.lat, p.lng);
    // Add the cell + its 8 neighbours to widen the search window.
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const [a, b] = k.split(',').map(Number);
      const nk = `${a + di},${b + dj}`;
      if (!grid.has(nk)) grid.set(nk, []);
    }
    grid.get(k).push(p);
  }

  // Build connected components by linking pairs that satisfy: distance ≤ 100m
  // AND normalized-name similarity ≥ 0.85.
  const parent = new Map(all.map(p => [p.id, p.id]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const seenPairs = new Set();
  let comparisons = 0, links = 0;
  for (const [k, cell] of grid) {
    if (!cell.length) continue;
    // Compare every place in this cell against every place in this+adjacent cells.
    const [ai, aj] = k.split(',').map(Number);
    const neighbourPlaces = [];
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      const nk = `${ai + di},${aj + dj}`;
      const c = grid.get(nk);
      if (c) for (const p of c) neighbourPlaces.push(p);
    }
    for (const a of cell) {
      const an = normalizeName(a.name);
      if (!an) continue;
      for (const b of neighbourPlaces) {
        if (a.id >= b.id) continue;
        const pk = `${a.id}|${b.id}`;
        if (seenPairs.has(pk)) continue;
        seenPairs.add(pk);
        comparisons++;
        const d = haversineM(parseFloat(a.lat), parseFloat(a.lng), parseFloat(b.lat), parseFloat(b.lng));
        if (d > 100) continue;
        const bn = normalizeName(b.name);
        if (!bn) continue;
        const sim = jaroWinkler(an, bn);
        if (sim < 0.85) continue;
        union(a.id, b.id);
        links++;
      }
    }
  }
  // Collect components.
  const groups = new Map();
  for (const p of all) {
    const r = find(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }
  const merges = [...groups.values()].filter(g => g.length > 1);
  console.log(`[dedup] ${comparisons} pairs compared, ${links} links, ${merges.length} merge clusters`);

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
    // Merge styles as a union.
    const styleSet = new Set();
    for (const p of cluster) for (const ps of p.styles) styleSet.add(ps.style.slug);
    let prevStyles = [];
    try { prevStyles = JSON.parse(canon.stylesJson || '[]') || []; } catch {}
    const mergedStyles = [...new Set([...prevStyles, ...styleSet])];
    if (mergedStyles.length > prevStyles.length) patch.stylesJson = JSON.stringify(mergedStyles);

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
  report.dedup = { clusters: merges.length, mergedInto: merged, deletedRows: deleted };
  console.log(`[dedup] done — ${merged} clusters merged, ${deleted} duplicate rows deleted`);
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
  const phases = ['validate', 'dedup', 'overpass', 'web', 'search'];
  const toRun = PHASE && PHASE !== true ? [PHASE] : phases.filter(p => !SKIP.includes(p));

  console.log(`[enricher] running phases: ${toRun.join(', ')}${LIMIT ? ` (limit=${LIMIT} per phase)` : ''}`);

  try {
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
