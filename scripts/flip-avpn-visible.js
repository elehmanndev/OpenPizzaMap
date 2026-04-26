#!/usr/bin/env node
// Flip every place sourced from AVPN to isVisible=true.
// AVPN-certified pizzerias are the highest-quality seed data we have —
// they're vetted by the Naples-based certification body, so we don't need
// the manual moderation step that the importer's default isVisible=false
// applies to lower-trust scrapes.

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

(async () => {
  const prisma = new PrismaClient();
  // Find all places whose source set includes 'avpn' AND that are still hidden.
  const targets = await prisma.place.findMany({
    where: {
      isVisible: false,
      sources: { some: { source: 'avpn' } },
    },
    select: { id: true },
  });
  if (targets.length === 0) {
    console.log('[flip] nothing to do');
    await prisma.$disconnect();
    return;
  }
  const ids = targets.map(t => t.id);
  const res = await prisma.place.updateMany({
    where: { id: { in: ids } },
    data: { isVisible: true },
  });
  console.log(`[flip] made ${res.count} AVPN places visible`);
  await prisma.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
