#!/usr/bin/env node
// One-shot: tag the 99 thegreat.pizza-only places with style based on city/name signal.
// Default rule:
//   - Naples (city) → neapolitan
//   - Names with explicit Neapolitan signal anywhere → neapolitan
//   - Outside Italy → neapolitan (thegreat.pizza editorial bias)
//   - Everything else → italian
// Idempotent: only writes PlaceStyle rows for places that have NO style yet.

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

// Strong Neapolitan-name signals (case-insensitive substring match on Place.name)
const NEAPOLITAN_NAME_PATTERNS = [
  /napole?tana/i,        // Napoletana, Napolitana
  /napulè/i,             // Napulè (Catania)
  /napule/i,             // Napule
  /\ba puteca\b/i,       // 'A Puteca (Naples dialect)
  /\bda michele\b/i,
  /\bverace\b/i,         // Pizzeria La Verace
  /sciuè/i,
  /santarpia/i,
  /lioniello/i,
  /errico porzio/i,
  /\bcira\b/i,           // Donna Cira
  /mozzabella/i,         // Naples-style street food chain
  /golfo di napoli/i,
  /tana di aldo/i,
];

// Specific places that need a non-default tag (by slug). Override layer.
const SLUG_OVERRIDES = {
  // none for now — leaving empty so review-pass can correct in DB directly
};

function decideStyle(place) {
  if (SLUG_OVERRIDES[place.slug]) return SLUG_OVERRIDES[place.slug];
  if ((place.city || '').toLowerCase() === 'naples') return 'neapolitan';
  for (const re of NEAPOLITAN_NAME_PATTERNS) {
    if (re.test(place.name)) return 'neapolitan';
  }
  if (place.country !== 'Italy') return 'neapolitan'; // editorial bias of thegreat.pizza outside Italy
  return 'italian';
}

async function main() {
  const prisma = new PrismaClient();
  const styles = await prisma.style.findMany({ select: { id: true, slug: true } });
  const styleIdBySlug = Object.fromEntries(styles.map(s => [s.slug, s.id]));

  // Untagged places only.
  const places = await prisma.place.findMany({
    where: { styles: { none: {} } },
    select: { id: true, name: true, city: true, country: true, slug: true },
    orderBy: [{ country: 'asc' }, { city: 'asc' }, { name: 'asc' }],
  });

  const counts = { neapolitan: 0, italian: 0 };
  for (const p of places) {
    const slug = decideStyle(p);
    const styleId = styleIdBySlug[slug];
    if (!styleId) { console.warn('missing style row:', slug); continue; }
    try {
      await prisma.placeStyle.create({ data: { placeId: p.id, styleId } });
      counts[slug] = (counts[slug] || 0) + 1;
    } catch (e) {
      if (e.code !== 'P2002') throw e; // ignore unique-violation re-runs
    }
  }
  console.log('[tag] applied:', counts, 'across', places.length, 'untagged places');
  const total = await prisma.placeStyle.count();
  console.log('[tag] PlaceStyle rows total now:', total);
  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
