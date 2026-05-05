#!/usr/bin/env node
// Replace the generic `italian` style on 75 places with regional/specific styles.
// Adds 6 new styles (romana, contemporanea, sicilian, apulian, padellino, focaccia-recco)
// then walks each currently-italian place and applies the right tag based on city + name.
// Idempotent: re-running won't double-tag.

const { prisma } = require('../lib/bootstrap');

const NEW_STYLES = [
  { slug: 'romana',         name: 'Roman-Style',           shortLabel: 'Romana',        sortOrder: 3 },
  { slug: 'contemporanea',  name: 'Contemporary Italian',  shortLabel: 'Contemporanea', sortOrder: 4 },
  { slug: 'sicilian',       name: 'Sicilian',              shortLabel: 'Sicilian',      sortOrder: 8 },
  { slug: 'apulian',        name: 'Apulian',               shortLabel: 'Apulian',       sortOrder: 9 },
  { slug: 'padellino',      name: 'Pizza al Padellino',    shortLabel: 'Padellino',     sortOrder: 10 },
  { slug: 'focaccia-recco', name: 'Focaccia di Recco',     shortLabel: 'Recco',         sortOrder: 11 },
];

// Specific overrides by Place.id where the city default doesn't fit.
// (italian → contemporanea for explicitly-modern Roman bars; etc.)
const ID_OVERRIDES = {
  153: 'contemporanea', // FinaFina (Rome) — modern bar
  151: 'contemporanea', // Svario Pizza Bar (Rome) — modern
  78:  'contemporanea', // Crazy Pizza (Catania) — Briatore chain, modern
  55:  'al-taglio',     // Steccapara Pizza e Supplì (Bologna) — al-taglio cousin
};

function decideForPlace(place) {
  if (ID_OVERRIDES[place.id]) return ID_OVERRIDES[place.id];
  const city = (place.city || '').toLowerCase();
  if (city === 'naples') return 'neapolitan';            // Trianon dup-tag → drop italian, neapolitan stays
  if (city === 'rome')   return 'romana';
  if (city === 'catania' || city === 'palermo') return 'sicilian';
  if (city === 'bari' || city === 'lecce') return 'apulian';
  if (city === 'turin')  return 'padellino';
  if (city === 'genoa')  return 'neapolitan';
  // Florence, Bologna, Milan, Verona: no regional style → contemporanea
  return 'contemporanea';
}

async function main() {
  // 1. Upsert new styles.
  for (const s of NEW_STYLES) {
    await prisma.style.upsert({
      where: { slug: s.slug },
      update: { name: s.name, shortLabel: s.shortLabel, sortOrder: s.sortOrder, isVisible: true },
      create: { ...s, isVisible: true },
    });
  }
  console.log('[styles] upserted', NEW_STYLES.length, 'new styles');

  const styles = await prisma.style.findMany({ select: { id: true, slug: true } });
  const idBySlug = Object.fromEntries(styles.map(s => [s.slug, s.id]));

  // 2. Walk every place currently tagged `italian`.
  const italianStyleId = idBySlug.italian;
  const places = await prisma.place.findMany({
    where: { styles: { some: { styleId: italianStyleId } } },
    select: { id: true, name: true, city: true },
  });
  console.log('[retag] places currently tagged italian:', places.length);

  let added = 0, removed = 0;
  for (const p of places) {
    const newSlug = decideForPlace(p);
    const newStyleId = idBySlug[newSlug];
    if (!newStyleId) { console.warn('missing style:', newSlug); continue; }

    // Add new tag if not already there
    try {
      await prisma.placeStyle.create({ data: { placeId: p.id, styleId: newStyleId } });
      added++;
    } catch (e) {
      if (e.code !== 'P2002') throw e;
    }
    // Remove the italian tag
    try {
      await prisma.placeStyle.delete({
        where: { placeId_styleId: { placeId: p.id, styleId: italianStyleId } },
      });
      removed++;
    } catch (e) {
      if (e.code !== 'P2025') throw e; // already gone
    }
  }
  console.log(`[retag] added=${added} removed=${removed}`);

  // 3. Hide the italian style (keep row for history, mark sortOrder last).
  await prisma.style.update({
    where: { slug: 'italian' },
    data: { isVisible: false, sortOrder: 999 },
  });
  console.log('[retag] hid italian style');

  // 4. Final tally.
  const tally = await prisma.placeStyle.groupBy({ by: ['styleId'], _count: true });
  const slugById = Object.fromEntries(styles.map(s => [s.id, s.slug]));
  console.log('\n[final tally]');
  for (const t of tally.sort((a,b) => b._count - a._count)) {
    console.log('  ' + slugById[t.styleId].padEnd(15) + ' ' + t._count);
  }
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
