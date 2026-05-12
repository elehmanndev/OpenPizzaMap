#!/usr/bin/env node
// Resolve venues via Google Maps using a headless Playwright browser.
//
// Usage:
//   node scripts/resolve-via-gmaps.js               # dry run, prints results
//   node scripts/resolve-via-gmaps.js --apply       # writes results to DB
//   node scripts/resolve-via-gmaps.js --ids=1,2,3   # specific place IDs
//   node scripts/resolve-via-gmaps.js --need-meta   # target rows missing phone/website/hours
//   node scripts/resolve-via-gmaps.js --since-id=N  # only ids ≥ N (combine with --need-meta)
//   node scripts/resolve-via-gmaps.js --limit=N     # cap candidates per run
//
// Default target: every place where addressLine is empty (visible or not).
// For each, search "{name} {city}" on Google Maps, capture the canonical
// address from the place page's address button, plus phone/website/hours
// from the side panel. Writes back addressLine, lat, lng (if shifted >200m),
// phone, websiteUrl, openingHours — never overwrites a non-null value.
// Idempotent — already-filled rows are skipped.
//
// The Playwright bootstrap, lookup() and on-disk cache live in
// scripts/lib/gmaps.js so scripts/enricher.js's phaseGmaps shares the same
// scraping path + cache.

const { prisma } = require('../lib/bootstrap');
const { createGmapsPage, lookup, loadCache, saveCache } = require('../lib/gmaps');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const NEED_META = args.includes('--need-meta');
const IDS = (() => {
  const a = args.find((x) => x.startsWith('--ids='));
  return a ? a.slice(6).split(',').map((s) => parseInt(s, 10)).filter(Boolean) : null;
})();
const SINCE_ID = (() => {
  const a = args.find((x) => x.startsWith('--since-id='));
  return a ? parseInt(a.slice(11), 10) : null;
})();
const LIMIT = (() => {
  const a = args.find((x) => x.startsWith('--limit='));
  return a ? parseInt(a.slice(8), 10) : null;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let where;
  if (IDS) where = { id: { in: IDS } };
  else if (NEED_META) {
    where = {
      isVisible: true,
      // googleReviewCount included so rows with a rating-but-no-count get
      // re-queued. Without it the place looks "fully enriched" to this
      // queue even though the blend in opm-rating.js can't use the rating
      // without a count.
      OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }, { googleRating: null }, { googleReviewCount: null }],
    };
    if (SINCE_ID != null) where.id = { gte: SINCE_ID };
  } else where = { addressLine: '' };
  const placesAll = await prisma.place.findMany({
    where,
    select: { id: true, name: true, city: true, country: true, addressLine: true, phone: true, websiteUrl: true, openingHours: true, lat: true, lng: true, isVisible: true, googleRating: true, googleReviewCount: true, enrichedAt: true },
    // Match the API queue's ordering (src/routes/api.admin.js): rows with
    // NULL enrichedAt go first (untried or force-prioritised), then oldest
    // attempt, then id. Lets us prioritise specific rows (e.g. centroid
    // clusters being re-resolved) by nulling their enrichedAt.
    orderBy: [
      { enrichedAt: { sort: 'asc', nulls: 'first' } },
      { id: 'asc' },
    ],
  });
  const places = LIMIT ? placesAll.slice(0, LIMIT) : placesAll;
  console.log(`[resolve] ${places.length} places to look up (apply=${APPLY}, need-meta=${NEED_META})`);

  const cache = loadCache();
  const { browser, page } = await createGmapsPage();

  let resolved = 0, skipped = 0, missed = 0;
  let metaPhones = 0, metaWebs = 0, metaHours = 0, metaRatings = 0;
  for (const p of places) {
    const cacheKey = `${p.name}|${p.city || ''}`;
    let r = cache[cacheKey];
    // Cache invalidation for --need-meta: the original cache shape only had
    // address/lat/lng/title. If we're hunting for phone/website/hours/rating
    // and the cache entry pre-dates that, drop it and re-fetch. Also
    // re-fetch entries that pre-date the rating extraction (no `rating` key).
    if (NEED_META && r && !r.miss && !('phone' in r) && !('websiteUrl' in r) && !('openingHours' in r)) {
      r = null;
    } else if (NEED_META && r && !r.miss && !('rating' in r)) {
      r = null;
    }
    if (!r) {
      try {
        r = await lookup(page, p.name, p.city);
        cache[cacheKey] = r || { miss: true, ts: Date.now() };
      } catch (e) {
        console.log(`[resolve] #${p.id} "${p.name}" ERROR: ${e.message}`);
        cache[cacheKey] = { error: e.message, ts: Date.now() };
        continue;
      }
      // Persist after each lookup so we never lose progress.
      saveCache(cache);
      await sleep(800); // gentle pace — Google rate-limits if you hammer
    }
    if (!r || r.miss || !r.address) { missed++; console.log(`[resolve] #${p.id} "${p.name}" — no result`); continue; }
    const tags = [r.lat ? `@${r.lat},${r.lng}` : '', r.phone ? `📞${r.phone}` : '', r.websiteUrl ? '🌐' : '', r.openingHours ? '🕒' : '', r.rating ? `★${r.rating}${r.reviewCount ? `(${r.reviewCount})` : ''}` : ''].filter(Boolean).join(' ');
    console.log(`[resolve] #${p.id} "${p.name}" → ${r.address}${tags ? '  ' + tags : ''}`);

    if (APPLY) {
      const data = {};
      if (!p.addressLine || !p.addressLine.trim()) data.addressLine = r.address;
      if (r.lat && r.lng) {
        // Only overwrite coords when the existing pin is > 200m away from
        // the new one — covers the city-centroid-fallback case without
        // jittering already-precise rows.
        const existingLat = parseFloat(p.lat), existingLng = parseFloat(p.lng);
        const newLat = parseFloat(r.lat), newLng = parseFloat(r.lng);
        const dLat = (newLat - existingLat) * 111000;
        const dLng = (newLng - existingLng) * 111000 * Math.cos(existingLat * Math.PI / 180);
        const distM = Math.sqrt(dLat * dLat + dLng * dLng);
        if (distM > 200) { data.lat = r.lat; data.lng = r.lng; }
      }
      // Fill-only-if-null on the metadata trio. Never overwrite existing data.
      if (!p.phone && r.phone) { data.phone = r.phone; metaPhones++; }
      if (!p.websiteUrl && r.websiteUrl) { data.websiteUrl = r.websiteUrl; metaWebs++; }
      if (!p.openingHours && r.openingHours) { data.openingHours = r.openingHours; metaHours++; }
      if (p.googleRating == null && r.rating) {
        data.googleRating = r.rating;
        if (r.reviewCount) data.googleReviewCount = r.reviewCount;
        metaRatings++;
      }
      if (Object.keys(data).length) {
        await prisma.place.update({ where: { id: p.id }, data });
      } else {
        // Stamp enrichedAt so the row drops down the queue instead of
        // re-running forever on every cron. Mirrors the batch-enrich fix
        // in commit 3a25336.
        await prisma.place.update({ where: { id: p.id }, data: { enrichedAt: new Date() } });
        skipped++;
        continue;
      }
    }
    resolved++;
  }
  if (NEED_META) console.log(`[resolve] meta filled — phone=${metaPhones} website=${metaWebs} hours=${metaHours} rating=${metaRatings}`);
  saveCache(cache);
  console.log(`\n[resolve] ${resolved} resolved, ${missed} missed, ${skipped} skipped`);
  await browser.close();
  await prisma.$disconnect();
})();
