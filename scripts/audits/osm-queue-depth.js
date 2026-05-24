#!/usr/bin/env node
// Why are 62 no-Google rows still unchecked by OSM? Either the queue is too
// long (40/day limit) or they're being excluded by the WHERE clause. Audit.
const { prisma } = require('../lib/bootstrap');
(async () => {
  // Reproduce exact OSM phase WHERE clause from scripts/enrichment/enrich-osm.js
  const totalQueue = await prisma.place.count({
    where: {
      isVisible: true,
      OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }],
    },
  });
  const uncheckedQueue = await prisma.place.count({
    where: {
      isVisible: true,
      osmCheckedAt: null,
      OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }],
    },
  });
  // How many of the 62 no-Google unchecked rows ARE actually in the OSM queue?
  const noGoogleInQueue = await prisma.place.count({
    where: {
      isVisible: true,
      googlePlaceId: null,
      osmCheckedAt: null,
      OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }],
    },
  });
  const noGoogleUnchecked = await prisma.place.count({
    where: { isVisible: true, googlePlaceId: null, osmCheckedAt: null },
  });
  console.log(`OSM queue total: ${totalQueue}`);
  console.log(`OSM queue unchecked (top of queue): ${uncheckedQueue}`);
  console.log(`No-Google + unchecked + in-queue: ${noGoogleInQueue}`);
  console.log(`No-Google + unchecked (any reason): ${noGoogleUnchecked}`);
  console.log(`  → diff = ${noGoogleUnchecked - noGoogleInQueue} excluded by WHERE clause`);
  console.log('');
  console.log(`At 40 places/day: ${Math.ceil(uncheckedQueue / 40)} days to clear unchecked head`);
  await prisma.$disconnect();
})();
