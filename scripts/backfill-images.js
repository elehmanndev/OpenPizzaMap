#!/usr/bin/env node
// Backfill Place.heroImageUrl from scrape JSONs for places that imported with
// no image. The main importer uses upsert with `update: {}`, so it never
// overwrites existing rows — this is the merge surface for late-discovered
// fields. Idempotent: only updates rows where heroImageUrl is currently null.
//
// Sources:
//   - eater-scrape.json   (rescrape with fixed extractImage recovers images
//                          for 130/209 venues; the rest are Instagram embeds)
//   - avpn-scrape.json    (had ~80% coverage already, but the enricher's
//                          retries may have recovered more)
//
// Matching: slugify(name) + '|' + slugify(canonical city) — same shape as
// the importer's dedupKey, after canonicalizing the city to English.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');

// ---- city canonicalization (mirrors import-places.js, kept inline) ----
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

// ---- build image lookup from scrape JSONs ----
function loadEater() {
  const f = path.join(ROOT, 'eater-scrape.json');
  if (!fs.existsSync(f)) return [];
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return d.places.filter(p => p.image && p.name).map(p => {
    // Eater address parser: city is the 2nd-to-last comma segment
    // (after stripping country/postal/state), but city_hint is reliable.
    const city = p.city_hint;
    return { source: 'eater', key: dedupKey(p.name, city), name: p.name, city, image: p.image };
  });
}
function loadAvpn() {
  const f = path.join(ROOT, 'avpn-scrape.json');
  if (!fs.existsSync(f)) return [];
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  return d.places
    .filter(p => p.detail && p.detail.heroImageUrl && p.name)
    .map(p => ({ source: 'avpn', key: dedupKey(p.name, p.city), name: p.name, city: p.city, image: p.detail.heroImageUrl }));
}

(async () => {
  const prisma = new PrismaClient();
  const records = [...loadEater(), ...loadAvpn()];
  console.log(`[load] ${records.length} scrape records carry an image URL`);

  // Map: dedupKey → first-seen image URL
  const byKey = new Map();
  for (const r of records) if (!byKey.has(r.key)) byKey.set(r.key, r);

  // Pull every Place with no image yet.
  const targets = await prisma.place.findMany({
    where: { OR: [{ heroImageUrl: null }, { heroImageUrl: '' }] },
    select: { id: true, name: true, city: true, heroImageUrl: true },
  });
  console.log(`[db] ${targets.length} places lack heroImageUrl`);

  let matched = 0, updated = 0, missed = 0;
  for (const p of targets) {
    const k = dedupKey(p.name, p.city);
    const r = byKey.get(k);
    if (!r) { missed++; continue; }
    matched++;
    try {
      await prisma.place.update({ where: { id: p.id }, data: { heroImageUrl: r.image } });
      updated++;
    } catch (e) {
      console.warn(`[warn] update failed for ${p.name} (${p.city}): ${e.message}`);
    }
  }
  console.log(`[done] matched=${matched} updated=${updated} missed=${missed}`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
