#!/usr/bin/env node
// Scrape Michelin Guide pizza listings.
// Source: https://guide.michelin.com/en/restaurants/pizza?showMap=true (paginated)
//
// Each card on the search page exposes everything inline as HTML data-attrs:
//   data-id, data-restaurant-name, data-restaurant-country, data-lat, data-lng,
//   data-dtm-city, data-dtm-district, data-dtm-region, data-dtm-distinction
//   ('', 'bib', '1 star', '2 stars', '3 stars'), data-dtm-price (CAT_P01..04),
//   plus an href to /en/<region>/<city>/restaurant/<slug>.
//
// No Cloudflare gate — plain Node fetch with a real User-Agent works fine.
// (Earlier handoff said "Cloudflare-gated"; that was wrong as of 2026-04-26.)
//
// Detail pages are walked for street address, phone, website, and hero image,
// which the search-page cards don't include. ~70 venues × 1 req @ 1.5s polite
// delay = ~2 minutes for the full run.
//
// Output: michelin-scrape.json at repo root, in the shape the importer expects.
//
// Usage:
//   node scripts/scrape-michelin.js [--no-detail] [--limit N]

const fs = require('fs');
const path = require('path');
const { ROOT, PATHS } = require('../lib/bootstrap');

const OUT_FILE = path.join(PATHS.scrapes, 'michelin-scrape.json');

const args = process.argv.slice(2);
const NO_DETAIL = args.includes('--no-detail');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : null;
})();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const BASE = 'https://guide.michelin.com';
const LIST_PATHS = [
  '/en/restaurants/pizza',
  '/en/restaurants/pizza/page/2',
  '/en/restaurants/pizza/page/3', // 404 today but cheap to probe in case the catalog grows
];
const LIST_DELAY_MS = 1500;
const DETAIL_DELAY_MS = 1500;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchHtml(url, attempt = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (res.status === 429) {
      if (attempt < 4) {
        await sleep(15000 * attempt);
        return fetchHtml(url, attempt + 1);
      }
      throw new Error('http 429');
    }
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3 && /timeout|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(String(e.message || e.name))) {
      await sleep(2000 * attempt);
      return fetchHtml(url, attempt + 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// Each card is anchored by `<div class="...card__menu...selection-card..." data-index="N" data-id="..." data-lat="..." data-lng="...">`
// We slice from one card-start to the next so detail extraction is bounded.
function parseListPage(html) {
  const cardStart = /<div\s+class="[^"]*card__menu[^"]*selection-card[^"]*"[^>]*data-index="\d+"[^>]*data-id="\d+"[^>]*data-lat="([^"]+)"[^>]*data-lng="([^"]+)"[^>]*>/g;
  const positions = [];
  let m;
  while ((m = cardStart.exec(html)) !== null) positions.push(m.index);

  const cards = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = i + 1 < positions.length ? positions[i + 1] : start + 8000;
    cards.push(extractCard(html.slice(start, end)));
  }
  return cards.filter(c => c && c.id && c.lat && c.lng);
}

function extractCard(slice) {
  const get = (re) => { const m = slice.match(re); return m ? decodeEntities(m[1]) : null; };
  const distinctionRaw = get(/data-dtm-distinction="([^"]*)"/) || '';
  const priceCat = get(/data-dtm-price="([^"]+)"/) || '';
  return {
    id: get(/data-id="(\d+)"/),
    name: get(/data-restaurant-name="([^"]+)"/),
    country: (get(/data-restaurant-country="([^"]+)"/) || '').toUpperCase() || null,
    lat: parseFloat(get(/data-lat="([^"]+)"/)),
    lng: parseFloat(get(/data-lng="([^"]+)"/)),
    city: get(/data-dtm-city="([^"]+)"/),
    district: get(/data-dtm-district="([^"]+)"/),
    region: get(/data-dtm-region="([^"]+)"/),
    distinction: distinctionRaw || null,                  // '' | 'bib' | '1 star' | '2 stars' | '3 stars' | 'recommended'
    priceLevel: priceCatToLevel(priceCat),                 // 1..4
    href: get(/href="(\/en\/[a-z0-9_\-\/]+\/restaurant\/[a-z0-9_\-]+)"/),
  };
}

function priceCatToLevel(cat) {
  // CAT_P01..CAT_P04 → 1..4. Default to 2 (mid-range) if absent.
  const m = String(cat || '').match(/CAT_P(\d+)/);
  if (!m) return 2;
  const n = parseInt(m[1], 10);
  return Math.min(Math.max(n, 1), 4);
}

// Detail page: street address, phone, website, hero image. Michelin's detail
// pages embed structured data via a JSON-LD <script type="application/ld+json">
// Restaurant block — that's the cleanest source.
function parseDetailPage(html) {
  const out = { addressLine: null, postalCode: null, phone: null, website: null, heroImageUrl: null };

  // JSON-LD Restaurant block — best source for address, postal, phone, image.
  // Deliberately ignore JSON-LD's `url` field: it's always Michelin's own page,
  // not the venue's website. We extract that from the page's outbound link.
  const ldMatches = [...html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];
  for (const m of ldMatches) {
    try {
      const obj = JSON.parse(m[1].trim());
      const items = Array.isArray(obj) ? obj : (obj['@graph'] || [obj]);
      for (const it of items) {
        const t = it && it['@type'];
        if (t === 'Restaurant' || t === 'FoodEstablishment' || t === 'LocalBusiness' || (Array.isArray(t) && t.includes('Restaurant'))) {
          const a = it.address || {};
          out.addressLine = out.addressLine || a.streetAddress || null;
          out.postalCode = out.postalCode || a.postalCode || null;
          out.phone = out.phone || it.telephone || null;
          if (Array.isArray(it.image) && it.image.length) out.heroImageUrl = out.heroImageUrl || it.image[0];
          else if (typeof it.image === 'string') out.heroImageUrl = out.heroImageUrl || it.image;
          else if (it.image && it.image.url) out.heroImageUrl = out.heroImageUrl || it.image.url;
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }

  // Real website link: Michelin renders it as an outbound <a> with class
  // `js-dtm-link`, target=_blank, rel=nofollow. Skip third-party booking
  // platforms (OpenTable, TheFork) and Michelin's own URLs.
  const linkRx = /<a\s+href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*class="[^"]*js-dtm-link[^"]*"/g;
  let lm;
  while ((lm = linkRx.exec(html)) !== null) {
    const u = lm[1];
    if (/(michelin\.com|opentable\.com|thefork|tablethotels|sevenrooms|resy\.com|chefspencil|bookatable|toptable)/i.test(u)) continue;
    out.website = u;
    break;
  }

  if (!out.phone) {
    const m = html.match(/href="tel:([^"]+)"/);
    if (m) out.phone = m[1];
  }
  if (!out.heroImageUrl) {
    // Open Graph image is reliable when JSON-LD is missing.
    const og = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
    if (og) out.heroImageUrl = og[1];
  }

  return out;
}

async function main() {
  // Pass 1: walk list pages, dedupe cards by data-id (cards reappear across
  // pages because of "Discover the nearest" and "newly added" sidebars).
  const byId = new Map();
  for (const p of LIST_PATHS) {
    const url = BASE + p;
    process.stdout.write(`[list] GET ${url}\n`);
    let html;
    try { html = await fetchHtml(url); }
    catch (e) {
      console.warn(`[list] ${p} failed: ${e.message || e}`);
      continue;
    }
    if (!html) { console.warn(`[list] ${p} 404 — skipping`); continue; }
    const cards = parseListPage(html);
    console.log(`[list] ${p} → ${cards.length} cards`);
    for (const c of cards) {
      if (!byId.has(c.id)) byId.set(c.id, c);
    }
    await sleep(LIST_DELAY_MS);
  }
  let cards = [...byId.values()];
  console.log(`[list] ${cards.length} unique venues across all pages`);
  if (LIMIT) cards = cards.slice(0, LIMIT);

  // Pass 2: detail-page enrichment for street address, phone, website, image.
  if (!NO_DETAIL) {
    let ok = 0, fail = 0;
    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      if (!c.href) { c.detailError = 'no-href'; fail++; continue; }
      const url = BASE + c.href;
      try {
        const html = await fetchHtml(url);
        if (!html) { c.detailError = 'http-404'; fail++; }
        else { c.detail = parseDetailPage(html); ok++; }
      } catch (e) {
        c.detailError = String(e.message || e);
        fail++;
      }
      if ((i + 1) % 10 === 0 || i + 1 === cards.length) {
        process.stdout.write(`[detail] ${i + 1}/${cards.length} ok=${ok} fail=${fail}\n`);
        // Save incrementally so a mid-run crash doesn't lose progress.
        fs.writeFileSync(OUT_FILE, JSON.stringify({ source: 'michelin', scrapedAt: new Date().toISOString(), places: cards }, null, 2));
      }
      await sleep(DETAIL_DELAY_MS);
    }
    console.log(`[detail] done ok=${ok} fail=${fail}`);
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ source: 'michelin', scrapedAt: new Date().toISOString(), places: cards }, null, 2));
  console.log(`[done] wrote ${cards.length} venues → ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
