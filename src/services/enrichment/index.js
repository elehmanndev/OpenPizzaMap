// enrichAndValidate — single entry point for the enrichment pipeline
// (docs/enrichment-pipeline.md). Called by:
//   - scripts/import-places.js (replaces inline dedup + coord block)
//   - src/services/submissions.js (called at admin-approval time)
//   - GET /api/admin/test-enrichment (dry-run probe)
//
// Steps run in order:
//   1. Identity resolution via the active provider (Playwright | Google API),
//      with automatic fallback to Playwright on QuotaExceeded.
//   2. Dedup gate — three layers, in order: googlePlaceId exact → bbox+name →
//      slug. First hit wins.
//   3. Coord sanity — if raw vs resolved differ > 1 km, prefer resolved and
//      flag drift; if only one exists, use it; if neither, fail to
//      manual_review.
//
// Returns a verdict; the caller is responsible for persistence so the same
// pipeline works whether the writer is the importer (handles its own
// PlaceSource + city upsert) or the submission flow.

const { getProvider, QuotaExceededError, PlaywrightProvider, PIPELINE_VERSION } = require("./providers");
const { haversineKm, boundingBox } = require("../geo");
const { slugify } = require("../slugify");
const { normalizePlaceName } = require("../normalize-place-name");

const COORD_DRIFT_KM_THRESHOLD = 1.0;
const DEDUP_BBOX_KM = 0.2;

// ─── Step 1 — identity resolution with fallback ─────────────────────────────

// Provider is supplied by the caller for batch reuse — the importer
// processes hundreds of rows per run and one Playwright browser per row
// would be ~3 s × N. If `opts.provider` is null, we create a one-shot
// instance and close it before returning.
async function resolveIdentity(rawPlace, { prisma, provider, providerOverride }) {
  const reasons = [];
  const owned = !provider;
  const primary = provider || getProvider({ prisma, override: providerOverride });

  let resolved = null;
  let providerUsed = primary.name;
  try {
    resolved = await primary.findPlace(rawPlace.name, rawPlace.city, rawPlace.country);
  } catch (err) {
    if (err instanceof QuotaExceededError && primary.name !== "playwright") {
      reasons.push(`primary provider ${primary.name} hit quota — falling back to playwright`);
      const fallback = new PlaywrightProvider({ prisma });
      try {
        resolved = await fallback.findPlace(rawPlace.name, rawPlace.city, rawPlace.country);
        providerUsed = fallback.name;
      } finally {
        await fallback.close().catch(() => {});
      }
    } else {
      reasons.push(`provider ${primary.name} error: ${err.message}`);
    }
  } finally {
    if (owned) await primary.close().catch(() => {});
  }

  return { resolved, providerUsed, reasons };
}

// ─── Step 2 — dedup ─────────────────────────────────────────────────────────

// Three-layer dedup. First hit wins.
async function findExisting(prisma, rawPlace, resolved, candidateSlug) {
  // (a) googlePlaceId exact — only possible when the provider returned one.
  //     With Playwright today this is always null; with Google API it's the
  //     canonical identity.
  if (resolved && resolved.googlePlaceId) {
    const hit = await prisma.place.findUnique({
      where: { googlePlaceId: resolved.googlePlaceId },
    });
    if (hit) return { row: hit, layer: "googlePlaceId" };
  }

  // (b) bbox + normalized name — works for legacy rows (no googlePlaceId)
  //     and pre-Google-API imports. Same logic as the existing fallback in
  //     scripts/import-places.js (lines 763-792 pre-refactor).
  const lat = resolved?.lat ?? rawPlace.lat;
  const lng = resolved?.lng ?? rawPlace.lng;
  const country = rawPlace.country;
  if (lat != null && lng != null && country) {
    const candidateNorm = normalizePlaceName(rawPlace.name);
    if (candidateNorm) {
      const box = boundingBox(Number(lat), Number(lng), DEDUP_BBOX_KM);
      const nearby = await prisma.place.findMany({
        where: {
          country,
          lat: { gte: box.minLat, lte: box.maxLat },
          lng: { gte: box.minLng, lte: box.maxLng },
        },
        select: { id: true, name: true, lat: true, lng: true },
      });
      for (const n of nearby) {
        if (normalizePlaceName(n.name) !== candidateNorm) continue;
        if (haversineKm(Number(n.lat), Number(n.lng), Number(lat), Number(lng)) > DEDUP_BBOX_KM) continue;
        const full = await prisma.place.findUnique({ where: { id: n.id } });
        return { row: full, layer: "bbox+name" };
      }
    }
  }

  // (c) slug exact — last-resort safety net for rows the bbox+name layer
  //     misses (e.g. coords moved meaningfully between two imports of the
  //     same source).
  if (candidateSlug) {
    const slugHit = await prisma.place.findUnique({ where: { slug: candidateSlug } });
    if (slugHit) return { row: slugHit, layer: "slug" };
  }

  return null;
}

// ─── Step 3 — coord sanity ──────────────────────────────────────────────────

function checkCoordSanity(rawPlace, resolved) {
  const rawLat = rawPlace.lat != null ? Number(rawPlace.lat) : null;
  const rawLng = rawPlace.lng != null ? Number(rawPlace.lng) : null;
  const resLat = resolved?.lat != null ? Number(resolved.lat) : null;
  const resLng = resolved?.lng != null ? Number(resolved.lng) : null;

  if (resLat != null && resLng != null) {
    if (rawLat == null || rawLng == null) {
      return { chosenLat: resLat, chosenLng: resLng, drift: null, source: "resolved-only" };
    }
    const drift = haversineKm(rawLat, rawLng, resLat, resLng);
    return {
      chosenLat: resLat,
      chosenLng: resLng,
      drift,
      source: drift > COORD_DRIFT_KM_THRESHOLD ? "resolved (raw drifted)" : "resolved",
      flagged: drift > COORD_DRIFT_KM_THRESHOLD,
    };
  }
  if (rawLat != null && rawLng != null) {
    return { chosenLat: rawLat, chosenLng: rawLng, drift: null, source: "raw-only" };
  }
  return { chosenLat: null, chosenLng: null, drift: null, source: "none" };
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

async function enrichAndValidate(rawPlace, opts = {}) {
  const { prisma, provider, providerOverride } = opts;
  if (!prisma) throw new Error("enrichAndValidate requires opts.prisma");

  const reasons = [];

  // Step 1
  const { resolved, providerUsed, reasons: r1 } = await resolveIdentity(rawPlace, { prisma, provider, providerOverride });
  reasons.push(...r1);

  // Step 3 (run before dedup so we know the chosen coord for the bbox)
  const coords = checkCoordSanity(rawPlace, resolved);
  if (coords.flagged) reasons.push(`coord drift ${coords.drift.toFixed(2)} km — using resolved`);

  // Hard gate: if we have no usable coords AND no resolved identity, we
  // cannot place this row on a map without lying. Manual review.
  if (coords.chosenLat == null && !resolved) {
    return {
      action: "manual_review",
      reasons: ["no provider resolution + no source coords"],
      providerUsed,
      resolved: null,
      coords,
      existing: null,
    };
  }

  // Step 2 — dedup
  const candidateSlug = slugify(`${rawPlace.name}-${rawPlace.city}`);
  const existing = await findExisting(prisma, { ...rawPlace, lat: coords.chosenLat, lng: coords.chosenLng }, resolved, candidateSlug);

  let action;
  if (existing) {
    action = "merge_into";
    reasons.push(`dedup match via ${existing.layer}`);
  } else {
    action = "insert";
  }

  return {
    action,
    reasons,
    providerUsed,
    resolved,
    coords,
    existing: existing ? existing.row : null,
    candidateSlug,
    pipelineVersion: PIPELINE_VERSION,
  };
}

module.exports = {
  enrichAndValidate,
  COORD_DRIFT_KM_THRESHOLD,
  DEDUP_BBOX_KM,
};
