#!/usr/bin/env node
// Download remote pizzeria images to local Hostinger storage and rewrite
// Place.heroImageUrl to point at the local copy. Removes the cross-origin
// Referer leak that would otherwise tell thegreat.pizza / AVPN / Eater that
// we're hotlinking their images on every map view.
//
// Two source streams:
//   1. DB Place rows whose heroImageUrl is currently an absolute URL → fetch
//      that URL directly.
//   2. Scrape JSONs (eater-scrape, avpn-scrape) for places whose DB row has no
//      heroImageUrl yet → match by dedupKey, fetch the scrape image URL.
//
// Files land at: public/uploads/places/{placeId}.{ext}
// DB heroImageUrl becomes: /uploads/places/{placeId}.{ext}
// Idempotent: skips rows where heroImageUrl already starts with '/uploads/'.
//
// Run on Hostinger directly (SSH) so files land in the live filesystem. If you
// run it locally, the files are saved to your repo's public/uploads/places/
// and you'll need to sync them up — e.g. by committing them or via SFTP.
//
// Usage:
//   node scripts/download-images.js                # process every eligible place
//   node scripts/download-images.js --limit 50     # try only 50
//   node scripts/download-images.js --skip-existing-hotlinks   # only fill nulls

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'public', 'uploads', 'places');
fs.mkdirSync(OUT_DIR, { recursive: true });

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : null;
})();
const SKIP_EXISTING_HOTLINKS = args.includes('--skip-existing-hotlinks');

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const CONCURRENCY = 4;
const DELAY_MS = 250;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---- city canonicalization (mirrors import-places.js) ----
const CITY_NAME_CANON = {
  roma: 'Rome', napoli: 'Naples', firenze: 'Florence', milano: 'Milan',
  torino: 'Turin', genova: 'Genoa', wien: 'Vienna',
};
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
function canonCity(city) {
  const s = decodeEntities(String(city || '')).trim();
  if (!s) return null;
  return CITY_NAME_CANON[s.toLowerCase()] || s;
}
function dedupKey(name, city) {
  return slugify(decodeEntities(name)) + '|' + slugify(canonCity(city) || city || '');
}

// ---- scrape lookup ----
// Walks every scrape JSON at repo root and builds dedupKey → first-seen image URL.
function loadScrapeImages() {
  const out = new Map();
  const add = (k, url) => { if (k && url && !out.has(k)) out.set(k, url); };

  const eaterFile = path.join(ROOT, 'eater-scrape.json');
  if (fs.existsSync(eaterFile)) {
    const d = JSON.parse(fs.readFileSync(eaterFile, 'utf8'));
    for (const p of d.places) if (p.image) add(dedupKey(p.name, p.city_hint), p.image);
  }
  const avpnFile = path.join(ROOT, 'avpn-scrape.json');
  if (fs.existsSync(avpnFile)) {
    const d = JSON.parse(fs.readFileSync(avpnFile, 'utf8'));
    for (const p of d.places) {
      const img = p.detail && p.detail.heroImageUrl;
      if (img) add(dedupKey(p.name, p.city), img);
    }
  }
  // thegreat.pizza shape: { data: [{ name, image, address: { locality } }] }
  const greatFile = path.join(ROOT, 'scrape-result.json');
  if (fs.existsSync(greatFile)) {
    const d = JSON.parse(fs.readFileSync(greatFile, 'utf8'));
    for (const p of d.data || []) {
      const img = p.image;
      const city = p.address && p.address.locality;
      if (img) add(dedupKey(p.name, city), img);
    }
  }
  // TasteAtlas shape: { places: [{ name, city, image_url|image }] }
  for (const f of fs.readdirSync(ROOT)) {
    if (!f.startsWith('tasteatlas-') || !f.endsWith('.json')) continue;
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const p of d.places || []) {
      const img = p.image_url || p.image;
      if (img) add(dedupKey(p.name, p.city), img);
    }
  }
  return out;
}

// ---- download one image ----
function extFromContentType(ct) {
  if (!ct) return null;
  const t = ct.split(';')[0].trim().toLowerCase();
  return ({
    'image/jpeg': 'jpg', 'image/jpg': 'jpg',
    'image/png': 'png', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif',
  })[t] || null;
}
function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-zA-Z0-9]{2,5})$/);
    if (m) return m[1].toLowerCase();
  } catch {}
  return null;
}

async function downloadOne(url, outBase) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'image/*' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`http ${res.status}`);
  const ct = res.headers.get('content-type');
  let ext = extFromContentType(ct) || extFromUrl(url) || 'jpg';
  // Sanitize unexpected exts
  if (!/^(jpg|jpeg|png|webp|gif|avif)$/.test(ext)) ext = 'jpg';
  const buf = Buffer.from(await res.arrayBuffer());
  const dest = `${outBase}.${ext}`;
  fs.writeFileSync(dest, buf);
  return { path: dest, bytes: buf.length, ext };
}

async function pmap(items, n, fn) {
  const results = new Array(items.length);
  let cursor = 0, done = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try { results[i] = await fn(items[i], i); }
      catch (e) { results[i] = { __error: String(e.message || e) }; }
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r[dl] ${done}/${items.length}   `);
      }
      await sleep(DELAY_MS);
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  process.stdout.write('\n');
  return results;
}

(async () => {
  const prisma = new PrismaClient();
  const scrapeMap = loadScrapeImages();
  console.log(`[load] ${scrapeMap.size} scrape records carry an image URL`);

  const places = await prisma.place.findMany({
    select: { id: true, name: true, city: true, heroImageUrl: true },
  });
  // Build the work list.
  const work = [];
  for (const p of places) {
    if (p.heroImageUrl && p.heroImageUrl.startsWith('/uploads/')) continue; // already local
    let src = null;
    if (p.heroImageUrl && /^https?:\/\//i.test(p.heroImageUrl)) {
      if (SKIP_EXISTING_HOTLINKS) continue;
      src = p.heroImageUrl;
    } else if (!p.heroImageUrl) {
      const k = dedupKey(p.name, p.city);
      const scraped = scrapeMap.get(k);
      if (scraped) src = scraped;
    }
    if (src) work.push({ id: p.id, name: p.name, city: p.city, src });
  }
  console.log(`[plan] ${work.length} places to download (of ${places.length} total)`);

  let limited = work;
  if (LIMIT) limited = limited.slice(0, LIMIT);

  let ok = 0, failed = 0, totalBytes = 0;
  const results = await pmap(limited, CONCURRENCY, async (item) => {
    const outBase = path.join(OUT_DIR, String(item.id));
    const r = await downloadOne(item.src, outBase);
    return r;
  });

  // Update DB rows for successful downloads.
  for (let i = 0; i < limited.length; i++) {
    const item = limited[i];
    const r = results[i];
    if (r && !r.__error) {
      const localPath = `/uploads/places/${item.id}.${r.ext}`;
      try {
        await prisma.place.update({ where: { id: item.id }, data: { heroImageUrl: localPath } });
        ok++;
        totalBytes += r.bytes;
      } catch (e) {
        console.warn(`[warn] DB update failed for ${item.name} (id ${item.id}): ${e.message}`);
        failed++;
      }
    } else {
      failed++;
    }
  }
  console.log(`[done] downloaded=${ok} failed=${failed} bytes=${(totalBytes / 1024 / 1024).toFixed(1)} MB → ${path.relative(ROOT, OUT_DIR)}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
