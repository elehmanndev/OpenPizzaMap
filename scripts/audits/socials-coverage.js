#!/usr/bin/env node
const { prisma } = require('../lib/bootstrap');
(async () => {
  const visible = await prisma.place.count({ where: { isVisible: true } });
  const withIg = await prisma.place.count({ where: { isVisible: true, instagramUrl: { not: null } } });
  const withFb = await prisma.place.count({ where: { isVisible: true, facebookUrl: { not: null } } });
  const withWebsite = await prisma.place.count({ where: { isVisible: true, websiteUrl: { not: null } } });
  const candidatesIgWithWeb = await prisma.place.count({ where: { isVisible: true, instagramUrl: null, websiteUrl: { not: null } } });
  const candidatesFbWithWeb = await prisma.place.count({ where: { isVisible: true, facebookUrl: null, websiteUrl: { not: null } } });
  const candidatesAnyWithWeb = await prisma.place.count({ where: { isVisible: true, OR: [{ instagramUrl: null }, { facebookUrl: null }], websiteUrl: { not: null } } });
  const noSocialsNoWeb = await prisma.place.count({ where: { isVisible: true, instagramUrl: null, facebookUrl: null, websiteUrl: null } });
  console.log(JSON.stringify({ visible, withIg, withFb, withWebsite, candidatesIgWithWeb, candidatesFbWithWeb, candidatesAnyWithWeb, noSocialsNoWeb }, null, 2));
  await prisma.$disconnect();
})();
