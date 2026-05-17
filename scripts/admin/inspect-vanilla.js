#!/usr/bin/env node
// One-off: inspect what's missing on a list of place IDs. Used to drive
// a targeted smoke test of the maintenance pipeline before push.
const { prisma } = require('../lib/bootstrap');

(async () => {
    const ids = (process.argv.slice(2).join(',') || '1934,1935,1936')
        .split(',').map(s => parseInt(s, 10)).filter(Boolean);
    const rows = await prisma.place.findMany({
        where: { id: { in: ids } },
        select: {
            id: true, name: true, city: true, country: true,
            googlePlaceId: true, websiteUrl: true, phone: true,
            openingHours: true, heroImageUrl: true, descriptionHtml: true,
            googleRating: true, googleReviewCount: true, addressLine: true,
            enrichmentVersion: true, enrichedAt: true, osmCheckedAt: true,
            instagramUrl: true, facebookUrl: true, isVisible: true,
        },
    });
    for (const r of rows) {
        console.log(`\n#${r.id} ${r.name} (${r.city}, ${r.country}) visible=${r.isVisible}`);
        console.log(`  googlePlaceId : ${r.googlePlaceId || '—MISSING'}`);
        console.log(`  enrichmentVer : ${r.enrichmentVersion}  enrichedAt=${r.enrichedAt || '—'}`);
        console.log(`  websiteUrl    : ${r.websiteUrl || '—MISSING'}`);
        console.log(`  phone         : ${r.phone || '—MISSING'}`);
        console.log(`  addressLine   : ${r.addressLine || '—MISSING'}`);
        console.log(`  openingHours  : ${r.openingHours ? '✓' : '—MISSING'}`);
        console.log(`  heroImageUrl  : ${r.heroImageUrl ? '✓' : '—MISSING'}`);
        console.log(`  googleRating  : ${r.googleRating || '—'} (n=${r.googleReviewCount || '—'})`);
        console.log(`  descriptionHtml: ${r.descriptionHtml ? r.descriptionHtml.slice(0, 60) + '…' : '—MISSING'}`);
        console.log(`  instagramUrl  : ${r.instagramUrl || '—MISSING'}`);
        console.log(`  facebookUrl   : ${r.facebookUrl || '—MISSING'}`);
        console.log(`  osmCheckedAt  : ${r.osmCheckedAt || '—'}`);
    }
    await prisma.$disconnect();
})();
