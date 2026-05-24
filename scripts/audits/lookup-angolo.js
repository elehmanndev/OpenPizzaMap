#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  const rows = await prisma.place.findMany({
    where: { name: { contains: "Angolo" } },
    select: {
      id: true, name: true, city: true, country: true,
      websiteUrl: true, createdAt: true, isVisible: true,
      sources: { select: { source: true, rank: true } },
    },
  });
  console.log(JSON.stringify(rows, null, 2));
  await prisma.$disconnect();
})();
