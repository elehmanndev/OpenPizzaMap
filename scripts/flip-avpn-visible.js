#!/usr/bin/env node
// Flip places sourced from trusted curated lists (AVPN, Eater) to isVisible=true.
// AVPN-certified pizzerias are vetted by the Naples certification body; Eater
// city maps are professionally edited and explicitly call out the best venues.
// Both stand in for the manual moderation step that the importer's default
// isVisible=false applies to lower-trust scrapes (thegreat.pizza, TasteAtlas).
//
// Usage: node scripts/flip-avpn-visible.js [source1 source2 ...]
//   default sources: avpn, eater

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const argSources = process.argv.slice(2).filter(Boolean);
const TRUSTED_SOURCES = argSources.length ? argSources : ['avpn', 'eater', '50toppizza'];

(async () => {
  const prisma = new PrismaClient();
  const targets = await prisma.place.findMany({
    where: {
      isVisible: false,
      sources: { some: { source: { in: TRUSTED_SOURCES } } },
    },
    select: { id: true },
  });
  if (targets.length === 0) {
    console.log(`[flip] nothing to do for sources: ${TRUSTED_SOURCES.join(', ')}`);
    await prisma.$disconnect();
    return;
  }
  const ids = targets.map(t => t.id);
  const res = await prisma.place.updateMany({
    where: { id: { in: ids } },
    data: { isVisible: true },
  });
  console.log(`[flip] made ${res.count} places visible (sources: ${TRUSTED_SOURCES.join(', ')})`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
