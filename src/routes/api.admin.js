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
router.get("/test-enrichment", requireAdmin, async (req, res) => {
    const schema = z.object({
        name: z.string().min(1).max(200),
        city: z.string().min(1).max(120),
        country: z.string().min(1).max(80).optional(),
        provider: z.enum(["playwright", "google_api"]).optional(),
    });
    const parsed = schema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: parsed.error.flatten() });
    }
    const { name, city, country, provider: override } = parsed.data;

    const provider = getProvider({ prisma, override });
    let verdict;
    try {
        verdict = await enrichAndValidate(
            { name, city, country },
            { prisma, provider },
        );
    } finally {
        await provider.close().catch(() => {});
    }

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
});

module.exports = router;
