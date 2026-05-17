// Coverage watcher for enrichment gaps. Surfaces three classes of
// information so we can tell whether the maintenance pipeline is
// actually moving the needle:
//
//   1. `missing` — count of visible places lacking each enrichable
//      field. Trend this over time to see whether each phase is
//      draining its backlog.
//
//   2. `queueDepth` — count of rows each phase's WHERE clause would
//      match. If the queue depth doesn't shrink between runs, that
//      phase is broken (or has zero new work).
//
//   3. `stuck` — rows that should have been enriched but slipped
//      through the phase queues. The canonical case: rows with
//      enrichmentVersion ≥ 1 but no googlePlaceId — the resolve phase
//      bumped them, but never wrote the canonical identity, so future
//      ticks skip them forever. See investigation notes 2026-05-17:
//      places 1934 / 1935 / 1936 were vanilla on prod despite being
//      "enriched" weeks earlier.
//
// All queries respect `isVisible = true` because invisible rows are
// either pre-launch drafts or dedup-merged tombstones — neither
// matters for user-facing quality.

const { prisma } = require("../db");

const VISIBLE = { isVisible: true };

// Helper: count rows matching a filter under the visible constraint.
const countVisible = (where) => prisma.place.count({ where: { ...VISIBLE, ...where } });

async function getCoverage({ samples = 0 } = {}) {
    const total = await prisma.place.count({ where: VISIBLE });

    // ─── missing-field counts ───────────────────────────────────────────────
    // `null OR empty string` for text fields; just `null` for IDs / dates.
    const missing = await (async () => {
        const [
            googlePlaceId, heroImageUrl, descriptionHtml,
            websiteUrl, phone, openingHours,
            instagramUrl, facebookUrl,
            googleRating, googleReviewCount,
            osmCheckedAt, addressLine,
        ] = await Promise.all([
            countVisible({ googlePlaceId: null }),
            countVisible({ OR: [{ heroImageUrl: null }, { heroImageUrl: "" }] }),
            countVisible({ OR: [{ descriptionHtml: null }, { descriptionHtml: "" }] }),
            countVisible({ OR: [{ websiteUrl: null }, { websiteUrl: "" }] }),
            countVisible({ OR: [{ phone: null }, { phone: "" }] }),
            countVisible({ OR: [{ openingHours: null }, { openingHours: "" }] }),
            countVisible({ OR: [{ instagramUrl: null }, { instagramUrl: "" }] }),
            countVisible({ OR: [{ facebookUrl: null }, { facebookUrl: "" }] }),
            countVisible({ googleRating: null }),
            countVisible({ googleReviewCount: null }),
            countVisible({ osmCheckedAt: null }),
            countVisible({ addressLine: "" }),  // schema: non-nullable
        ]);
        return {
            googlePlaceId, heroImageUrl, descriptionHtml,
            websiteUrl, phone, openingHours,
            instagramUrl, facebookUrl,
            googleRating, googleReviewCount,
            osmCheckedAt, addressLine,
        };
    })();

    // ─── per-phase queue depth ──────────────────────────────────────────────
    // Each phase has its own WHERE clause — replicated here so the watcher
    // tells the truth about what each phase will actually pick up.
    //
    // KEEP IN SYNC with the queue clauses in:
    //   - src/services/enrichment/batch.js (resolve, photos)
    //   - scripts/enrichment/enrich-osm.js
    //   - scripts/enrichment/enrich-tripadvisor.js
    //   - scripts/backfills/backfill-socials-from-website.js
    //   - scripts/enrichment/generate-descriptions.js
    const queueDepth = {};
    queueDepth.resolve = await prisma.place.count({
        where: { enrichmentVersion: 0, googlePlaceId: null },
    });
    queueDepth.photos = await prisma.place.count({
        where: {
            googlePlaceId: { not: null },
            OR: [{ heroImageUrl: null }, { heroImageUrl: "" }],
        },
    });
    queueDepth.osm = await countVisible({
        OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }],
    });
    queueDepth.socials = await countVisible({
        websiteUrl: { not: null },
        OR: [{ instagramUrl: null }, { facebookUrl: null }],
    });
    queueDepth.tripadvisorEligible = await countVisible({
        tripadvisorLocationId: null,
    }).catch(() => null); // column may not exist on older deploys

    // ─── stuck-state detection ──────────────────────────────────────────────
    // These are the silent gaps each phase's queue can't see. Each entry
    // is a class of bug: rows that LOOK enriched but aren't.

    // CASE 1: enrichmentVersion was bumped (Google API or Playwright provider
    // returned something) but no googlePlaceId got written. Resolve queue
    // permanently excludes these. Only the Playwright fallback with --ids
    // can recover them.
    const enrichVerBumpedNoGoogleId = await countVisible({
        enrichmentVersion: { gte: 1 },
        googlePlaceId: null,
    });

    // CASE 2: row has googlePlaceId (Google API found it) but no
    // descriptionHtml. The generate-descriptions phase should fill this
    // from scraped reviews. If the count stays steady run-over-run, the
    // descriptions phase is broken.
    const hasPlaceIdNoDescription = await countVisible({
        googlePlaceId: { not: null },
        OR: [{ descriptionHtml: null }, { descriptionHtml: "" }],
    });

    // CASE 3: vanilla card UX — visible row with NO photo AND NO
    // description. This is the user-facing definition of "vanilla place":
    // the card has nothing but name + address. These are the rows Eric
    // sees and asks about.
    const vanillaCards = await countVisible({
        AND: [
            { OR: [{ heroImageUrl: null }, { heroImageUrl: "" }] },
            { OR: [{ descriptionHtml: null }, { descriptionHtml: "" }] },
        ],
    });

    // CASE 4: row has websiteUrl but no socials. backfill-socials should
    // have visited the homepage at least once. If this count stays high
    // after the cron has been running, the socials phase isn't doing its
    // job (CAPTCHAs, 403s, or queue not draining).
    const hasWebsiteNoSocials = await countVisible({
        websiteUrl: { not: null },
        instagramUrl: null,
        facebookUrl: null,
    });

    const stuck = {
        enrichVerBumpedNoGoogleId,
        hasPlaceIdNoDescription,
        vanillaCards,
        hasWebsiteNoSocials,
    };

    // ─── samples (optional, capped) ─────────────────────────────────────────
    // Returning row IDs only — the requester can hit /place/:id directly
    // to inspect. Keeps the payload small.
    let stuckSamples = null;
    if (samples > 0) {
        const cap = Math.min(samples, 100);
        stuckSamples = {};
        stuckSamples.enrichVerBumpedNoGoogleId = await prisma.place.findMany({
            where: { ...VISIBLE, enrichmentVersion: { gte: 1 }, googlePlaceId: null },
            select: { id: true, name: true, city: true, country: true },
            orderBy: { id: "desc" },
            take: cap,
        });
        stuckSamples.vanillaCards = await prisma.place.findMany({
            where: {
                ...VISIBLE,
                AND: [
                    { OR: [{ heroImageUrl: null }, { heroImageUrl: "" }] },
                    { OR: [{ descriptionHtml: null }, { descriptionHtml: "" }] },
                ],
            },
            select: { id: true, name: true, city: true, country: true },
            orderBy: { id: "desc" },
            take: cap,
        });
    }

    return {
        ok: true,
        generatedAt: new Date().toISOString(),
        total,
        missing,
        queueDepth,
        stuck,
        stuckSamples,
    };
}

// One-shot recovery for the `enrichVerBumpedNoGoogleId` stuck class.
// Resets enrichmentVersion=0 on visible rows where a previous run bumped
// the version without writing googlePlaceId — putting them back into the
// resolve queue. Idempotent: re-running once they're fixed is a no-op.
//
// The batch.js bug that produced these rows was fixed in the same commit,
// so this only needs to run once on the legacy stuck rows.
async function unstickVersionBumpedRows() {
    const candidates = await prisma.place.findMany({
        where: {
            ...VISIBLE,
            enrichmentVersion: { gte: 1 },
            googlePlaceId: null,
        },
        select: { id: true, name: true, city: true, country: true, enrichmentVersion: true },
        orderBy: { id: "asc" },
    });
    if (!candidates.length) {
        return { ok: true, reset: 0, message: "no stuck rows" };
    }
    const result = await prisma.place.updateMany({
        where: {
            ...VISIBLE,
            enrichmentVersion: { gte: 1 },
            googlePlaceId: null,
        },
        data: { enrichmentVersion: 0 },
    });
    return { ok: true, reset: result.count, rows: candidates };
}

module.exports = { getCoverage, unstickVersionBumpedRows };
