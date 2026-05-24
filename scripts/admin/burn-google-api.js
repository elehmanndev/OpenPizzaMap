#!/usr/bin/env node
// Independent one-shot burn through every place via the official Google
// Places API (New). NOT a runner phase — runs to completion in a single
// process, paced lightly to keep API call rate reasonable. Use this to
// drain spare GCP credit by force-refreshing every row, or to fill gaps
// the per-tick runner queue would take days to reach.
//
// What it does, per place:
//   - provider.findPlace(name, city, country) → Places API Text Search
//   - Writes back: phone, websiteUrl, openingHours, googleRating,
//     googleReviewCount, googlePlaceId, googlePlaceUrl
//   - Fill-only-if-null on metadata fields — never overwrites
//   - Skips the Place Photo call (those URLs are time-bombs per the
//     lh3 TTL memo; the runner's galleryScrape Playwright path handles
//     photos correctly)
//
// Usage:
//   node scripts/admin/burn-google-api.js                       # dry-run, all visible
//   node scripts/admin/burn-google-api.js --apply               # write through
//   node scripts/admin/burn-google-api.js --apply --gaps-only   # only rows missing key fields
//   node scripts/admin/burn-google-api.js --apply --ids=1,2,3
//   node scripts/admin/burn-google-api.js --apply --limit=500
//   node scripts/admin/burn-google-api.js --apply --since-id=1500
//
// Requires GOOGLE_MAPS_API_KEY in env. Stops gracefully on quota error.

const { prisma } = require('../lib/bootstrap');
const { GoogleApiProvider, QuotaExceededError, PIPELINE_VERSION } = require('../../src/services/enrichment/providers');

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PACE_MS = 100; // ~10 req/sec, well under Places API limits

function parseArgs(argv) {
    const out = { apply: false, gapsOnly: false, ids: null, sinceId: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (a === '--gaps-only') out.gapsOnly = true;
        else if (a === '--ids') out.ids = argv[++i].split(',').map(Number).filter(Boolean);
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (a === '--since-id') out.sinceId = parseInt(argv[++i], 10);
        else if (eq('since-id')) out.sinceId = parseInt(eq('since-id'), 10);
        else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
    }
    return out;
}

async function main() {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        console.error('GOOGLE_MAPS_API_KEY not set in env — aborting.');
        process.exit(1);
    }
    const args = parseArgs(process.argv.slice(2));

    let where = { isVisible: true };
    if (args.ids) where = { id: { in: args.ids } };
    else if (args.gapsOnly) {
        where = {
            isVisible: true,
            OR: [
                { googlePlaceId: null }, { phone: null }, { websiteUrl: null },
                { openingHours: null }, { googleRating: null }, { googleReviewCount: null },
            ],
        };
    }
    if (args.sinceId != null) where.id = { gte: args.sinceId, ...(where.id || {}) };

    const all = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, city: true, country: true,
            googlePlaceId: true, phone: true, websiteUrl: true, openingHours: true,
            googleRating: true, googleReviewCount: true, googlePlaceUrl: true,
        },
        orderBy: { id: 'asc' },
    });
    const rows = args.limit ? all.slice(0, args.limit) : all;

    console.log(`[burn] candidates=${all.length} processing=${rows.length} apply=${args.apply} gapsOnly=${args.gapsOnly}`);
    if (!rows.length) return;

    const provider = new GoogleApiProvider({ prisma, apiKey: process.env.GOOGLE_MAPS_API_KEY });
    const stats = { resolved: 0, missed: 0, errors: 0, patched: 0, alreadyFull: 0, dupConflicts: 0, quotaHit: false };
    const startedAt = Date.now();

    for (let i = 0; i < rows.length; i++) {
        const p = rows[i];
        process.stdout.write(`[${i + 1}/${rows.length}] #${p.id} ${JSON.stringify(p.name)} (${p.city || '?'}) … `);

        let resolved;
        try {
            resolved = await provider.findPlace(p.name, p.city, p.country);
        } catch (err) {
            if (err instanceof QuotaExceededError) {
                console.log(`QUOTA EXCEEDED — stopping after ${i} rows`);
                stats.quotaHit = true;
                break;
            }
            console.log(`ERROR: ${err.message.slice(0, 80)}`);
            stats.errors++;
            await sleep(PACE_MS);
            continue;
        }

        if (!resolved) {
            console.log('no match');
            stats.missed++;
            await sleep(PACE_MS);
            continue;
        }
        stats.resolved++;

        // Build the fill-only patch — mirror runResolveBatch's policy so we
        // never overwrite existing data.
        const patch = { enrichedAt: new Date() };
        if (!p.googlePlaceId && resolved.googlePlaceId) {
            patch.googlePlaceId = resolved.googlePlaceId;
            if (resolved.googleMapsUrl) patch.googlePlaceUrl = resolved.googleMapsUrl;
            patch.enrichmentVersion = PIPELINE_VERSION;
        }
        if (isEmpty(p.phone) && resolved.phone) patch.phone = resolved.phone;
        if (isEmpty(p.websiteUrl) && resolved.websiteUrl) patch.websiteUrl = resolved.websiteUrl;
        if (isEmpty(p.openingHours) && resolved.openingHours) patch.openingHours = resolved.openingHours;
        if (p.googleRating == null && resolved.rating != null) patch.googleRating = resolved.rating;
        if (p.googleReviewCount == null && resolved.ratingCount != null) patch.googleReviewCount = resolved.ratingCount;

        const newKeys = Object.keys(patch).filter((k) => k !== 'enrichedAt');
        if (!newKeys.length) {
            console.log('already full (no new fields)');
            stats.alreadyFull++;
        } else {
            // Pre-flight: if the patch wants to write googlePlaceId, check
            // whether another row already owns it. If so, the Places API
            // just resolved two of our rows to the same real venue — log
            // it as a dup candidate, drop the placeId field from the
            // patch, but still fill the other metadata fields.
            let conflict = null;
            if (patch.googlePlaceId) {
                const other = await prisma.place.findUnique({
                    where: { googlePlaceId: patch.googlePlaceId },
                    select: { id: true, name: true, city: true, isVisible: true },
                });
                if (other && other.id !== p.id) {
                    conflict = other;
                    delete patch.googlePlaceId;
                    delete patch.googlePlaceUrl;
                    delete patch.enrichmentVersion;
                    stats.dupConflicts = (stats.dupConflicts || 0) + 1;
                }
            }
            if (conflict) {
                console.log(`DUP-CONFLICT with #${conflict.id} "${conflict.name}" (${conflict.city}, visible=${conflict.isVisible}) — wrote metadata only`);
            } else {
                console.log(`fill: ${newKeys.join(',')}`);
            }
            if (args.apply) {
                const remainingKeys = Object.keys(patch).filter((k) => k !== 'enrichedAt');
                if (remainingKeys.length) {
                    await prisma.place.update({ where: { id: p.id }, data: patch }).catch((e) => {
                        console.warn(`  update failed: ${e.message.slice(0, 120)}`);
                    });
                    stats.patched++;
                }
            }
        }
        await sleep(PACE_MS);
    }

    const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log('');
    console.log(`[burn] done in ${dur}s  api-calls=${provider.callsMade}  resolved=${stats.resolved}  missed=${stats.missed}  errors=${stats.errors}  patched=${stats.patched}  already-full=${stats.alreadyFull}  dup-conflicts=${stats.dupConflicts}${stats.quotaHit ? '  QUOTA_EXCEEDED' : ''}`);
    if (stats.dupConflicts) {
        console.log(`[burn] ${stats.dupConflicts} dup-conflicts — two of our rows resolved to the same Google place. Grep \"DUP-CONFLICT\" in the log and merge those pairs via /admin/merge.`);
    }
    if (!args.apply) console.log('Dry run — pass --apply to commit patches.');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
