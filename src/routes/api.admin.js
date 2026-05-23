const express = require("express");
const { z } = require("zod");
const { prisma } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { approveSubmission, rejectSubmission } = require("../services/submissions");
const { enrichAndValidate } = require("../services/enrichment");
const { getProvider } = require("../services/enrichment/providers");
const {
    runResolveBatch,
    runPhotosBatch,
    runClearFallbackDescriptions,
} = require("../services/enrichment/batch");
const {
    tryStartMaintenance,
    getMaintenanceStatus,
    abortMaintenance,
} = require("../services/maintenance");
const { getCoverage, unstickVersionBumpedRows } = require("../services/audit-coverage");
const { run: runDownloadGallery } = require("../../scripts/backfills/download-gallery");
const { run: runMigrateLegacyHeroes } = require("../../scripts/backfills/migrate-legacy-heroes");

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
// GET /api/admin/batch-enrich?limit=20            → resolve identity for new rows
// GET /api/admin/batch-enrich?limit=20&mode=photos → backfill heroImageUrl
//
// Thin wrapper around src/services/enrichment/batch.js so the same code
// runs whether called from this endpoint or the consolidated
// /api/admin/maintenance orchestrator.
router.get("/batch-enrich", async (req, res) => {
    const limit = parseInt(req.query.limit) || 20;
    const mode = req.query.mode === "photos" ? "photos" : "full";
    const result = mode === "photos"
        ? await runPhotosBatch({ limit })
        : await runResolveBatch({ limit });
    if (mode === "photos") result.mode = "photos";
    res.json(result);
});

// Consolidated maintenance entrypoint — the cron-job.org target. Runs
// every enrichment phase (resolve, photos, reviews, descriptions, osm,
// tripadvisor, socials, opmRating, clearFallbackDescriptions) with
// hour-gated daily phases honoring their scheduled hour. Fire-and-
// forget: returns 202 immediately, work continues in the worker.
// Status queryable at /api/admin/maintenance/status.
//
// POST /api/admin/maintenance?mode=burn            → aggressive (12-day credit window)
// POST /api/admin/maintenance?mode=min             → free-tier sustain
// POST /api/admin/maintenance?mode=min&force=osm   → also run named hour-gated phases now
// POST /api/admin/maintenance?mode=min&skip=osm    → skip named phases
//
// 202 Accepted on a successful kick-off; 409 Conflict if a previous
// run is still in flight (cron-job.org will treat 409 as a failed tick,
// which is correct — overlap is what we don't want).
router.post("/maintenance", async (req, res) => {
    const mode = req.query.mode === "burn" ? "burn" : "min";
    const parseCsv = (s) => (s ? String(s).split(",").map(x => x.trim()).filter(Boolean) : null);
    const force = parseCsv(req.query.force);
    const skip = parseCsv(req.query.skip);
    // `only` lets the opm-runner ping target a single phase
    // (?only=localizeImages) — every other phase is skipped for that
    // tick. The Unraid runner uses this to invoke just the file-writing
    // phase that has to execute on the live Hostinger filesystem.
    const only = parseCsv(req.query.only);
    // Allow per-phase limit overrides via query: ?resolve=80&photos=80
    const overrides = {};
    for (const key of ["resolve", "photos", "reviews", "descriptions", "osm", "tripadvisor", "socials", "playwrightFallback", "localizeImages", "galleryScrape"]) {
        if (req.query[key] != null) {
            const n = parseInt(req.query[key], 10);
            if (Number.isFinite(n) && n > 0) overrides[key] = n;
        }
    }

    const result = tryStartMaintenance({ mode, force, skip, only, overrides });
    if (!result.accepted) {
        return res.status(409).json({ ok: false, ...result });
    }
    res.status(202).json({ ok: true, ...result, statusUrl: "/api/admin/maintenance/status" });
});

router.get("/maintenance/status", async (req, res) => {
    res.json(getMaintenanceStatus());
});

// Force-clear a stuck maintenance lock. Use when a phase hangs past
// its own per-phase timeout (e.g. native Chromium spawn that didn't
// respond to the orchestrator's timeout race). Idempotent.
router.post("/maintenance/abort", async (req, res) => {
    res.json(abortMaintenance());
});

// Coverage watcher — answers "is the pipeline draining its backlog,
// and which rows are stuck where no phase will pick them up?"
//
// GET /api/admin/audit/coverage              → counts only (~10 queries)
// GET /api/admin/audit/coverage?samples=20   → also returns up to 20 row
//                                              IDs per stuck category for
//                                              manual triage
router.get("/audit/coverage", async (req, res) => {
    const samples = Math.min(parseInt(req.query.samples, 10) || 0, 100);
    res.json(await getCoverage({ samples }));
});

// One-shot recovery: reset enrichmentVersion=0 on visible rows whose
// previous resolve bumped the version without writing googlePlaceId.
// Puts the stuck rows back into the resolve queue. Idempotent.
router.post("/audit/unstick", async (req, res) => {
    res.json(await unstickVersionBumpedRows());
});

// One-shot cleanup: null out every Place.descriptionHtml that wasn't
// generated from real customer reviews. Earlier generate-descriptions.js
// had a website fallback that produced generic Gemini blurbs for places
// without scraped reviews; this clears those so the next review-based
// run can fill them with the canonical "Pizza Lovers say:" format.
//
// Lives in the live app on purpose — bare CLI scripts hit Prisma's
// "tokio timer has gone away" panic on Hostinger, this endpoint reuses
// the already-warm worker engine so it always works.
//
// GET  /api/admin/null-fallback-descriptions             → dry-run preview
// POST /api/admin/null-fallback-descriptions             → apply (clears rows)
const REVIEW_PREFIX = "Pizza Lovers say:";

async function inspectFallbackDescriptions() {
    const rows = await prisma.place.findMany({
        where: { descriptionHtml: { not: null } },
        select: { id: true, name: true, city: true, country: true, descriptionHtml: true },
        orderBy: { id: "asc" },
    });
    const bad = rows.filter(r => !String(r.descriptionHtml).trim().startsWith(REVIEW_PREFIX));
    return { total: rows.length, kept: rows.length - bad.length, bad };
}

router.get("/null-fallback-descriptions", async (req, res) => {
    const { total, kept, bad } = await inspectFallbackDescriptions();
    res.json({
        ok: true,
        mode: "dry-run",
        total,
        kept,
        toClear: bad.length,
        sample: bad.slice(0, 20).map(r => ({
            id: r.id,
            name: r.name,
            city: r.city,
            country: r.country,
            description: String(r.descriptionHtml).slice(0, 160),
        })),
    });
});

router.post("/null-fallback-descriptions", async (req, res) => {
    const { total, bad } = await inspectFallbackDescriptions();
    if (!bad.length) {
        return res.json({ ok: true, mode: "apply", total, cleared: 0, message: "nothing to clear" });
    }
    const ids = bad.map(r => r.id);
    const result = await prisma.place.updateMany({
        where: { id: { in: ids } },
        data: { descriptionHtml: null },
    });
    res.json({ ok: true, mode: "apply", total, cleared: result.count });
});

// One-shot recovery: null out heroImageUrl values still pointing at
// lh3.googleusercontent.com. Per `feedback_lh3_url_ttl.md` these expire
// in days-to-weeks; the localizeImages phase has been wasting 200
// download attempts per tick retrying the same 697 dead URLs because
// download-images.js sees them as plain http(s) hotlinks. Nulling them
// drops them out of the localize queue and puts them back in the
// photos queue (which matches `heroImageUrl IS NULL OR ''`) so a
// future google_api-mode runner can fetch fresh URLs.
//
// GET  → dry-run preview (count + sample)
// POST → apply
const LH3_PREFIX = "https://lh3.googleusercontent.com/";

async function findExpiredLh3() {
    const rows = await prisma.place.findMany({
        where: { heroImageUrl: { startsWith: LH3_PREFIX } },
        select: { id: true, name: true, city: true, country: true, heroImageUrl: true },
        orderBy: { id: "asc" },
    });
    return rows;
}

router.get("/null-expired-lh3", async (req, res) => {
    const rows = await findExpiredLh3();
    res.json({
        ok: true,
        mode: "dry-run",
        toClear: rows.length,
        sample: rows.slice(0, 10).map(r => ({
            id: r.id,
            name: r.name,
            city: r.city,
            country: r.country,
            url: r.heroImageUrl,
        })),
    });
});

router.post("/null-expired-lh3", async (req, res) => {
    const result = await prisma.place.updateMany({
        where: { heroImageUrl: { startsWith: LH3_PREFIX } },
        data: { heroImageUrl: null },
    });
    res.json({ ok: true, mode: "apply", cleared: result.count });
});

// Track 2 — galleryDownload endpoint. Receives the jobs payload from
// the Unraid opm-runner immediately after a galleryScrape tick. Bytes
// must land here within a minute or two — lh3 URLs from the scrape
// expire fast. See docs/track2-photo-gallery.md.
//
// Payload shape:
//   { jobs: [{ placeId, name, city, photos: [{ sourceUrl, sourceRef }, ...] }] }
//
// Synchronous on purpose: the runner waits for the response so it can
// log per-place inserted/skipped/failed counts in the same tick. Total
// download time for 10 places × 10 photos ≈ 30s end-to-end (sharp variants
// dominate); within the 30s cron-job.org budget the runner is NOT subject
// to since it's calling us directly.
router.post("/gallery-download", async (req, res) => {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : null;
    if (!jobs) {
        return res.status(400).json({ ok: false, error: "missing jobs array" });
    }
    try {
        const result = await runDownloadGallery({ jobs, disconnect: false });
        res.json(result);
    } catch (err) {
        console.error("[gallery-download] crashed:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Track 2 — one-shot legacy-hero migration. Moves the ~1,820 existing
// /uploads/places/{id}.{ext} hero files into the new per-place subdir
// layout (/uploads/places/{id}/1.{ext}) and inserts a source='legacy'
// PlaceImage row at position 1. See scripts/backfills/migrate-legacy-heroes.js
// for the full logic; this endpoint wraps it so the work happens inside
// the live Hostinger worker (avoids the bare-CLI Prisma "tokio timer
// has gone away" panic — see feedback_hostinger_prisma_cli_panic memory).
//
// GET  → dry-run preview (lists candidates, moves nothing)
// POST → apply
// Both accept ?limit=N to batch. Idempotent — already-migrated rows
// (heroImageUrl in /uploads/places/{id}/... form OR any PlaceImage row
// for the place) are skipped automatically by the script.
router.get("/migrate-legacy-heroes", async (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    try {
        const result = await runMigrateLegacyHeroes({
            apply: false,
            limit: Number.isFinite(limit) && limit > 0 ? limit : null,
            disconnect: false,
        });
        res.json(result);
    } catch (err) {
        console.error("[migrate-legacy-heroes] dry-run crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 6) });
    }
});

// Debug: peek at DB schema state. Lists tables matching a pattern.
// Used to confirm whether the Track 2 migration applied on the live
// DB — `?like=PlaceImage` returns [{ Tables_in_X: "PlaceImage" }] when
// the table exists, [] when it doesn't. Remove after Phase 1 settles.
router.get("/db-tables", async (req, res) => {
    const like = String(req.query.like || "%");
    if (!/^[A-Za-z0-9_%]+$/.test(like)) {
        return res.status(400).json({ ok: false, error: "bad like pattern" });
    }
    try {
        const rows = await prisma.$queryRawUnsafe(`SHOW TABLES LIKE '${like}'`);
        res.json({ ok: true, like, rows });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

// Debug: list migrations Prisma believes are applied. Reads
// _prisma_migrations directly so we can compare against the
// prisma/migrations directory and see if 20260523100000_place_image is
// missing or marked failed. Remove after Phase 1 settles.
router.get("/db-migrations", async (req, res) => {
    try {
        const rows = await prisma.$queryRawUnsafe(`
            SELECT migration_name, started_at, finished_at, rolled_back_at, applied_steps_count
            FROM _prisma_migrations
            ORDER BY started_at DESC
            LIMIT 20
        `);
        res.json({ ok: true, rows });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

// One-shot: apply the Track 2 migration SQL manually if `prisma migrate
// deploy` silently skipped or partially applied it. Idempotent via
// IF NOT EXISTS guards. Remove after Phase 1 settles.
router.post("/db-apply-place-image", async (req, res) => {
    try {
        const before = await prisma.$queryRawUnsafe(`SHOW TABLES LIKE 'PlaceImage'`);

        // 1. Place.galleryLastScrapedAt — guard with IF NOT EXISTS isn't
        //    portable on MariaDB 10.x; check column first.
        const colRows = await prisma.$queryRawUnsafe(`
            SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Place'
              AND COLUMN_NAME = 'galleryLastScrapedAt'
        `);
        if (!Array.isArray(colRows) || colRows.length === 0) {
            await prisma.$executeRawUnsafe(`
                ALTER TABLE \`Place\` ADD COLUMN \`galleryLastScrapedAt\` DATETIME(3) NULL
            `);
        }

        // 2. PlaceImage table
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS \`PlaceImage\` (
                \`id\`         INT NOT NULL AUTO_INCREMENT,
                \`placeId\`    INT NOT NULL,
                \`position\`   INT NOT NULL,
                \`localPath\`  VARCHAR(255) NOT NULL,
                \`source\`     VARCHAR(20) NOT NULL,
                \`sourceRef\`  VARCHAR(255) NULL,
                \`sourceUrl\`  VARCHAR(500) NULL,
                \`width\`      INT NULL,
                \`height\`     INT NULL,
                \`bytes\`      INT NULL,
                \`isHidden\`   BOOLEAN NOT NULL DEFAULT false,
                \`scrapedAt\`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                PRIMARY KEY (\`id\`),
                INDEX \`PlaceImage_placeId_position_idx\` (\`placeId\`, \`position\`),
                UNIQUE INDEX \`PlaceImage_placeId_sourceRef_key\` (\`placeId\`, \`sourceRef\`),
                CONSTRAINT \`PlaceImage_placeId_fkey\`
                    FOREIGN KEY (\`placeId\`) REFERENCES \`Place\`(\`id\`)
                    ON DELETE CASCADE ON UPDATE CASCADE
            ) ENGINE = InnoDB
        `);

        // 3. Mark the migration as applied so `prisma migrate deploy`
        //    doesn't try to re-run it on the next deploy. Insert is
        //    idempotent via INSERT IGNORE.
        const migrationName = "20260523100000_place_image";
        await prisma.$executeRawUnsafe(`
            INSERT IGNORE INTO _prisma_migrations
                (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count)
            VALUES
                (UUID(), 'manual-apply-track2', NOW(3), '${migrationName}', 'Applied via /api/admin/db-apply-place-image', NULL, NOW(3), 1)
        `);

        const after = await prisma.$queryRawUnsafe(`SHOW TABLES LIKE 'PlaceImage'`);
        res.json({
            ok: true,
            before: before.length,
            after: after.length,
            migrationMarkedApplied: migrationName,
        });
    } catch (err) {
        console.error("[db-apply-place-image] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 6) });
    }
});

router.post("/migrate-legacy-heroes", async (req, res) => {
    const limit = parseInt(req.query.limit, 10);
    try {
        const result = await runMigrateLegacyHeroes({
            apply: true,
            limit: Number.isFinite(limit) && limit > 0 ? limit : null,
            disconnect: false,
        });
        res.json(result);
    } catch (err) {
        console.error("[migrate-legacy-heroes] apply crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name, stack: err.stack?.split("\n").slice(0, 6) });
    }
});

module.exports = router;
