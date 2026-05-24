#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  // 20 candidates with websites, missing IG AND FB, varied countries
  const rows = await prisma.place.findMany({
    where: {
      isVisible: true,
      websiteUrl: { not: null },
      instagramUrl: null,
      facebookUrl: null,
    },
    select: { id: true, name: true, city: true, country: true, websiteUrl: true },
    orderBy: { id: 'asc' },
    take: 200,
  });
  // pick 20 across distinct countries / domains for diversity
  const seen = new Set();
  const sample = [];
  for (const r of rows) {
    const key = `${r.country}|${new URL(r.websiteUrl).hostname.split('.').slice(-2).join('.')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(r);
    if (sample.length >= 20) break;
  }
  console.log(JSON.stringify(sample, null, 2));
  await prisma.$disconnect();
})();
