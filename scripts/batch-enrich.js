#!/usr/bin/env node
// Batch-enrich existing Place rows via the enrichment pipeline.
// Targets rows with enrichmentVersion=0 and no googlePlaceId — i.e. legacy
// rows that predate the pipeline. Designed to run on Hostinger where
// ENRICHMENT_PROVIDER=google_api and the API key is IP-whitelisted.
//
// Usage:
//   node scripts/batch-enrich.js [--limit N] [--dry-run] [--country XX]
//
// Examples:
//   node scripts/batch-enrich.js --limit 20              # enrich 20 rows
//   node scripts/batch-enrich.js --limit 5 --dry-run     # preview without writes
//   node scripts/batch-enrich.js --limit 10 --country IT  # Italy only

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const hostingerEnv = path.join(ROOT, '.builds', 'config', '.env');
const hostingerEnv2 = path.resolve(ROOT, '..', 'public_html', '.builds', 'config', '.env');
const localEnv = path.join(ROOT, '.env.local');
const defaultEnv = path.join(ROOT, '.env');
const envPath = fs.existsSync(hostingerEnv)
  ? hostingerEnv
  : fs.existsSync(hostingerEnv2)
    ? hostingerEnv2
    : (fs.existsSync(localEnv) ? localEnv : defaultEnv);
require('dotenv').config({ path: envPath });
const { PrismaClient } = require('@prisma/client');
const { getProvider, QuotaExceededError, PIPELINE_VERSION } = require('../src/services/enrichment/providers');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return 155;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : 155;
})();
const COUNTRY_FILTER = (() => {
  const i = args.indexOf('--country');
  return i !== -1 ? args[i + 1] : null;
})();

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');

async function main() {
  const prisma = new PrismaClient();
  const providerName = process.env.ENRICHMENT_PROVIDER || 'playwright';
  console.log(`[batch-enrich] dry-run=${DRY_RUN} limit=${LIMIT} country=${COUNTRY_FILTER || 'all'} provider=${providerName}`);

  const where = {
    enrichmentVersion: 0,
    googlePlaceId: null,
  };
  if (COUNTRY_FILTER) {
    where.country = { contains: COUNTRY_FILTER };
  }

  const totalEligible = await prisma.place.count({ where });
  const rows = await prisma.place.findMany({
    where,
    orderBy: [{ isVisible: 'desc' }, { id: 'asc' }],
    take: LIMIT,
  });

  console.log(`[batch-enrich] ${totalEligible} eligible rows in DB, processing ${rows.length}`);
  if (!rows.length) {
    console.log('[batch-enrich] nothing to do');
    await prisma.$disconnect();
    return;
  }

  const provider = getProvider({ prisma });
  let callsBefore = provider.callsMade ?? 0;
  const stats = { enriched: 0, skipped: 0, errors: 0, dupeSkipped: 0 };
  const log = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const label = `[${i + 1}/${rows.length}] #${row.id} "${row.name}" (${row.city}, ${row.country})`;
    const callsAtStart = provider.callsMade ?? 0;

    let resolved;
    try {
      resolved = await provider.findPlace(row.name, row.city, row.country);
    } catch (err) {
      if (err instanceof QuotaExceededError) {
        console.log(`${label} — QUOTA HIT, stopping early`);
        stats.errors++;
        break;
      }
      console.error(`${label} — ERROR: ${err.message}`);
      log.push({ id: row.id, name: row.name, status: 'error', error: err.message });
      stats.errors++;
      continue;
    }

    const wasCache = (provider.callsMade ?? 0) === callsAtStart;

    if (!resolved) {
      console.log(`${label} — no result${wasCache ? ' (cached miss)' : ''}`);
      log.push({ id: row.id, name: row.name, status: 'no_result', cached: wasCache });
      stats.skipped++;
      continue;
    }

    // Build update patch — fill empty fields, never overwrite existing
    const patch = {};
    if (resolved.googlePlaceId) patch.googlePlaceId = resolved.googlePlaceId;
    if (resolved.googleMapsUrl) patch.googlePlaceUrl = resolved.googleMapsUrl;
    patch.enrichmentVersion = PIPELINE_VERSION;
    patch.enrichedAt = new Date();

    if (isEmpty(row.phone) && resolved.phone) patch.phone = resolved.phone;
    if (isEmpty(row.websiteUrl) && resolved.websiteUrl) patch.websiteUrl = resolved.websiteUrl;
    if (isEmpty(row.openingHours) && resolved.openingHours) patch.openingHours = resolved.openingHours;
    if (row.googleRating == null && resolved.rating != null) patch.googleRating = resolved.rating;
    if (row.googleReviewCount == null && resolved.ratingCount != null) patch.googleReviewCount = resolved.ratingCount;

    const src = wasCache ? 'cache' : 'api';
    if (DRY_RUN) {
      console.log(`${label} — [${src}] would update:`, JSON.stringify(patch, null, 2));
      log.push({ id: row.id, name: row.name, status: 'dry_run', patch, cached: wasCache });
      stats.enriched++;
      continue;
    }

    try {
      await prisma.place.update({ where: { id: row.id }, data: patch });
      console.log(`${label} — [${src}] enriched → placeId=${resolved.googlePlaceId || 'null'}`);
      log.push({ id: row.id, name: row.name, status: 'enriched', googlePlaceId: resolved.googlePlaceId, cached: wasCache });
      stats.enriched++;
    } catch (err) {
      // googlePlaceId UNIQUE constraint — two DB rows resolved to same Google place
      if (err.code === 'P2002' && err.meta?.target?.includes('googlePlaceId')) {
        console.warn(`${label} — DUPE: googlePlaceId ${resolved.googlePlaceId} already in DB, skipping`);
        log.push({ id: row.id, name: row.name, status: 'dupe', googlePlaceId: resolved.googlePlaceId });
        stats.dupeSkipped++;
      } else {
        console.error(`${label} — WRITE ERROR: ${err.message}`);
        log.push({ id: row.id, name: row.name, status: 'write_error', error: err.message });
        stats.errors++;
      }
    }
  }

  const apiCalls = (provider.callsMade ?? 0) - callsBefore;
  console.log(`\n[batch-enrich] === SUMMARY ===`);
  console.log(`  enriched:     ${stats.enriched}`);
  console.log(`  skipped:      ${stats.skipped}`);
  console.log(`  dupes:        ${stats.dupeSkipped}`);
  console.log(`  errors:       ${stats.errors}`);
  console.log(`  API calls:    ${apiCalls}`);
  console.log(`  cache hits:   ${stats.enriched + stats.skipped - apiCalls}`);

  await provider.close().catch(() => {});
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
