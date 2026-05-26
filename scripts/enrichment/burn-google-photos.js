// Google Place Photos source for the runner. Mirrors scrape-gallery.js
// (Playwright source) but goes through the Places API (New) instead.
//
// Per place this phase produces:
//   1 Place Details call (photos field) → up to 5 photo refs
//   1 Place Photo call per ref          → lh3 URL with maxWidthPx=1200
//
// Returns { jobs: [...] } in the maintenance result. The runner's
// post-tick step then POSTs jobs to Hostinger /api/admin/gallery-download
// which actually downloads the bytes (within minutes of getting the lh3
// URL — same pattern as scrape-gallery.js).
//
// Cost per place:  $0.005 details + 5 × $0.007 photos = ~$0.040
// For 2,400 places: ~$96, fits the €130 expiring credit.
//
// Idempotent — places with ≥5 google-source PlaceImage rows are
// dropped from the candidate pool, and individual refs already in
// PlaceImage (by sourceRef) are filtered before they hit the runner
// gallery-download endpoint anyway.

const { prisma } = require("../lib/bootstrap");
const { GoogleApiProvider } = require("../../src/services/enrichment/providers");

const PHOTOS_PER_PLACE = 5;
const PHOTO_WIDTH = 1200;
const PACE_MS = 80;
const COST_DETAILS = 0.005;
const COST_PHOTO = 0.007;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function buildJob(provider, place) {
    // Place Details — photos field only ($0.005).
    const detailJson = await provider._get(
        `https://places.googleapis.com/v1/places/${place.googlePlaceId}?fields=photos&key=${provider.apiKey}`
    );
    provider.callsMade--; // _get incremented; we already counted via stats
    const refs = (detailJson.photos || []).slice(0, PHOTOS_PER_PLACE);
    if (!refs.length) return { placeId: place.id, slug: place.slug, photos: [], detailsHit: true };

    // Pull existing sourceRefs so we never re-fetch a photo Hostinger
    // already has. Cheaper than letting download-gallery skip it.
    const existing = await prisma.placeImage.findMany({
        where: { placeId: place.id, sourceRef: { in: refs.map((r) => r.name) } },
        select: { sourceRef: true },
    });
    const have = new Set(existing.map((r) => r.sourceRef));
    const fresh = refs.filter((r) => !have.has(r.name));
    if (!fresh.length) return { placeId: place.id, slug: place.slug, photos: [], detailsHit: true };

    // Fetch lh3 URLs for fresh refs ($0.007 each).
    const photos = [];
    for (const ref of fresh) {
        try {
            const j = await provider._get(
                `https://places.googleapis.com/v1/${ref.name}/media?maxWidthPx=${PHOTO_WIDTH}&skipHttpRedirect=true`
            );
            if (j.photoUri) {
                photos.push({ sourceRef: ref.name, sourceUrl: j.photoUri });
            }
            await sleep(PACE_MS);
        } catch (_err) {
            // Soft-skip individual photo failures; the rest of the place's
            // photo set still goes through.
        }
    }
    return { placeId: place.id, slug: place.slug, photos, detailsHit: true, photoHits: photos.length };
}

async function run({ limit = 50, apply = false, gapsOnly = true, ids = null } = {}) {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        return { ok: false, error: "GOOGLE_MAPS_API_KEY not set", jobs: [] };
    }

    // Candidate pool: visible places with googlePlaceId.
    let where = { isVisible: true, googlePlaceId: { not: null } };
    if (ids && ids.length) where = { id: { in: ids }, googlePlaceId: { not: null } };

    const all = await prisma.place.findMany({
        where,
        select: { id: true, slug: true, googlePlaceId: true },
        orderBy: { id: "asc" },
    });

    let candidates = all;
    if (gapsOnly) {
        const counts = await prisma.placeImage.groupBy({
            by: ["placeId"],
            where: { source: "google" },
            _count: { _all: true },
        });
        const byId = new Map(counts.map((c) => [c.placeId, c._count._all]));
        candidates = all.filter((p) => (byId.get(p.id) || 0) < PHOTOS_PER_PLACE);
    }
    const batch = candidates.slice(0, limit);

    if (!apply) {
        const estCost = batch.length * (COST_DETAILS + PHOTOS_PER_PLACE * COST_PHOTO);
        return {
            ok: true,
            mode: "dry-run",
            totalCandidates: candidates.length,
            batchSize: batch.length,
            estCost: Number(estCost.toFixed(2)),
            jobs: [],
        };
    }

    const provider = new GoogleApiProvider({ prisma, apiKey: process.env.GOOGLE_MAPS_API_KEY });
    const jobs = [];
    const stats = { processed: 0, details: 0, photos: 0, errors: 0 };

    for (const p of batch) {
        try {
            const job = await buildJob(provider, p);
            stats.processed++;
            if (job.detailsHit) stats.details++;
            stats.photos += (job.photoHits || 0);
            if (job.photos && job.photos.length) jobs.push(job);
        } catch (_err) {
            stats.errors++;
        }
    }

    const estCost = stats.details * COST_DETAILS + stats.photos * COST_PHOTO;
    return {
        ok: true,
        mode: "apply",
        ...stats,
        estCostUsd: Number(estCost.toFixed(3)),
        remainingCandidates: candidates.length - batch.length,
        jobs,
    };
}

module.exports = { run };
