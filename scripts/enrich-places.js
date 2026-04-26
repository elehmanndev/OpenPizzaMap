#!/usr/bin/env node
// Enricher for OpenPizzaMap places that are missing coordinates, address,
// phone, website, or hero image. Two passes:
//
//   1. AVPN re-scrape — for any avpn-sourced place that came back blank
//      (HTTP 429 rate-limit during the original scrape, or detail-page parse
//      failure), re-fetch the AVPN detail URL with a long, polite delay so
//      we don't get banned. Writes results into avpn-scrape.json (idempotent
//      merge by detailUrl), then re-runs the importer's normalize+upsert path
//      to backfill DB rows.
//
//   2. Nominatim geocode — for any DB place that still has no lat/lng but
//      DOES have a street address line + city + country, query Nominatim
//      with the same multi-strategy as the importer and update the row.
//
// Usage:
//   node scripts/enrich-places.js              # both passes
//   node scripts/enrich-places.js --avpn-only  # just re-scrape failures
//   node scripts/enrich-places.js --geo-only   # just geocode pass
//   node scripts/enrich-places.js --limit N    # cap each pass at N items
//
// Designed to run unattended for ~10–20 minutes. Polite delays (2s for AVPN,
// 1.1s for Nominatim) keep us under each service's published rate limits.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const AVPN_FILE = path.join(ROOT, 'avpn-scrape.json');
const CACHE_FILE = path.join(ROOT, 'geocode-cache.json');

const args = process.argv.slice(2);
const AVPN_ONLY = args.includes('--avpn-only');
const GEO_ONLY = args.includes('--geo-only');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : null;
})();

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const AVPN_DELAY_MS = 2000;   // back off from the 250ms that triggered 429s
const NOMINATIM_DELAY_MS = 1100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- shared with scrape-avpn.js (kept inline to avoid module bloat) ----
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&agrave;/g, 'à').replace(/&egrave;/g, 'è').replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò').replace(/&ugrave;/g, 'ù')
    .replace(/&eacute;/g, 'é').replace(/&aacute;/g, 'á').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ').replace(/&ccedil;/g, 'ç')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ''));
const collapseWs = (s) => String(s || '').replace(/\s+/g, ' ').trim();

async function fetchHtml(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    if (res.status === 429) {
      // Rate-limited despite delay — back off harder.
      if (attempt < 4) {
        await sleep(10000 * attempt);
        return fetchHtml(url, attempt + 1);
      }
      throw new Error('http 429');
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3 && !/http \d/.test(String(e.message))) {
      await sleep(2000 * attempt);
      return fetchHtml(url, attempt + 1);
    }
    throw e;
  }
}

function parseAvpnDetail(html) {
  const out = {
    addressLine: null, postalCode: null, cityFull: null, regionFull: null, countryFull: null,
    phone: null, fax: null, email: null, website: null,
    heroImageUrl: null, lat: null, lng: null,
    memberSince: null,
  };
  const contattiMatch = html.match(/<h4>\s*Contatti[\s\S]*?<\/h4>\s*<hr[^>]*>\s*<p>([\s\S]*?)<\/p>/i);
  if (contattiMatch) {
    const block = stripTags(contattiMatch[1]).replace(/\s+/g, ' ').trim();
    const parts = block.split('/').map(s => s.trim()).filter(Boolean);
    out.countryFull = parts.length > 1 ? parts[parts.length - 1] : null;
    const left = parts[0] || block;
    const pcMatch = left.match(/\b(\d{4,6})\b/);
    if (pcMatch) {
      out.postalCode = pcMatch[1];
      out.addressLine = collapseWs(left.slice(0, pcMatch.index).replace(/[,\s]+$/, ''));
      const tail = collapseWs(left.slice(pcMatch.index + pcMatch[1].length));
      const tailTokens = tail.split(/\s+/).filter(Boolean);
      if (tailTokens.length >= 2) {
        out.regionFull = tailTokens[tailTokens.length - 1];
        out.cityFull = tailTokens.slice(0, -1).join(' ');
      } else if (tailTokens.length === 1) {
        out.cityFull = tailTokens[0];
      }
    } else {
      out.addressLine = left;
    }
  }
  const phoneMatch = html.match(/Tel:\s*([+0-9 .\-/()]+)/i);
  if (phoneMatch) out.phone = collapseWs(phoneMatch[1]).replace(/\s+/g, '');
  const webMatch = html.match(/<a\s+href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*>\s*www\./i);
  if (webMatch) out.website = webMatch[1];
  const heroMatch = html.match(/<img[^>]+src="(https:\/\/www\.pizzanapoletana\.org\/public\/assoc\/[^"]+)"/i);
  if (heroMatch) out.heroImageUrl = heroMatch[1];
  const embedMatch = html.match(/google\.com\/maps\/embed\?[^"]*?!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (embedMatch) {
    out.lng = parseFloat(embedMatch[1]);
    out.lat = parseFloat(embedMatch[2]);
  }
  return out;
}

// ---- pass 1: re-scrape AVPN failures, then re-run importer ----
async function passAvpnRescrape() {
  if (!fs.existsSync(AVPN_FILE)) {
    console.log('[avpn] no avpn-scrape.json, skipping');
    return;
  }
  const data = JSON.parse(fs.readFileSync(AVPN_FILE, 'utf8'));
  const targets = data.places.filter(p => p.detailError || !p.detail || p.detail.lat == null);
  let work = targets;
  if (LIMIT) work = work.slice(0, LIMIT);
  if (work.length === 0) {
    console.log('[avpn] no failed/incomplete records to retry');
    return;
  }
  console.log(`[avpn] retrying ${work.length} detail pages (delay=${AVPN_DELAY_MS}ms, serial)`);

  let recovered = 0, stillBlank = 0, failed = 0;
  for (let i = 0; i < work.length; i++) {
    const row = work[i];
    try {
      const html = await fetchHtml(row.detailUrl);
      const detail = parseAvpnDetail(html);
      // Mutate the original record in `data.places` (work[i] is the same object).
      row.detail = {
        ...detail,
        addressLine: detail.addressLine ? decodeEntities(detail.addressLine) : null,
        cityFull: detail.cityFull ? decodeEntities(detail.cityFull) : null,
      };
      row.detailError = null;
      if (detail.lat != null) recovered++;
      else stillBlank++;
    } catch (e) {
      row.detailError = String(e.message || e);
      failed++;
    }
    if ((i + 1) % 10 === 0 || i + 1 === work.length) {
      process.stdout.write(`\r[avpn] ${i + 1}/${work.length} recovered=${recovered} blank=${stillBlank} failed=${failed}   `);
      fs.writeFileSync(AVPN_FILE, JSON.stringify(data, null, 2));
    }
    await sleep(AVPN_DELAY_MS);
  }
  process.stdout.write('\n');
  fs.writeFileSync(AVPN_FILE, JSON.stringify(data, null, 2));
  console.log(`[avpn] done: recovered=${recovered} blank=${stillBlank} failed=${failed}`);

  if (recovered > 0) {
    console.log('[avpn] re-running importer to upsert recovered places...');
    const { spawnSync } = require('child_process');
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/import-places.js'), '--no-geocode'], { stdio: 'inherit' });
    if (r.status !== 0) console.warn('[avpn] importer exited non-zero');

    const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/seed-styles.js')], { stdio: 'inherit' });
    if (r2.status !== 0) console.warn('[avpn] seed-styles exited non-zero');

    const r3 = spawnSync(process.execPath, [path.join(ROOT, 'scripts/flip-avpn-visible.js')], { stdio: 'inherit' });
    if (r3.status !== 0) console.warn('[avpn] flip-avpn-visible exited non-zero');
  }
}

// ---- pass 2: geocode DB places that have address but no lat/lng ----
function loadCache() {
  if (!fs.existsSync(CACHE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(cache) {
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}
async function nominatimLookup(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const r = arr[0];
  return { lat: parseFloat(r.lat), lng: parseFloat(r.lon), display: r.display_name };
}

function buildGeoQueries(p) {
  const al = (p.addressLine || '').trim();
  const out = [];
  if (al) {
    if (al.includes(',')) {
      out.push(al);
      out.push(`${al}, ${p.country}`);
      const head = al.split(',').slice(0, 2).join(',').trim();
      if (head && head !== al) out.push([head, p.city, p.country].filter(Boolean).join(', '));
    } else {
      out.push([al, p.city, p.country].filter(Boolean).join(', '));
    }
  }
  out.push([p.city, p.country].filter(Boolean).join(', '));
  return [...new Set(out.filter(Boolean))];
}

async function passGeocode() {
  const prisma = new PrismaClient();
  // Pull places with no coords. Include those with isVisible=false too — backfilling
  // their coords is what would let us flip them visible later.
  const targets = await prisma.place.findMany({
    where: {
      OR: [{ lat: null }, { lng: null }, { lat: 0, lng: 0 }],
    },
    select: { id: true, name: true, addressLine: true, city: true, country: true, lat: true, lng: true },
  });
  let work = targets.filter(t => t.addressLine && t.city && t.country);
  if (LIMIT) work = work.slice(0, LIMIT);
  if (work.length === 0) {
    console.log('[geo] nothing to geocode');
    await prisma.$disconnect();
    return;
  }
  console.log(`[geo] attempting ${work.length} places (delay=${NOMINATIM_DELAY_MS}ms)`);

  const cache = loadCache();
  let hit = 0, miss = 0, fromCache = 0, errs = 0;
  for (let i = 0; i < work.length; i++) {
    const p = work[i];
    const queries = buildGeoQueries(p);
    let result = null;
    for (const q of queries) {
      if (q in cache) {
        if (cache[q] && cache[q].lat != null) { result = cache[q]; fromCache++; break; }
        continue;
      }
      try {
        const r = await nominatimLookup(q);
        cache[q] = r ? { lat: r.lat, lng: r.lng, display: r.display } : null;
        saveCache(cache);
        if (r) { result = r; hit++; break; }
      } catch (e) {
        errs++;
      }
      await sleep(NOMINATIM_DELAY_MS);
    }
    if (result) {
      try {
        await prisma.place.update({
          where: { id: p.id },
          data: { lat: result.lat, lng: result.lng },
        });
      } catch (e) {
        console.warn(`[geo] update failed for id=${p.id}: ${e.message}`);
      }
    } else {
      miss++;
    }
    if ((i + 1) % 10 === 0 || i + 1 === work.length) {
      process.stdout.write(`\r[geo] ${i + 1}/${work.length} hit=${hit} cache=${fromCache} miss=${miss} errs=${errs}   `);
    }
  }
  process.stdout.write('\n');
  console.log(`[geo] done: hit=${hit} cache=${fromCache} miss=${miss} errs=${errs}`);
  await prisma.$disconnect();
}

(async () => {
  if (!GEO_ONLY) await passAvpnRescrape();
  if (!AVPN_ONLY) await passGeocode();
})().catch(e => { console.error(e); process.exit(1); });
