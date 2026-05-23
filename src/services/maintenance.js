// Consolidated maintenance orchestrator. One endpoint runs the whole
// enrichment pipeline so cron-job.org (the external scheduler we use
// since Hostinger Business Node.js apps don't expose cron) only needs
// to ping a single URL.
//
// Why this exists: GitHub Actions banned `ericll93` on 2026-05-12 for
// cumulative outbound HTTP from scheduled workflows. See
// notes/sessions/2026-05-12-github-account-suspended.md. The fix is to
// move execution off GH infrastructure entirely; cron-job.org hits this
// endpoint, and the actual outbound work happens inside the Hostinger
// app worker where it's just normal app-server traffic.
//
// Two operating modes:
//   - "burn" — aggressive cadence to drain the 12-day GCP credit window
//   - "min"  — sustains the project inside every API's free daily tier
//
// Phase frequency:
//   Some phases (resolve, photos, reviews, descriptions, osm) run every
//   tick. Others (tripadvisor, socials, opmRating) only run when the
//   current UTC hour matches the phase's scheduled hour — exactly the
//   pattern the old GitHub workflows had, just collapsed into one
//   endpoint instead of six.
//
// Fire-and-forget: the route handler kicks this off and returns 202
// immediately. cron-job.org has a ~30s response timeout on free tier;
// the full pipeline can take minutes. Status is written to disk and
// queryable at /api/admin/maintenance/status.

const fs = require("fs");
const path = require("path");
const {
    runResolveBatch,
    runPhotosBatch,
    runClearFallbackDescriptions,
    runPublishReadyBatch,
} = require("./enrichment/batch");

// Scripts now expose `run(opts)` (refactored 2026-05-17 after the first
// burn-mode tick on prod revealed Prisma's "tokio timer has gone away"
// panic fires on every spawned Node child — the same Hostinger bug the
// old api.admin.js comment warned about. In-process calls share the
// already-warm Prisma client in the live worker, which doesn't panic.
const { run: runOsm } = require("../../scripts/enrichment/enrich-osm");
const { run: runTripadvisor } = require("../../scripts/enrichment/enrich-tripadvisor");
const { run: runDescriptions } = require("../../scripts/enrichment/generate-descriptions");
const { run: runPlaywrightFallback } = require("../../scripts/enrichment/resolve-via-gmaps");
const { run: runReviews } = require("../../scripts/scrapers/scrape-reviews");
const { run: runSocials } = require("../../scripts/backfills/backfill-socials-from-website");
const { run: runOpmRating } = require("../../scripts/backfills/backfill-opm-rating");
const { run: runDownloadImages } = require("../../scripts/backfills/download-images");
const { run: runScrapeGallery } = require("../../scripts/enrichment/scrape-gallery");

const ROOT = path.resolve(__dirname, "..", "..");
const CACHE_DIR = path.join(ROOT, "data", "cache");
const STATUS_FILE = path.join(CACHE_DIR, "maintenance-status.json");
const LOCK_FILE = path.join(CACHE_DIR, "maintenance.lock");

// On fresh Hostinger deploys data/cache doesn't exist yet — scripts/lib/
// bootstrap.js creates it on require, but maintenance.js doesn't go
// through bootstrap (it imports src/db.js directly). Ensure the dir
// exists on first require so writeLock / saveStatus don't fail ENOENT.
fs.mkdirSync(CACHE_DIR, { recursive: true });

// ─── Mode presets ───────────────────────────────────────────────────────────
//
// Burn mode targets ~$200 GCP credit over 12 days. Math: Google Places
// API (New) Text Search + Details runs ~$30 per 1,000 calls combined;
// $200 / $30 × 1000 = 6,600 places. /24 cron ticks per day / 12 days =
// ~23 places/tick. We round to 40/tick to absorb cache hits + skipped
// rows — actual API charges stay well inside the credit window. Photos
// share the same Google billing but have a generous free tier of their
// own (11K/mo) so we don't gate them separately.
//
// Min mode targets every API's free daily allowance with safety margin:
//   - Google Places (post-March-2025 free tier ~166/day per SKU):
//     20/tick × 8 ticks = 160/day → 6/day margin
//   - Gemini (1500 RPD per `feedback_gemini_limits.md`):
//     20/tick × 8 ticks = 160/day → 1,340/day margin
//   - TripAdvisor (4,000/mo self-imposed cap, 1k headroom under 5k/mo
//     free tier per `feedback_tripadvisor_quota.md`):
//     130/day = 3,900/mo → 100/mo margin
//   - Overpass (unlimited, 1qps politeness):
//     20/tick × 8 ticks = 160/day → trivially polite
const MODE_PRESETS = {
    burn: {
        resolve: 40,
        photos: 40,
        reviews: 40,
        descriptions: 40,
        osm: 20,
        tripadvisor: 150,
        socials: 300,
        opmRating: true,
        playwrightFallback: 20,
        localizeImages: 200,
        galleryScrape: 10,
    },
    min: {
        resolve: 20,
        photos: 20,
        reviews: 20,
        descriptions: 20,
        osm: 20,
        tripadvisor: 130,
        socials: 300,
        opmRating: true,
        playwrightFallback: 10,
        localizeImages: 100,
        galleryScrape: 10,
    },
};

// Hour-gated phases — only run on the matching UTC hour, regardless of
// how often the cron pings us. Same daily schedule the old GitHub
// workflows had, collapsed into the single maintenance endpoint.
const HOUR_GATES = {
    tripadvisor: 2,   // 02:xx UTC (was: cron '30 2 * * *')
    socials:     3,   // 03:xx UTC (was: cron '0 3 * * *')
    opmRating:   4,   // 04:xx UTC (was: cron '17 4 * * *')
};

// All phases now run in-process; child_process is no longer used. The
// fire-and-forget pattern in tryStartMaintenance() means a slow phase
// can't block the HTTP response anyway. Per-phase timeouts removed —
// individual phases' own internal pacing (Gemini delays, Overpass 1qps,
// TA rate-limits) bound their runtime in practice.

// ─── Single-flight lock ─────────────────────────────────────────────────────
//
// Prevents cron-job.org overlapping ticks (in burn mode the cadence is
// hourly but a heavy run could spill past an hour during Hostinger DB
// flakes). Stale-lock detection: if the lock is older than the longest
// possible run + buffer, assume the previous run died and reclaim.
const STALE_LOCK_MS = 40 * 60_000;

function readLock() {
    try {
        const raw = fs.readFileSync(LOCK_FILE, "utf8");
        const data = JSON.parse(raw);
        if (Date.now() - data.startedAt > STALE_LOCK_MS) return null;
        return data;
    } catch (_) {
        return null;
    }
}

function writeLock(data) {
    fs.writeFileSync(LOCK_FILE, JSON.stringify(data));
}

function clearLock() {
    try { fs.unlinkSync(LOCK_FILE); } catch (_) { /* not present */ }
}

// ─── Status file (queryable via /api/admin/maintenance/status) ──────────────

function loadStatus() {
    try { return JSON.parse(fs.readFileSync(STATUS_FILE, "utf8")); }
    catch (_) { return { runs: [] }; }
}

function saveStatus(status) {
    fs.writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2));
}

function getMaintenanceStatus() {
    const status = loadStatus();
    const lock = readLock();
    return {
        ok: true,
        running: !!lock,
        currentRun: lock || null,
        lastRun: status.runs[0] || null,
        recentRuns: status.runs.slice(0, 10),
    };
}

// ─── Phase runners (all in-process) ─────────────────────────────────────────

const PHASES = [
    {
        name: "resolve",
        async run(opts) { return runResolveBatch({ limit: opts.resolve }); },
    },
    {
        name: "photos",
        async run(opts) { return runPhotosBatch({ limit: opts.photos }); },
    },
    // Downloads remote heroImageUrl values (signed lh3 Google photo URLs,
    // scraper-host hotlinks) to public/uploads/places/{id}.{ext} so the
    // bytes survive when the original URL rotates. Gated to Hostinger
    // because the bytes must land on the live filesystem — Unraid's
    // opm-runner ticks would otherwise write into a container disk that
    // the public site can't serve from. Set OPM_HOST=hostinger in the
    // Hostinger Node.js app env to enable.
    {
        name: "localizeImages",
        async run(opts) {
            if (process.env.OPM_HOST !== "hostinger") {
                return { ok: true, skipped: true, reason: "OPM_HOST != hostinger" };
            }
            return runDownloadImages({
                limit: opts.localizeImages,
                disconnect: false,
            });
        },
    },
    {
        name: "reviews",
        async run(opts) {
            return runReviews({ apply: true, limit: opts.reviews });
        },
    },
    {
        name: "descriptions",
        async run(opts) {
            // reconnectMidLoop: false so the script doesn't disconnect the
            // shared worker Prisma client every 30 rows.
            return runDescriptions({ apply: true, limit: opts.descriptions, reconnectMidLoop: false });
        },
    },
    {
        name: "osm",
        async run(opts) {
            return runOsm({ apply: true, limit: opts.osm });
        },
    },
    {
        name: "tripadvisor",
        gateHour: HOUR_GATES.tripadvisor,
        async run(opts) {
            return runTripadvisor({ apply: true, limit: opts.tripadvisor });
        },
    },
    {
        name: "socials",
        gateHour: HOUR_GATES.socials,
        async run(opts) {
            return runSocials({ apply: true, limit: opts.socials });
        },
    },
    {
        name: "opmRating",
        gateHour: HOUR_GATES.opmRating,
        async run() {
            return runOpmRating({ apply: true });
        },
    },
    {
        name: "clearFallbackDescriptions",
        async run() { return runClearFallbackDescriptions(); },
    },
    // Publishes hidden chatbot-created rows once enrichment has filled
    // in enough fields. Cheap pure-SQL phase — no external API calls —
    // so it runs every tick regardless of mode.
    {
        name: "publishReady",
        async run() { return runPublishReadyBatch({ limit: 100 }); },
    },
    // Playwright long-tail fallback. Drives a real Chromium browser to
    // scrape phone/website/hours/rating from the Google Maps place
    // panel for rows the Places API can't resolve. Per the 2026-05-09
    // enricher-backlog notes this was the phase that unstuck the most
    // long-tail rows during the previous recovery.
    //
    // Runs LAST on purpose: if Chromium / system-lib deps aren't
    // available on Hostinger shared (likely), this phase fails but
    // every other phase has already completed. Status JSON tells us
    // exactly what to move to Unraid if needed.
    {
        name: "playwrightFallback",
        async run(opts) {
            return runPlaywrightFallback({
                needMeta: true,
                apply: true,
                limit: opts.playwrightFallback,
            });
        },
    },
    // Track 2 — Google Maps photo scrape. Picks up to N places lacking
    // a recent gallery and runs Playwright to harvest up to 10 photo
    // URLs each. Returns `{ jobs: [...] }` in the phase result; the
    // caller (opm-runner) is responsible for POSTing those jobs to
    // Hostinger's /api/admin/gallery-download so the bytes get
    // downloaded before the lh3 URLs expire (minutes-long TTL).
    //
    // Hostinger-skipped: the in-process scrape needs the residential
    // Unraid IP to avoid Google CAPTCHAs (probe: 0 CAPTCHAs in 25s
    // from Unraid; Hostinger's shared IP gets challenged immediately).
    // OPM_HOST=hostinger short-circuits the phase so cron-job.org pings
    // don't trigger scrapes from the wrong host.
    {
        name: "galleryScrape",
        async run(opts) {
            if (process.env.OPM_HOST === "hostinger") {
                return { ok: true, skipped: true, reason: "OPM_HOST = hostinger" };
            }
            return runScrapeGallery({
                limit: opts.galleryScrape,
                disconnect: false,
            });
        },
    },
];

// ─── Orchestrator ───────────────────────────────────────────────────────────

function shouldRunPhase(phase, { force, skip, only, hour }) {
    // `only` is the strongest filter: when set, ONLY listed phases run.
    // Used by the opm-runner ping that targets just `localizeImages` on
    // Hostinger (the file-writing phase that can't run on Unraid).
    if (only && only.length && !only.includes(phase.name)) return false;
    if (skip && skip.includes(phase.name)) return false;
    if (force && force.includes(phase.name)) return true;
    if (phase.gateHour != null) return phase.gateHour === hour;
    return true;
}

// Per-phase hard timeout — if a phase doesn't return in this many ms,
// race it against a rejected promise so the orchestrator can move on.
// Without this, a hung Playwright launch or stuck HTTPS call freezes
// the whole pipeline indefinitely (lock not released for 40 min).
const PER_PHASE_TIMEOUT_MS = 8 * 60_000;

function withTimeout(promise, ms, phaseName) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
            reject(new Error(`phase "${phaseName}" timed out after ${ms}ms`));
        }, ms);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

async function runMaintenance({ mode = "min", force = null, skip = null, only = null, overrides = {} } = {}) {
    const preset = MODE_PRESETS[mode] || MODE_PRESETS.min;
    const opts = { ...preset, ...overrides };
    const startedAt = new Date();
    const hour = startedAt.getUTCHours();

    const lockState = { mode, startedAt: startedAt.getTime(), pid: process.pid, currentPhase: null };
    writeLock(lockState);

    const phaseResults = [];

    // Write the in-flight run + completed-phases snapshot after each
    // phase so /maintenance/status can show progress mid-pipeline
    // instead of only at the end. Lets us see WHICH phase is stuck if
    // a future run hangs.
    const persistProgress = () => {
        const partial = {
            mode,
            startedAt: startedAt.toISOString(),
            finishedAt: null,
            durationMs: Date.now() - startedAt.getTime(),
            phases: phaseResults,
            inFlight: true,
        };
        const status = loadStatus();
        status.runs = [partial, ...(status.runs || []).filter(r => !r.inFlight)].slice(0, 20);
        saveStatus(status);
    };

    for (const phase of PHASES) {
        if (!shouldRunPhase(phase, { force, skip, only, hour })) {
            const reason = only && only.length
                ? `not in only=[${only.join(",")}]`
                : "not scheduled this hour";
            phaseResults.push({ name: phase.name, skipped: true, reason });
            persistProgress();
            continue;
        }
        lockState.currentPhase = phase.name;
        writeLock(lockState);

        const phaseStart = Date.now();
        let result;
        try {
            result = await withTimeout(
                phase.run(opts),
                PER_PHASE_TIMEOUT_MS,
                phase.name,
            );
        } catch (err) {
            result = { ok: false, error: err.message, stack: err.stack };
        }
        phaseResults.push({
            name: phase.name,
            durationMs: Date.now() - phaseStart,
            ...result,
        });
        persistProgress();
        // Never abort the chain — Hostinger MySQL flaps, third-party APIs
        // blip, next cron tick retries. Same continue-on-error
        // philosophy the GitHub workflows had.
    }

    const finishedAt = new Date();
    const run = {
        mode,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        phases: phaseResults,
        inFlight: false,
    };

    const status = loadStatus();
    status.runs = [run, ...(status.runs || []).filter(r => !r.inFlight)].slice(0, 20);
    saveStatus(status);
    clearLock();

    return run;
}

// Force-clear a stuck lock + persist any in-flight run as aborted. Used
// when a phase hangs past its timeout and the orchestrator's own
// timeout race didn't catch it (e.g. unkillable native code in
// Chromium spawn). Idempotent.
function abortMaintenance() {
    const lock = readLock();
    if (!lock) return { ok: true, alreadyClear: true };
    const status = loadStatus();
    const partial = (status.runs || []).find(r => r.inFlight);
    if (partial) {
        partial.inFlight = false;
        partial.finishedAt = new Date().toISOString();
        partial.aborted = true;
        partial.abortReason = "manual abort via /maintenance/abort";
        saveStatus(status);
    }
    clearLock();
    return { ok: true, aborted: true, wasRunning: lock };
}

// Returns an object { accepted, reason }. If a run is already in
// flight, accepted=false and the caller should respond 409 Conflict
// (cron-job.org treats 4xx as failure → marks the tick as missed,
// which is correct behavior).
function tryStartMaintenance({ mode = "min", force = null, skip = null, only = null, overrides = {} } = {}) {
    const lock = readLock();
    if (lock) {
        return { accepted: false, reason: "already running", currentRun: lock };
    }
    // Fire-and-forget: kick off the work without awaiting, return
    // immediately so the route handler can respond 202.
    runMaintenance({ mode, force, skip, only, overrides }).catch((err) => {
        // Last-resort error capture — runMaintenance handles per-phase
        // errors already, so reaching here means something at the
        // orchestration layer crashed. Log + clear lock so the next
        // tick can proceed.
        try {
            const status = loadStatus();
            status.runs = [{
                mode,
                startedAt: new Date().toISOString(),
                error: err.message,
                stack: err.stack,
            }, ...(status.runs || [])].slice(0, 20);
            saveStatus(status);
        } catch (_) { /* don't throw from error handler */ }
        clearLock();
    });
    return { accepted: true, mode };
}

module.exports = {
    runMaintenance,
    tryStartMaintenance,
    getMaintenanceStatus,
    abortMaintenance,
    MODE_PRESETS,
    HOUR_GATES,
};
