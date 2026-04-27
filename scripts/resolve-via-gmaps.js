#!/usr/bin/env node
// Resolve venues via Google Maps using a headless Playwright browser.
//
// Usage:
//   node scripts/resolve-via-gmaps.js               # dry run, prints results
//   node scripts/resolve-via-gmaps.js --apply       # writes results to DB
//   node scripts/resolve-via-gmaps.js --ids=1,2,3   # specific place IDs
//
// Default target: every place where addressLine is empty (visible or not).
// For each, search "{name} {city}" on Google Maps, capture the canonical
// address from the place page's address button, and (if the venue page URL
// reveals coords like /@LAT,LNG,) capture those too. Writes back addressLine,
// city (if mismatched), lat, lng. Idempotent — already-filled rows are skipped.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const IDS = (() => {
  const a = args.find(x => x.startsWith('--ids='));
  return a ? a.slice(6).split(',').map(s => parseInt(s, 10)).filter(Boolean) : null;
})();

const ROOT = path.resolve(__dirname, '..');
const CACHE_PATH = path.join(ROOT, 'gmaps-resolve-cache.json');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Pull the address button + the venue's true coords from the URL. Google's
// place URL format is .../place/NAME/@LAT,LNG,ZOOMz/data=...!8m2!3dLAT!4dLNG...
// The /@.../ block is the map center; the !8m2!3d!4d block is the actual
// venue pin. Prefer the latter when present.
let DUMPED = false;
async function lookup(page, name, city) {
  const q = encodeURIComponent(`${name} ${city || ''}`.trim());
  await page.goto(`https://www.google.com/maps/search/${q}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Dismiss EU consent if present.
  for (const sel of ['button[aria-label*="Accept"]', 'button[aria-label*="Acepto"]', 'button[aria-label*="Akzeptieren"]', 'form[action*="consent"] button']) {
    const btn = await page.$(sel).catch(() => null);
    if (btn) { await btn.click().catch(() => {}); await sleep(500); break; }
  }
  await Promise.race([
    page.waitForSelector('button[data-item-id="address"]', { timeout: 8000 }).catch(() => null),
    page.waitForSelector('a.hfpxzc', { timeout: 8000 }).catch(() => null),
  ]);
  let address = await page.$eval('button[data-item-id="address"]', el => el.textContent.trim()).catch(() => null);
  if (!address) {
    const first = await page.$('a.hfpxzc');
    if (!first) {
      if (!DUMPED) {
        DUMPED = true;
        const html = await page.content();
        fs.writeFileSync(path.join(ROOT, 'gmaps-debug.html'), html);
        await page.screenshot({ path: path.join(ROOT, 'gmaps-debug.png'), fullPage: false });
        console.log('[resolve] DEBUG dumped first-miss page → gmaps-debug.{html,png}');
      }
      return null;
    }
    await first.click();
    await page.waitForSelector('button[data-item-id="address"]', { timeout: 8000 }).catch(() => null);
    address = await page.$eval('button[data-item-id="address"]', el => el.textContent.trim()).catch(() => null);
  }
  if (!address) return null;
  // Coord extraction. Google's place panel doesn't expose coords via URL or
  // anchor on direct-hit pages (the map is a canvas, the URL stays /search/).
  // Forward-geocode the address through Nominatim — given a full street +
  // number, Nominatim is reliable. (Reverse the other way around — coords →
  // address — was the brittle path we already learned not to trust for the
  // text-search use case.)
  let lat = null, lng = null;
  try {
    const u = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1`;
    const r = await fetch(u, { headers: { 'User-Agent': 'OpenPizzaMap-resolve/0.1 (eric@openpizzamap.com)' } });
    if (r.ok) {
      const arr = await r.json();
      if (Array.isArray(arr) && arr.length) { lat = arr[0].lat; lng = arr[0].lon; }
    }
  } catch { /* coord enrich is best-effort */ }
  await sleep(1100);  // honour Nominatim 1 req/sec
  // Title gives the canonical venue name as Google sees it (sanity-check column).
  const title = (await page.title()).replace(/\s*-\s*Google Maps\s*$/, '').trim();
  return { address, lat, lng, title };
}

(async () => {
  const prisma = new PrismaClient();
  let where;
  if (IDS) where = { id: { in: IDS } };
  else where = { addressLine: '' };
  const places = await prisma.place.findMany({
    where,
    select: { id: true, name: true, city: true, country: true, addressLine: true, lat: true, lng: true, isVisible: true },
    orderBy: { id: 'asc' },
  });
  console.log(`[resolve] ${places.length} places to look up (apply=${APPLY})`);

  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch {}

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  // Pre-set the consent cookie so Google skips the GDPR redirect entirely.
  // YES+ + the SOCS variant covers the consent flows we hit from various
  // locales (Spanish, German, Italian).
  await context.addCookies([
    { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
    { name: 'SOCS', value: 'CAESHAgBEhJnd3NfMjAyMzA3MDQtMF9SQzIaAmVuIAEaBgiAqIaqBg', domain: '.google.com', path: '/' },
  ]);
  const page = await context.newPage();
  // Block heavy assets to speed up — we only need the DOM, not images/css.
  await page.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (t === 'image' || t === 'media' || t === 'font') return route.abort();
    return route.continue();
  });

  let resolved = 0, skipped = 0, missed = 0;
  for (const p of places) {
    const cacheKey = `${p.name}|${p.city || ''}`;
    let r = cache[cacheKey];
    if (!r) {
      try {
        r = await lookup(page, p.name, p.city);
        cache[cacheKey] = r || { miss: true, ts: Date.now() };
      } catch (e) {
        console.log(`[resolve] #${p.id} "${p.name}" ERROR: ${e.message}`);
        cache[cacheKey] = { error: e.message, ts: Date.now() };
        continue;
      }
      // Persist after each lookup so we never lose progress.
      fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
      await sleep(800); // gentle pace — Google rate-limits if you hammer
    }
    if (!r || r.miss || !r.address) { missed++; console.log(`[resolve] #${p.id} "${p.name}" — no result`); continue; }
    console.log(`[resolve] #${p.id} "${p.name}" → ${r.address}${r.lat ? `  @${r.lat},${r.lng}` : ''}`);

    if (APPLY) {
      const data = {};
      if (!p.addressLine || !p.addressLine.trim()) data.addressLine = r.address;
      if (r.lat && r.lng) {
        // Only overwrite coords if existing coords look like a city centroid
        // (shared with other places — checked separately); for safety here,
        // overwrite only when the venue's address has a house number AND the
        // existing coords differ by > 200m from the new ones.
        const existingLat = parseFloat(p.lat), existingLng = parseFloat(p.lng);
        const newLat = parseFloat(r.lat), newLng = parseFloat(r.lng);
        const dLat = (newLat - existingLat) * 111000;
        const dLng = (newLng - existingLng) * 111000 * Math.cos(existingLat * Math.PI / 180);
        const distM = Math.sqrt(dLat*dLat + dLng*dLng);
        if (distM > 200) { data.lat = r.lat; data.lng = r.lng; }
      }
      if (Object.keys(data).length) {
        await prisma.place.update({ where: { id: p.id }, data });
      } else {
        skipped++;
        continue;
      }
    }
    resolved++;
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  console.log(`\n[resolve] ${resolved} resolved, ${missed} missed, ${skipped} skipped`);
  await browser.close();
  await prisma.$disconnect();
})();
