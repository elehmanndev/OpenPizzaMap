#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  const rows = await prisma.place.findMany({
    where: { name: { contains: "MangiaRE" } },
    select: {
      id: true, name: true, addressLine: true, city: true, country: true,
      lat: true, lng: true, websiteUrl: true, osmCheckedAt: true,
      googlePlaceId: true, isVisible: true,
    },
  });
  // try alt accent versions
  const alts = await prisma.place.findMany({
    where: { name: { contains: "Mangiar" } },
    select: { id: true, name: true, city: true, osmCheckedAt: true, isVisible: true },
  });
  console.log('Exact:', JSON.stringify(rows, null, 2));
  console.log('Mangiar*:', JSON.stringify(alts, null, 2));
  await prisma.$disconnect();
})();
