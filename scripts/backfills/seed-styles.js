#!/usr/bin/env node
// Seed the canonical pizza styles + migrate Place.stylesJson tags into PlaceStyle rows.
// Idempotent: re-running is a no-op for unchanged data.

const { prisma } = require('../lib/bootstrap');

const STYLES = [
  { slug: 'neapolitan', name: 'Neapolitan',          shortLabel: 'Neapolitan', sortOrder: 1 },
  { slug: 'italian',    name: 'Traditional Italian', shortLabel: 'Italian',    sortOrder: 2 },
  { slug: 'al-taglio',  name: 'Pizza al Taglio',     shortLabel: 'Al Taglio',  sortOrder: 3 },
  { slug: 'ny',         name: 'New York–Style',      shortLabel: 'NY-Style',   sortOrder: 4 },
  { slug: 'new-haven',  name: 'New Haven Apizza',    shortLabel: 'Apizza',     sortOrder: 5 },
  { slug: 'detroit',    name: 'Detroit-Style',       shortLabel: 'Detroit',    sortOrder: 6 },
  { slug: 'chicago',    name: 'Chicago Deep-Dish',   shortLabel: 'Chicago',    sortOrder: 7 },
];

async function main() {
  // 1. Upsert styles.
  const bySlug = {};
  for (const s of STYLES) {
    const row = await prisma.style.upsert({
      where: { slug: s.slug },
      update: { name: s.name, shortLabel: s.shortLabel, sortOrder: s.sortOrder, isVisible: true },
      create: { ...s, isVisible: true },
    });
    bySlug[s.slug] = row.id;
  }
  console.log('[seed] styles upserted:', Object.keys(bySlug).join(', '));

  // 2. Walk every place with non-empty stylesJson and write PlaceStyle joins.
  const places = await prisma.place.findMany({
    where: { stylesJson: { not: '[]' } },
    select: { id: true, stylesJson: true },
  });

  let attached = 0, skipped = 0;
  for (const p of places) {
    let arr = [];
    try { arr = JSON.parse(p.stylesJson); } catch { skipped++; continue; }
    if (!Array.isArray(arr)) { skipped++; continue; }
    for (const slug of arr) {
      const styleId = bySlug[slug];
      if (!styleId) { skipped++; continue; }
      try {
        await prisma.placeStyle.create({ data: { placeId: p.id, styleId } });
        attached++;
      } catch (e) {
        // unique violation — already exists
        if (e.code !== 'P2002') throw e;
      }
    }
  }
  console.log(`[migrate] attached=${attached} skipped=${skipped} (placeStyles total now in DB)`);
  const total = await prisma.placeStyle.count();
  console.log(`[migrate] PlaceStyle rows total: ${total}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
