const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
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

// Multer config for /upload-place-photo. Memory storage because the
// files go through validate → atomic write → DB insert and need to
// live in RAM only for that window. 5MB per file cap (the largest
// real photos we've seen from Google/TA scrapes are ~500KB).
const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 10 },
    fileFilter: (req, file, cb) => {
        const ok = /^(image\/(jpeg|png|webp|avif|gif))$/i.test(file.mimetype);
        cb(ok ? null : new Error(`unsupported mimetype: ${file.mimetype}`), ok);
    },
});

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
// Track 2 — one-shot file-layout migration from
// /uploads/places/{id}/N.{ext} to /uploads/places/{slug}/N.{ext}.
// SEO win: Google image search reads the path as a ranking signal.
//
// Walks every PlaceImage row whose localPath starts with the id-based
// form, moves the file (and its sibling -thumb.jpg / -large.jpg
// variants) into the slug-based subdir, updates PlaceImage.localPath
// and Place.heroImageUrl to point at the new path.
//
// Idempotent on rerun:
//   - If the source id-dir is already gone (previous run moved it),
//     the row is skipped and DB-only fixed if its localPath still
//     looks id-based.
//   - If the destination slug-dir already exists with the file in
//     place, the source dir is left alone (could be re-import) and
//     we just update DB.
//
// Places with null slug get place-{id} as the segment (same fallback
// the runtime uses) so we never write into the bare uploads/places/
// root.
//
// GET  → dry-run preview
// POST → apply
const fsMod = require("fs");
const pathMod = require("path");
const PUBLIC_ROOT = pathMod.resolve(__dirname, "..", "..", "public");

function legacyIdPathSegment(placeId) { return String(placeId); }
function slugPathSegment(place) {
    if (place && place.slug) return place.slug;
    return `place-${place.id}`;
}

async function relayoutDryRun() {
    const rows = await prisma.placeImage.findMany({
        select: {
            id: true, placeId: true, localPath: true, position: true,
            place: { select: { id: true, slug: true, heroImageUrl: true } },
        },
        orderBy: { id: "asc" },
    });
    let candidates = 0;
    let slugDirAlreadyExists = 0;
    let nothingToDo = 0;
    const samples = [];
    for (const r of rows) {
        if (!r.localPath || !r.localPath.startsWith("/uploads/places/")) {
            nothingToDo++;
            continue;
        }
        const m = r.localPath.match(/^\/uploads\/places\/([^/]+)\/(.+)$/);
        if (!m) { nothingToDo++; continue; }
        const currentSeg = m[1];
        const desiredSeg = slugPathSegment(r.place);
        if (currentSeg === desiredSeg) { nothingToDo++; continue; }
        candidates++;
        const srcDir = pathMod.join(PUBLIC_ROOT, "uploads", "places", currentSeg);
        const dstDir = pathMod.join(PUBLIC_ROOT, "uploads", "places", desiredSeg);
        if (fsMod.existsSync(dstDir)) slugDirAlreadyExists++;
        if (samples.length < 5) {
            samples.push({ placeId: r.placeId, from: currentSeg, to: desiredSeg, srcExists: fsMod.existsSync(srcDir) });
        }
    }
    return { totalRows: rows.length, candidates, slugDirAlreadyExists, nothingToDo, samples };
}

async function relayoutApply() {
    const places = await prisma.place.findMany({
        select: { id: true, slug: true, heroImageUrl: true },
    });
    const bySlug = new Map();
    for (const p of places) bySlug.set(p.id, p);

    const rows = await prisma.placeImage.findMany({
        select: { id: true, placeId: true, localPath: true },
        orderBy: { id: "asc" },
    });

    // Move directories ONCE per place (multiple PlaceImage rows can sit
    // in the same dir). Track per-place: which segment moved → which.
    const moved = new Map();   // placeId → { from, to }
    let dirsMoved = 0;
    let dirsAlreadyTarget = 0;
    let dirsSrcMissing = 0;
    let rowsUpdated = 0;
    let heroesUpdated = 0;

    // Pass 1: move directories
    for (const r of rows) {
        if (!r.localPath || !r.localPath.startsWith("/uploads/places/")) continue;
        const m = r.localPath.match(/^\/uploads\/places\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const currentSeg = m[1];
        const place = bySlug.get(r.placeId);
        if (!place) continue;
        const desiredSeg = slugPathSegment(place);
        if (currentSeg === desiredSeg) continue;
        if (moved.has(r.placeId)) continue;

        const srcDir = pathMod.join(PUBLIC_ROOT, "uploads", "places", currentSeg);
        const dstDir = pathMod.join(PUBLIC_ROOT, "uploads", "places", desiredSeg);

        if (!fsMod.existsSync(srcDir)) {
            // Source dir already gone — could be a re-run. Still update
            // DB so paths reflect reality.
            moved.set(r.placeId, { from: currentSeg, to: desiredSeg, srcMissing: true });
            dirsSrcMissing++;
            continue;
        }
        if (fsMod.existsSync(dstDir)) {
            // Destination already exists — leave source alone (no merge
            // logic; would risk overwriting newer files). DB still gets
            // updated below.
            moved.set(r.placeId, { from: currentSeg, to: desiredSeg, dstExisted: true });
            dirsAlreadyTarget++;
            continue;
        }
        try {
            fsMod.renameSync(srcDir, dstDir);
            moved.set(r.placeId, { from: currentSeg, to: desiredSeg });
            dirsMoved++;
        } catch (err) {
            console.warn(`[relayout] rename ${srcDir} -> ${dstDir} failed: ${err.message}`);
        }
    }

    // Pass 2: update DB
    for (const r of rows) {
        if (!r.localPath || !r.localPath.startsWith("/uploads/places/")) continue;
        const m = r.localPath.match(/^\/uploads\/places\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const currentSeg = m[1];
        const place = bySlug.get(r.placeId);
        if (!place) continue;
        const desiredSeg = slugPathSegment(place);
        if (currentSeg === desiredSeg) continue;
        const newPath = `/uploads/places/${desiredSeg}/${m[2]}`;
        await prisma.placeImage.update({
            where: { id: r.id },
            data: { localPath: newPath },
        }).catch((e) => console.warn(`[relayout] update row ${r.id}: ${e.message}`));
        rowsUpdated++;
    }

    // Pass 3: update Place.heroImageUrl for any place we moved
    for (const place of places) {
        if (!place.heroImageUrl || !place.heroImageUrl.startsWith("/uploads/places/")) continue;
        const m = place.heroImageUrl.match(/^\/uploads\/places\/([^/]+)\/(.+)$/);
        if (!m) continue;
        const currentSeg = m[1];
        const desiredSeg = slugPathSegment(place);
        if (currentSeg === desiredSeg) continue;
        const newPath = `/uploads/places/${desiredSeg}/${m[2]}`;
        await prisma.place.update({
            where: { id: place.id },
            data: { heroImageUrl: newPath },
        }).catch((e) => console.warn(`[relayout] update place ${place.id} hero: ${e.message}`));
        heroesUpdated++;
    }

    return {
        ok: true,
        dirsMoved,
        dirsAlreadyTarget,
        dirsSrcMissing,
        rowsUpdated,
        heroesUpdated,
    };
}

// Track 2 — actual file rescue. Verified 2026-05-23 via /uploads-ls:
// despite the earlier migrate-legacy-heroes endpoint reporting "1,131
// moved", the fs.renameSync calls silently no-op'd on Hostinger.
// 4,203 files are still sitting in the original FLAT layout at
// /uploads/places/{id}.{ext} + /uploads/places/{id}-large.jpg +
// /uploads/places/{id}-thumb.jpg, while every DB pointer was updated
// to id-subdir then slug-subdir paths that don't exist.
//
// This endpoint actually does the move: for every place with a slug
// and a flat-layout original file, mv {id}.{ext} → {slug}/1.{ext}
// and the variants too. Repairs PlaceImage.localPath and
// Place.heroImageUrl to point at the new subdir paths.
//
// Idempotent: skips places already migrated (slug subdir exists +
// flat files absent).
//
// GET  → dry-run
// POST → apply
async function rescueScan({ apply, limit }) {
    const places = await prisma.place.findMany({
        select: { id: true, slug: true, heroImageUrl: true },
        orderBy: { id: "asc" },
    });
    const placesDir = pathMod.join(PUBLIC_ROOT, "uploads", "places");
    let foundFlat = 0;
    let movedOriginal = 0;
    let movedThumb = 0;
    let movedLarge = 0;
    let alreadyMigrated = 0;
    let dbHeroesUpdated = 0;
    let dbRowsUpdated = 0;
    let skippedNoSlug = 0;
    let appliedCount = 0;
    const samples = [];
    const errors = [];

    for (const p of places) {
        if (limit != null && appliedCount >= limit) break;

        const seg = p.slug ? p.slug : `place-${p.id}`;
        if (!p.slug) skippedNoSlug++;
        const dstDir = pathMod.join(placesDir, seg);

        // Find any flat-layout original for this id
        let flatExt = null;
        let flatSrc = null;
        for (const ext of ["jpg", "jpeg", "png", "webp", "gif", "avif"]) {
            const candidate = pathMod.join(placesDir, `${p.id}.${ext}`);
            if (fsMod.existsSync(candidate)) {
                flatExt = ext;
                flatSrc = candidate;
                break;
            }
        }
        if (!flatSrc) {
            const dstFile = pathMod.join(dstDir, `1.jpg`);
            if (fsMod.existsSync(dstFile)) alreadyMigrated++;
            continue;
        }
        foundFlat++;

        if (samples.length < 10) {
            samples.push({ id: p.id, slug: p.slug, ext: flatExt, from: `${p.id}.${flatExt}`, to: `${seg}/1.${flatExt}` });
        }

        if (!apply) continue;
        appliedCount++;

        const perPlaceLog = { id: p.id, seg, ext: flatExt, steps: {} };
        try {
            fsMod.mkdirSync(dstDir, { recursive: true });
            perPlaceLog.steps.mkdir = "ok";
            const dstOriginal = pathMod.join(dstDir, `1.${flatExt}`);
            fsMod.renameSync(flatSrc, dstOriginal);
            perPlaceLog.steps.renameOriginal = "ok";
            movedOriginal++;

            const thumbSrc = pathMod.join(placesDir, `${p.id}-thumb.jpg`);
            if (fsMod.existsSync(thumbSrc)) {
                try {
                    fsMod.renameSync(thumbSrc, pathMod.join(dstDir, "1-thumb.jpg"));
                    perPlaceLog.steps.renameThumb = "ok";
                    movedThumb++;
                } catch (e) { perPlaceLog.steps.renameThumb = `FAIL ${e.message}`; }
            } else perPlaceLog.steps.renameThumb = "no-source";

            const largeSrc = pathMod.join(placesDir, `${p.id}-large.jpg`);
            if (fsMod.existsSync(largeSrc)) {
                try {
                    fsMod.renameSync(largeSrc, pathMod.join(dstDir, "1-large.jpg"));
                    perPlaceLog.steps.renameLarge = "ok";
                    movedLarge++;
                } catch (e) { perPlaceLog.steps.renameLarge = `FAIL ${e.message}`; }
            } else perPlaceLog.steps.renameLarge = "no-source";

            const newLocalPath = `/uploads/places/${seg}/1.${flatExt}`;
            try {
                await prisma.place.update({
                    where: { id: p.id },
                    data: { heroImageUrl: newLocalPath },
                });
                perPlaceLog.steps.updateHero = "ok";
                dbHeroesUpdated++;
            } catch (e) { perPlaceLog.steps.updateHero = `FAIL ${e.message}`; }

            try {
                await prisma.placeImage.deleteMany({
                    where: { placeId: p.id, source: "legacy" },
                });
                await prisma.placeImage.create({
                    data: {
                        placeId: p.id, position: 1, localPath: newLocalPath,
                        source: "legacy", sourceRef: null, sourceUrl: null,
                    },
                });
                perPlaceLog.steps.upsertLegacyRow = "ok";
                dbRowsUpdated++;
            } catch (e) { perPlaceLog.steps.upsertLegacyRow = `FAIL ${e.message}`; }
        } catch (err) {
            perPlaceLog.fatal = err.message;
            errors.push(perPlaceLog);
        }
        if (errors.length < 10 || apply && limit != null) {
            // Always include the first ~10 in the response while testing
            // small batches.
            if (samples.length < 20 && limit != null) {
                samples.push({ ...perPlaceLog, _log: true });
            }
        }
    }
    return {
        totalPlaces: places.length,
        skippedNoSlug,
        foundFlat,
        alreadyMigrated,
        movedOriginal,
        movedThumb,
        movedLarge,
        dbHeroesUpdated,
        dbRowsUpdated,
        appliedCount,
        samples,
        errors,
        applied: apply,
    };
}

router.get("/gallery-rescue-flat-to-slug", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10);
        const result = await rescueScan({ apply: false, limit: Number.isFinite(limit) && limit > 0 ? limit : null });
        res.json({ ok: true, mode: "dry-run", ...result });
    } catch (err) {
        console.error("[rescue dry-run] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

router.post("/gallery-rescue-flat-to-slug", async (req, res) => {
    try {
        const limit = parseInt(req.query.limit, 10);
        const result = await rescueScan({ apply: true, limit: Number.isFinite(limit) && limit > 0 ? limit : null });
        res.json({ ok: true, mode: "apply", ...result });
    } catch (err) {
        console.error("[rescue apply] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

// TEMP: diagnostic — list contents of /uploads/places dir AND a specific
// slug subdir. Used to investigate whether deploys wipe /uploads/ subdirs.
router.get("/uploads-ls", async (req, res) => {
    try {
        const dir = pathMod.join(PUBLIC_ROOT, "uploads", "places");
        if (!fsMod.existsSync(dir)) return res.json({ ok: true, exists: false });
        const subdir = req.query.sub ? pathMod.join(dir, String(req.query.sub)) : null;
        const out = {
            ok: true,
            placesDir: dir,
            totalEntries: fsMod.readdirSync(dir).length,
            subdirs: fsMod.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).slice(0, 30),
            firstFlatFiles: fsMod.readdirSync(dir).filter((n) => /^\d+\.(jpg|jpeg|png|webp|avif)$/.test(n)).slice(0, 10),
        };
        if (subdir && fsMod.existsSync(subdir)) {
            out.subdirContents = fsMod.readdirSync(subdir).map((n) => ({ name: n, size: fsMod.statSync(pathMod.join(subdir, n)).size }));
        } else if (subdir) {
            out.subdirContents = "DOES NOT EXIST";
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// EMERGENCY: roll DB pointers back to flat-layout paths because the
// Hostinger deploy mechanism wipes /uploads/ subdirs every push.
// For every Place where /uploads/places/{id}.{ext} exists on disk:
//   - Set Place.heroImageUrl = /uploads/places/{id}.{ext}
//   - Delete all PlaceImage rows for that place (they all point at
//     slug-based paths that don't exist)
// Idempotent: skips places whose hero already points at flat layout.
//
// Use ONLY after confirming the deploy-wipe issue is unfixed. Once
// /uploads/ persists across deploys, this rollback can be undone by
// re-running gallery-rescue-flat-to-slug.
router.post("/gallery-rollback-to-flat", async (req, res) => {
    try {
        const placesDir = pathMod.join(PUBLIC_ROOT, "uploads", "places");
        const places = await prisma.place.findMany({
            select: { id: true, heroImageUrl: true },
        });
        let updated = 0;
        let skippedAlready = 0;
        let skippedNoFile = 0;
        for (const p of places) {
            // Find a flat file for this id
            let ext = null;
            for (const e of ["jpg", "jpeg", "png", "webp", "gif", "avif"]) {
                if (fsMod.existsSync(pathMod.join(placesDir, `${p.id}.${e}`))) {
                    ext = e;
                    break;
                }
            }
            if (!ext) {
                if (p.heroImageUrl) {
                    // No flat file AND DB thought there was one — null it out
                    await prisma.place.update({ where: { id: p.id }, data: { heroImageUrl: null } }).catch(() => {});
                }
                skippedNoFile++;
                continue;
            }
            const flatPath = `/uploads/places/${p.id}.${ext}`;
            if (p.heroImageUrl === flatPath) {
                skippedAlready++;
                continue;
            }
            await prisma.place.update({
                where: { id: p.id },
                data: { heroImageUrl: flatPath },
            }).catch(() => {});
            updated++;
        }
        // Wipe all PlaceImage rows — they're all broken pointers right now.
        const del = await prisma.placeImage.deleteMany({});
        res.json({
            ok: true,
            placesUpdated: updated,
            skippedAlreadyFlat: skippedAlready,
            skippedNoFile: skippedNoFile,
            placeImagesDeleted: del.count,
        });
    } catch (err) {
        console.error("[gallery-rollback-to-flat] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

router.get("/gallery-relayout-to-slug", async (req, res) => {
    try {
        const result = await relayoutDryRun();
        res.json({ ok: true, mode: "dry-run", ...result });
    } catch (err) {
        console.error("[relayout dry-run] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

router.post("/gallery-relayout-to-slug", async (req, res) => {
    try {
        const result = await relayoutApply();
        res.json({ mode: "apply", ...result });
    } catch (err) {
        console.error("[relayout apply] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

// Bulk-hide places by id (set isVisible=false). Used to take obvious
// thin-duplicate rows out of the public map + search without deleting
// them, so Eric can review later via the admin UI. Idempotent.
//
// POST /api/admin/places-hide?ids=1636,2345,...
// Returns: { ok, hidden: N }
router.post("/places-hide", async (req, res) => {
    try {
        const raw = String(req.query.ids || req.body?.ids || "").trim();
        const ids = raw.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n) && n > 0);
        if (!ids.length) {
            return res.status(400).json({ ok: false, error: "no valid ids" });
        }
        const result = await prisma.place.updateMany({
            where: { id: { in: ids } },
            data: { isVisible: false },
        });
        res.json({ ok: true, requested: ids.length, hidden: result.count });
    } catch (err) {
        console.error("[places-hide] crashed:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Track 2 — purge every source='google' PlaceImage row + reset all
// affected Place.galleryLastScrapedAt back to NULL. Used after the
// 2026-05-23 size-suffix bug + position-collision bug forced a
// re-do of the entire gallery scrape pipeline. Does NOT touch legacy
// rows (source='legacy'), so the curated editorial heroes survive.
//
// Returns: { ok, deletedRows, requeuedPlaces }
router.post("/gallery-purge-google", async (req, res) => {
    try {
        const affectedPlaces = await prisma.placeImage.findMany({
            where: { source: "google" },
            select: { placeId: true },
            distinct: ["placeId"],
        });
        const placeIds = affectedPlaces.map((r) => r.placeId);
        const del = await prisma.placeImage.deleteMany({
            where: { source: "google" },
        });
        // Null both galleryLastScrapedAt (re-queue) AND heroImageUrl
        // (the legacy file at /uploads/places/{id}/1.{ext} was
        // overwritten by the buggy first-tick scrape if exts matched,
        // and the -large/-thumb variants were definitely overwritten
        // by build-thumbs running on the bad source). The next scrape
        // will set heroImageUrl to the new google photo. Brief 🍕
        // emoji fallback in the meantime — acceptable given the
        // alternative is rendering 807-byte pixelated blobs.
        const reset = await prisma.place.updateMany({
            where: { id: { in: placeIds.length ? placeIds : [-1] } },
            data: {
                galleryLastScrapedAt: null,
                heroImageUrl: null,
            },
        });
        res.json({
            ok: true,
            deletedRows: del.count,
            affectedPlaces: placeIds.length,
            requeuedPlaces: reset.count,
        });
    } catch (err) {
        console.error("[gallery-purge-google] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

// Track 2 — re-queue places that have a galleryLastScrapedAt stamp but
// no PlaceImage row from Google. Used after a scraper fix to recover
// places that got marked scraped during a buggy tick (e.g. 2026-05-23
// image-block fix) without waiting the full year for the refresh
// cadence. Idempotent — the next scrape attempt will re-stamp them.
router.post("/gallery-requeue-zero", async (req, res) => {
    try {
        const result = await prisma.$executeRawUnsafe(`
            UPDATE \`Place\` p
            LEFT JOIN (
                SELECT placeId FROM \`PlaceImage\`
                WHERE source = 'google' GROUP BY placeId
            ) g ON g.placeId = p.id
            SET p.galleryLastScrapedAt = NULL
            WHERE p.galleryLastScrapedAt IS NOT NULL
              AND g.placeId IS NULL
        `);
        res.json({ ok: true, reset: result });
    } catch (err) {
        console.error("[gallery-requeue-zero] crashed:", err);
        res.status(500).json({ ok: false, error: err.message, name: err.name });
    }
});

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

// ─── /upload-place-photo ──────────────────────────────────────────────────
// Hostinger-side receiver for opm-runner's photo pipeline. opm-runner
// downloads from Google/TA, runs sharp to produce -large + -thumb
// variants, then POSTs all 3 files + metadata here. We write them to
// persistent/uploads/places/<id>/ atomically (temp + rename) and INSERT
// a PlaceImage row. No sharp here — that's the whole point.
//
// Disk path layout (matches the URL middleware in src/app.js#L204):
//   <UPLOADS_DIR>/places/<id>/<position>.<ext>
//   <UPLOADS_DIR>/places/<id>/<position>-large.jpg
//   <UPLOADS_DIR>/places/<id>/<position>-thumb.jpg
//
// PlaceImage.localPath stores the URL-shaped path with the slug:
//   /uploads/places/<id>/<slug>/<position>.<ext>
// The URL middleware strips the slug at read time.
//
// Idempotency: relies on @@unique([placeId, sourceRef]) — a re-upload
// of the same Google photo ID returns 409 with the existing row.
// opm-runner treats 409 as success.

const UPLOADS_DIR = process.env.UPLOADS_DIR
    || path.join(__dirname, "..", "..", "..", "persistent", "uploads");

router.post("/upload-place-photo",
    photoUpload.fields([
        { name: "original", maxCount: 1 },
        { name: "large", maxCount: 1 },
        { name: "thumb", maxCount: 1 },
    ]),
    async (req, res) => {
    const tempFiles = []; // for cleanup on error
    try {
        // ── Validate fields
        const placeId = Number(req.body.placeId);
        const position = Number(req.body.position);
        const width = Number(req.body.width);
        const height = Number(req.body.height);
        const source = String(req.body.source || "").toLowerCase();
        const sourceRef = req.body.sourceRef ? String(req.body.sourceRef) : null;
        const sourceUrl = req.body.sourceUrl ? String(req.body.sourceUrl) : null;

        if (!Number.isInteger(placeId) || placeId <= 0) return res.status(400).json({ ok: false, error: "placeId required (positive integer)" });
        if (!Number.isInteger(position) || position < 1 || position > 50) return res.status(400).json({ ok: false, error: "position must be 1..50" });
        if (!Number.isFinite(width) || width <= 0) return res.status(400).json({ ok: false, error: "width required" });
        if (!Number.isFinite(height) || height <= 0) return res.status(400).json({ ok: false, error: "height required" });
        if (!/^(google|tripadvisor|trustpilot|submitted|website)$/i.test(source)) return res.status(400).json({ ok: false, error: "source must be one of: google, tripadvisor, trustpilot, submitted, website" });

        const original = req.files?.original?.[0];
        const large = req.files?.large?.[0];
        const thumb = req.files?.thumb?.[0];
        if (!original || !large || !thumb) return res.status(400).json({ ok: false, error: "original, large, thumb files all required" });

        // ── Look up place (verify exists + get slug for the URL-shaped localPath)
        const place = await prisma.place.findUnique({
            where: { id: placeId },
            select: { id: true, slug: true, isVisible: true },
        });
        if (!place) return res.status(404).json({ ok: false, error: "place not found" });
        if (!place.isVisible) return res.status(404).json({ ok: false, error: "place not visible" });

        // ── Existence check via sourceRef. Same-photo-already-uploaded is
        //     treated as a clean idempotent retry: 409 with the existing row.
        if (sourceRef) {
            const existing = await prisma.placeImage.findUnique({
                where: { placeId_sourceRef: { placeId, sourceRef } },
                select: { id: true, position: true, localPath: true },
            });
            if (existing) {
                return res.status(409).json({
                    ok: true, idempotent: true,
                    placeImageId: existing.id,
                    position: existing.position,
                    localPath: existing.localPath,
                });
            }
        }

        // ── Build disk paths
        const origExt = (original.mimetype === "image/jpeg") ? "jpg"
            : (original.mimetype === "image/png") ? "png"
            : (original.mimetype === "image/webp") ? "webp"
            : (original.mimetype === "image/avif") ? "avif"
            : (original.mimetype === "image/gif") ? "gif"
            : "jpg";
        const placeDir = path.join(UPLOADS_DIR, "places", String(placeId));
        fs.mkdirSync(placeDir, { recursive: true });

        const origPath = path.join(placeDir, `${position}.${origExt}`);
        const largePath = path.join(placeDir, `${position}-large.jpg`);
        const thumbPath = path.join(placeDir, `${position}-thumb.jpg`);

        // ── Atomic writes: write to .tmp first, rename only after all 3
        //     buffers are on disk. If anything fails mid-write, partial
        //     files never become visible to the URL handler.
        const writes = [
            { tmp: origPath + ".tmp", final: origPath, buf: original.buffer },
            { tmp: largePath + ".tmp", final: largePath, buf: large.buffer },
            { tmp: thumbPath + ".tmp", final: thumbPath, buf: thumb.buffer },
        ];
        for (const w of writes) {
            fs.writeFileSync(w.tmp, w.buf);
            tempFiles.push(w.tmp);
        }
        for (const w of writes) {
            fs.renameSync(w.tmp, w.final);
        }
        // All renames succeeded → clear the temp tracker so the catch block
        // doesn't try to remove already-renamed files.
        tempFiles.length = 0;

        // ── PlaceImage row. localPath uses the URL-shaped path so the
        //     UI can serve it via /uploads/places/<id>/<slug>/<n>.<ext>.
        const localPath = `/uploads/places/${placeId}/${place.slug}/${position}.${origExt}`;
        const created = await prisma.placeImage.create({
            data: {
                placeId,
                position,
                localPath,
                source,
                sourceRef,
                sourceUrl,
                width: Math.round(width),
                height: Math.round(height),
                bytes: original.size,
            },
            select: { id: true, position: true, localPath: true },
        });

        res.status(201).json({
            ok: true,
            placeImageId: created.id,
            position: created.position,
            localPath: created.localPath,
        });
    } catch (err) {
        // Clean up any temp files we wrote before the error.
        for (const t of tempFiles) {
            try { fs.unlinkSync(t); } catch (_) { /* best effort */ }
        }
        // Multer + Prisma errors mostly already have helpful messages.
        if (err.code === "P2002") {
            // Unique constraint hit despite our pre-check — race with another
            // upload of the same sourceRef. Re-look-up and return 409.
            const existing = await prisma.placeImage.findUnique({
                where: { placeId_sourceRef: { placeId: Number(req.body.placeId), sourceRef: req.body.sourceRef } },
                select: { id: true, position: true, localPath: true },
            }).catch(() => null);
            return res.status(409).json({ ok: true, idempotent: true, ...existing });
        }
        if (err instanceof multer.MulterError) {
            const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
            return res.status(status).json({ ok: false, error: err.code, message: err.message });
        }
        console.error("[upload-place-photo] crash:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── /update-place-ta ─────────────────────────────────────────────────────
// Hostinger-side receiver for opm-runner's TripAdvisor scrape. opm-runner
// hits the public TA page via Playwright, parses rating + count +
// reviews + distribution, then POSTs the structured payload here. No
// scraping, no Playwright on Hostinger — just a DB write.

router.post("/update-place-ta", express.json({ limit: "256kb" }), async (req, res) => {
    try {
        const placeId = Number(req.body.placeId);
        if (!Number.isInteger(placeId) || placeId <= 0) return res.status(400).json({ ok: false, error: "placeId required" });

        const place = await prisma.place.findUnique({ where: { id: placeId }, select: { id: true } });
        if (!place) return res.status(404).json({ ok: false, error: "place not found" });

        const data = {};
        // tripadvisorLocationId is Int? — opm-runner sends either:
        //   - a positive int (matched on TA)
        //   - -1 sentinel (we checked, no match — stop retrying for 6 months)
        //   - omitted (don't touch the column)
        if (req.body.tripadvisorLocationId !== undefined && req.body.tripadvisorLocationId !== null) {
            const id = Number(req.body.tripadvisorLocationId);
            if (Number.isFinite(id)) {
                data.tripadvisorLocationId = id;
                // 2026-05-30: when sentinel'ing (-1), stamp scrapedAt so the
                // taScrape queue's SEARCH_RETRY_DAYS clock starts. Without
                // this, sentinels stay null-scrapedAt and the old queue
                // logic re-tried them every tick.
                if (id === -1) data.tripadvisorRatingsScrapedAt = new Date();
            }
        }
        if (req.body.tripadvisorUrl !== undefined) data.tripadvisorUrl = String(req.body.tripadvisorUrl || "");
        if (req.body.tripadvisorRating !== undefined) data.tripadvisorRating = Number(req.body.tripadvisorRating);
        if (req.body.tripadvisorReviewCount !== undefined) data.tripadvisorReviewCount = Math.round(Number(req.body.tripadvisorReviewCount));
        if (req.body.tripadvisorRanking !== undefined) data.tripadvisorRanking = String(req.body.tripadvisorRanking || "");

        // Reviews JSON shape: [{ author, rating, text, relativeTime, lang? }, ...]
        if (Array.isArray(req.body.reviews)) {
            data.tripadvisorReviewsJson = JSON.stringify(req.body.reviews.slice(0, 10));
            data.tripadvisorReviewsFetchedAt = new Date();
        }

        // Distribution: [c5, c4, c3, c2, c1] integers
        if (Array.isArray(req.body.distribution) && req.body.distribution.length === 5) {
            const dist = req.body.distribution.map((n) => Math.max(0, Math.round(Number(n)) || 0));
            data.tripadvisorRatingsDistribution = dist;
            data.tripadvisorRatingsScrapedAt = new Date();
        }

        await prisma.place.update({ where: { id: placeId }, data });
        res.json({ ok: true, placeId, fieldsUpdated: Object.keys(data) });
    } catch (err) {
        console.error("[update-place-ta] crash:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── /place/:id/gallery-scraped ───────────────────────────────────────────
// Stamps galleryLastScrapedAt = now() so the queue picker doesn't
// re-pick this place for another year. Called by opm-runner after all
// photos for a place have been uploaded successfully.

router.post("/place/:id/gallery-scraped", express.json({ limit: "8kb" }), async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ ok: false, error: "id required" });
        await prisma.place.update({
            where: { id },
            data: { galleryLastScrapedAt: new Date() },
        });
        res.json({ ok: true });
    } catch (err) {
        if (err.code === "P2025") return res.status(404).json({ ok: false, error: "place not found" });
        console.error("[gallery-scraped] crash:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

module.exports = router;
