#!/usr/bin/env node
// Audit the rows where Google search by name+city never resolved a placeId
// (the "long-tail no-result" cohort). For those rows, OSM is the only
// remaining external enrichment surface, so its hit rate matters most.
//
// Counts:
//   - total no-googlePlaceId rows (visible)
//   - of those, how many got OSM data (osmCheckedAt + non-null phone or hours)
//   - of those, how many were checked but missed (osmCheckedAt set, no data)
//   - of those, how many haven't been checked yet (osmCheckedAt null)
const { prisma } = require('../lib/bootstrap');
(async () => {
  const noGoogle = await prisma.place.findMany({
    where: { isVisible: true, googlePlaceId: null },
    select: {
      id: true, name: true, city: true, country: true,
      phone: true, websiteUrl: true, openingHours: true,
      osmCheckedAt: true, addressLine: true,
    },
    orderBy: { id: 'asc' },
  });
  let osmHit = 0, osmMiss = 0, osmUnchecked = 0;
  for (const r of noGoogle) {
    const hasOsmIsh = !!(r.phone || r.openingHours || r.websiteUrl);
    if (!r.osmCheckedAt) osmUnchecked++;
    else if (hasOsmIsh) osmHit++;
    else osmMiss++;
  }
  console.log(`No-googlePlaceId visible rows: ${noGoogle.length}`);
  console.log(`  OSM checked + got data: ${osmHit}`);
  console.log(`  OSM checked + miss:     ${osmMiss}`);
  console.log(`  OSM never checked:      ${osmUnchecked}`);
  console.log('');
  console.log(`Sample of OSM-miss rows (no Google, no OSM hit — flying blind):`);
  let i = 0;
  for (const r of noGoogle) {
    const hasOsmIsh = !!(r.phone || r.openingHours || r.websiteUrl);
    if (r.osmCheckedAt && !hasOsmIsh) {
      console.log(`  #${r.id} ${r.name} — ${r.city}, ${r.country}`);
      if (++i >= 15) break;
    }
  }
  await prisma.$disconnect();
})();
