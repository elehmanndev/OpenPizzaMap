#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  const all = await prisma.place.findMany({
    where: {
      isVisible: true,
      googlePlaceId: { not: null },
      OR: [{ instagramUrl: null }, { facebookUrl: null }],
    },
    select: { country: true },
  });
  const byCountry = {};
  for (const r of all) byCountry[r.country] = (byCountry[r.country] || 0) + 1;
  const sorted = Object.entries(byCountry).sort((a, b) => b[1] - a[1]);
  console.log('Total candidates:', all.length);
  console.log('By country:');
  for (const [c, n] of sorted.slice(0, 15)) console.log(`  ${c.padEnd(22)} ${n}`);
  const italy = byCountry['Italy'] || 0;
  const spain = byCountry['Spain'] || 0;
  console.log(`\nItaly+Spain: ${italy + spain}`);
  await prisma.$disconnect();
})();
