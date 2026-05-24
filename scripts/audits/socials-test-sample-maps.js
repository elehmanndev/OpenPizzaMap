#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  const rows = await prisma.place.findMany({
    where: {
      isVisible: true,
      googlePlaceId: { not: null },
      instagramUrl: null,
      facebookUrl: null,
    },
    select: { id: true, name: true, city: true, country: true, googlePlaceId: true, websiteUrl: true },
    orderBy: { id: 'asc' },
    take: 200,
  });
  const seen = new Set();
  const sample = [];
  for (const r of rows) {
    const key = r.country;
    const cnt = sample.filter(s => s.country === key).length;
    if (cnt >= 2) continue;
    sample.push(r);
    if (sample.length >= 10) break;
  }
  for (const r of sample) {
    r.mapsUrl = `https://www.google.com/maps/place/?q=place_id:${r.googlePlaceId}`;
  }
  console.log(JSON.stringify(sample, null, 2));
  await prisma.$disconnect();
})();
