const express = require("express");
const { z } = require("zod");
const { prisma } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { approveSubmission, rejectSubmission } = require("../services/submissions");
const { enrichAndValidate } = require("../services/enrichment");
const { getProvider } = require("../services/enrichment/providers");

const router = express.Router();

router.get("/submissions", requireAdmin, async (req, res) => {
    const status = req.query.status || "pending";
    const subs = await prisma.submission.findMany({
        where: { status },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    res.json({ ok: true, submissions: subs });
});

router.post("/submissions/:id/approve", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    await approveSubmission({ submissionId: id, reviewerId: req.session.user.id });
    res.json({ ok: true });
});

router.post("/submissions/:id/reject", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const schema = z.object({ reason: z.string().min(1).max(200) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    await rejectSubmission({ submissionId: id, reviewerId: req.session.user.id, reason: parsed.data.reason });
    res.json({ ok: true });
});

// Probe the enrichment pipeline against a synthetic input. Used to verify
// that ENRICHMENT_PROVIDER is wired correctly after a Hostinger env-var
// flip — see docs/setup-google-maps-api.md §8.
//
// GET /api/admin/test-enrichment?name=Sorbillo&city=Naples&country=Italy
//   → { ok, provider, callsMade, verdict: { action, resolved, coords, ... } }
//
// No DB writes other than the EnrichmentCache row the providers populate
// on a real lookup. Cached responses cost zero API calls.
router.get("/test-enrichment", async (req, res) => {
    const schema = z.object({
        name: z.string().min(1).max(200),
        city: z.string().min(1).max(120),
        country: z.string().min(1).max(80).optional(),
        provider: z.enum(["playwright", "google_api"]).optional(),
        debug: z.coerce.boolean().optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const { name, city, country, provider: override, debug } = parsed.data;

    const provider = getProvider({ prisma, override });
    try {
        // debug=1 skips cache + enrichAndValidate and returns the raw Google response
        if (debug && provider.findPlace) {
            let resolved = null;
            let rawGoogle = null;
            let debugError = null;
            try {
                resolved = await provider.findPlace(name, city, country, { skipCache: true });
                rawGoogle = provider._lastRawResponse || null;
            } catch (err) {
                debugError = err.message;
                rawGoogle = provider._lastRawResponse || null;
            }
            return res.json({
                ok: true,
                provider: provider.name,
                callsMade: typeof provider.callsMade === "number" ? provider.callsMade : null,
                resolved,
                rawGoogle,
                debugError,
            });
        }

        const verdict = await enrichAndValidate(
            { name, city, country },
            { prisma, provider },
        );
        res.json({
            ok: true,
            provider: provider.name,
            callsMade: typeof provider.callsMade === "number" ? provider.callsMade : null,
            verdict: {
                action: verdict.action,
                providerUsed: verdict.providerUsed,
                reasons: verdict.reasons,
                resolved: verdict.resolved,
                coords: verdict.coords,
                existing: verdict.existing
                    ? { id: verdict.existing.id, name: verdict.existing.name, slug: verdict.existing.slug }
                    : null,
                candidateSlug: verdict.candidateSlug,
                pipelineVersion: verdict.pipelineVersion,
            },
        });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    } finally {
        await provider.close().catch(() => {});
    }
});

// Batch-enrich existing Place rows. Designed to be called by an external
// cron service (cron-job.org). Processes up to `limit` rows (default 20)
// per call and stops early on quota exceeded.
//
// GET /api/admin/batch-enrich?limit=20
//   → { ok, enriched, skipped, dupes, errors, apiCalls, remaining }
router.get("/batch-enrich", async (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 155);
    const mode = req.query.mode === "photos" ? "photos" : "full";
    const { QuotaExceededError, PIPELINE_VERSION } = require("../services/enrichment/providers");
    const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");

    if (mode === "photos") {
        const where = {
            googlePlaceId: { not: null },
            OR: [{ heroImageUrl: null }, { heroImageUrl: "" }],
        };
        const remaining = await prisma.place.count({ where });
        const rows = await prisma.place.findMany({
            where,
            orderBy: [{ isVisible: "desc" }, { id: "asc" }],
            take: limit,
            select: { id: true, name: true, city: true, googlePlaceId: true, heroImageUrl: true },
        });

        if (!rows.length) {
            return res.json({ ok: true, mode: "photos", updated: 0, noPhoto: 0, errors: 0, apiCalls: 0, remaining: 0, message: "photo backfill complete" });
        }

        const provider = getProvider({ prisma });
        if (!provider.getPhoto) {
            return res.status(400).json({ ok: false, error: "provider does not support getPhoto — need google_api" });
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

        await provider.close().catch(() => {});
        return res.json({ ok: true, mode: "photos", ...stats, apiCalls: provider.callsMade ?? 0, remaining: remaining - stats.updated, quotaHit });
    }

    // Order by enrichedAt nulls-first so untried rows go before rows we
    // already attempted; among tried rows, oldest attempts go first. Without
    // this, an unresolvable prefix (Google can't find them) would block the
    // queue forever — the cron would re-try the same rows every 3h and never
    // reach newer imports.
    const rows = await prisma.place.findMany({
        where: { enrichmentVersion: 0, googlePlaceId: null },
        orderBy: [
            { isVisible: "desc" },
            { enrichedAt: { sort: "asc", nulls: "first" } },
            { id: "asc" },
        ],
        take: limit,
    });
    const remaining = await prisma.place.count({
        where: { enrichmentVersion: 0, googlePlaceId: null },
    });

    if (!rows.length) {
        return res.json({ ok: true, enriched: 0, skipped: 0, dupes: 0, errors: 0, apiCalls: 0, remaining: 0, message: "backfill complete" });
    }

    const provider = getProvider({ prisma });
    const stats = { enriched: 0, skipped: 0, dupes: 0, errors: 0 };
    let quotaHit = false;

    for (const row of rows) {
        let resolved;
        try {
            resolved = await provider.findPlace(row.name, row.city, row.country);
        } catch (err) {
            if (err instanceof QuotaExceededError) {
                quotaHit = true;
                break;
            }
            stats.errors++;
            continue;
        }

        if (!resolved) {
            // Stamp enrichedAt without bumping enrichmentVersion: row stays
            // in the queue (will be retried once newer rows have had a turn)
            // but moves to the back via the nulls-first ordering above.
            await prisma.place.update({ where: { id: row.id }, data: { enrichedAt: new Date() } }).catch(() => {});
            stats.skipped++;
            continue;
        }

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
        if (isEmpty(row.heroImageUrl) && resolved.photoUrl) patch.heroImageUrl = resolved.photoUrl;

        try {
            await prisma.place.update({ where: { id: row.id }, data: patch });
            stats.enriched++;
        } catch (err) {
            if (err.code === "P2002") { stats.dupes++; } else { stats.errors++; }
        }
    }

    await provider.close().catch(() => {});
    res.json({
        ok: true,
        ...stats,
        apiCalls: provider.callsMade ?? 0,
        remaining: remaining - stats.enriched,
        quotaHit,
    });
});

module.exports = router;
