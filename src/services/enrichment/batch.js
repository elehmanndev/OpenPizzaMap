// Batch-enrichment helpers extracted from api.admin.js so the same code
// runs whether it's called from the cron-facing /api/admin/batch-enrich
// endpoint or from the consolidated /api/admin/maintenance orchestrator.
//
// These run **in-process** in the live Passenger worker on purpose —
// bare CLI scripts hit Prisma's "tokio timer has gone away" panic on
// Hostinger (see api.admin.js comment on /null-fallback-descriptions).
// Reusing the warm worker engine sidesteps that class of crash.

const { prisma } = require("../../db");
const { getProvider, QuotaExceededError, PIPELINE_VERSION } = require("./providers");

const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

// Resolve identity (googlePlaceId + canonical metadata) for the next
// `limit` rows that have no googlePlaceId yet. Stops early on
// QuotaExceededError so the remaining quota survives for the next run.
async function runResolveBatch({ limit = 20 } = {}) {
    const capped = Math.min(Math.max(parseInt(limit) || 20, 1), 155);

    // Skip-the-line: hidden rows first. Chatbot-created spots
    // (/add-your-spot, added 2026-05-18) start as isVisible=false and
    // can't appear on the map until enrichment fills them in — so they
    // jump the queue ahead of legacy backfill of already-visible rows.
    // Among the chosen visibility bucket, untried rows (enrichedAt
    // null) go before retries, and among retries the oldest attempts
    // go first. Without nulls-first an unresolvable prefix would block
    // the queue forever.
    const rows = await prisma.place.findMany({
        where: { enrichmentVersion: 0, googlePlaceId: null },
        orderBy: [
            { isVisible: "asc" },
            { enrichedAt: { sort: "asc", nulls: "first" } },
            { id: "asc" },
        ],
        take: capped,
    });
    const remaining = await prisma.place.count({
        where: { enrichmentVersion: 0, googlePlaceId: null },
    });

    if (!rows.length) {
        return {
            ok: true, enriched: 0, skipped: 0, dupes: 0, errors: 0,
            apiCalls: 0, remaining: 0, quotaHit: false,
            message: "backfill complete",
        };
    }

    const provider = getProvider({ prisma });
    const stats = { enriched: 0, skipped: 0, dupes: 0, errors: 0 };
    let quotaHit = false;

    for (const row of rows) {
        let resolved;
        try {
            resolved = await provider.findPlace(row.name, row.city, row.country);
        } catch (err) {
            if (err instanceof QuotaExceededError) { quotaHit = true; break; }
            stats.errors++;
            continue;
        }

        if (!resolved) {
            // Stamp enrichedAt without bumping enrichmentVersion: row
            // stays in the queue (will be retried once newer rows have
            // had a turn) but moves to the back via the nulls-first
            // ordering above.
            await prisma.place.update({
                where: { id: row.id },
                data: { enrichedAt: new Date() },
            }).catch(() => {});
            stats.skipped++;
            continue;
        }

        // Always stamp enrichedAt so the queue rotates this row to the
        // back of the line; opportunistically fill any metadata fields
        // the provider returned. enrichmentVersion only bumps when the
        // CANONICAL identity (googlePlaceId) actually got written —
        // otherwise the row stays eligible for retry on the next tick.
        //
        // Bug fix (2026-05-17): before this, the Playwright provider
        // would partially resolve a row (phone / hours / rating from
        // DOM scraping but no place_id) and the bump-without-write
        // permanently excluded the row from future resolves. Audit
        // showed 5 visible rows in this exact state: places 1934-1938,
        // all stuck since the May-12 batch import. See
        // /api/admin/audit/coverage → stuck.enrichVerBumpedNoGoogleId.
        const patch = { enrichedAt: new Date() };
        if (resolved.googlePlaceId) {
            patch.googlePlaceId = resolved.googlePlaceId;
            if (resolved.googleMapsUrl) patch.googlePlaceUrl = resolved.googleMapsUrl;
            patch.enrichmentVersion = PIPELINE_VERSION;
        }
        if (isEmpty(row.phone) && resolved.phone) patch.phone = resolved.phone;
        if (isEmpty(row.websiteUrl) && resolved.websiteUrl) patch.websiteUrl = resolved.websiteUrl;
        if (isEmpty(row.openingHours) && resolved.openingHours) patch.openingHours = resolved.openingHours;
        if (row.googleRating == null && resolved.rating != null) patch.googleRating = resolved.rating;
        if (row.googleReviewCount == null && resolved.ratingCount != null) patch.googleReviewCount = resolved.ratingCount;
        if (isEmpty(row.heroImageUrl) && resolved.photoUrl) patch.heroImageUrl = resolved.photoUrl;

        try {
            await prisma.place.update({ where: { id: row.id }, data: patch });
            stats.enriched++;
        } catch (err) {
            if (err.code === "P2002") { stats.dupes++; } else { stats.errors++; }
        }
    }

    const apiCalls = provider.callsMade ?? 0;
    await provider.close().catch(() => {});
    return { ok: true, ...stats, apiCalls, remaining: remaining - stats.enriched, quotaHit };
}

// Backfill heroImageUrl for rows that have googlePlaceId but no photo
// yet. Mirrors runResolveBatch's structure; stops on QuotaExceededError.
async function runPhotosBatch({ limit = 20 } = {}) {
    const capped = Math.min(Math.max(parseInt(limit) || 20, 1), 155);

    const where = {
        googlePlaceId: { not: null },
        OR: [{ heroImageUrl: null }, { heroImageUrl: "" }],
    };
    const remaining = await prisma.place.count({ where });
    const rows = await prisma.place.findMany({
        where,
        // Skip-the-line: hidden rows first (same rationale as
        // runResolveBatch). A chatbot-created row that just got its
        // googlePlaceId in this same tick can pick up its heroImageUrl
        // on the very next pass, satisfying publishReady.
        orderBy: [{ isVisible: "asc" }, { id: "asc" }],
        take: capped,
        select: { id: true, name: true, city: true, googlePlaceId: true, heroImageUrl: true },
    });

    if (!rows.length) {
        return {
            ok: true, updated: 0, noPhoto: 0, errors: 0,
            apiCalls: 0, remaining: 0, quotaHit: false,
            message: "photo backfill complete",
        };
    }

    const provider = getProvider({ prisma });
    if (!provider.getPhoto) {
        return { ok: false, error: "provider does not support getPhoto — need google_api" };
    }

    const stats = { updated: 0, noPhoto: 0, errors: 0 };
    let quotaHit = false;
    for (const row of rows) {
        let photoUrl;
        try {
            photoUrl = await provider.getPhoto(row.googlePlaceId);
        } catch (err) {
            if (err instanceof QuotaExceededError) { quotaHit = true; break; }
            stats.errors++;
            continue;
        }
        if (!photoUrl) { stats.noPhoto++; continue; }
        await prisma.place.update({ where: { id: row.id }, data: { heroImageUrl: photoUrl } });
        stats.updated++;
    }

    const apiCalls = provider.callsMade ?? 0;
    await provider.close().catch(() => {});
    return { ok: true, ...stats, apiCalls, remaining: remaining - stats.updated, quotaHit };
}

// Clear pre-2026-05 fallback-blurb descriptions (generate-descriptions.js
// had a website-fallback path that produced generic Gemini blurbs for
// places without scraped reviews). Idempotent: once every kept row
// starts with "Pizza Lovers say:" this is a no-op.
const REVIEW_PREFIX = "Pizza Lovers say:";

// Flip isVisible=true on hidden rows that the enrichment cron has
// brought up to "ready" quality. Added 2026-05-18 alongside the
// /add-your-spot chatbot intake — chatbot-created Place rows start as
// isVisible=false and need a programmatic gate before they appear on
// the public map.
//
// Readiness criteria (all must hold):
//   - enrichedAt set (Google/OSM/etc actually touched the row)
//   - heroImageUrl OR descriptionHtml present (something visual / textual
//     beyond the bare submission)
//   - status === "active"
//
// Rows that don't yet meet the bar stay hidden — they'll be picked up
// on a later tick once descriptions or photos land.
async function runPublishReadyBatch({ limit = 50 } = {}) {
    const capped = Math.min(Math.max(parseInt(limit) || 50, 1), 500);
    const candidates = await prisma.place.findMany({
        where: {
            isVisible: false,
            status: "active",
            enrichedAt: { not: null },
            OR: [
                { heroImageUrl: { not: null } },
                { descriptionHtml: { not: null } },
            ],
        },
        select: { id: true, descriptionHtml: true },
        orderBy: { id: "asc" },
        take: capped,
    });

    if (!candidates.length) {
        return { ok: true, published: 0, scanned: 0 };
    }

    // Filter out fallback (auto-generated lorem) descriptions — they
    // don't count as "useful content". Same prefix the clear-fallback
    // phase already detects.
    const ready = candidates.filter((row) => {
        if (!row.descriptionHtml) return true; // hero alone is fine
        const d = String(row.descriptionHtml).trim();
        return d.startsWith(REVIEW_PREFIX) || !d.includes("Lorem ipsum");
    }).map((r) => r.id);

    if (!ready.length) {
        return { ok: true, published: 0, scanned: candidates.length };
    }

    const result = await prisma.place.updateMany({
        where: { id: { in: ready } },
        data: { isVisible: true },
    });
    return { ok: true, published: result.count, scanned: candidates.length };
}

async function runClearFallbackDescriptions() {
    const rows = await prisma.place.findMany({
        where: { descriptionHtml: { not: null } },
        select: { id: true, descriptionHtml: true },
    });
    const bad = rows.filter(r => !String(r.descriptionHtml).trim().startsWith(REVIEW_PREFIX));
    if (!bad.length) return { ok: true, total: rows.length, cleared: 0 };
    const result = await prisma.place.updateMany({
        where: { id: { in: bad.map(r => r.id) } },
        data: { descriptionHtml: null },
    });
    return { ok: true, total: rows.length, cleared: result.count };
}

module.exports = {
    runResolveBatch,
    runPhotosBatch,
    runClearFallbackDescriptions,
    runPublishReadyBatch,
};
