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
const { spawn } = require("child_process");
const {
    runResolveBatch,
    runPhotosBatch,
    runClearFallbackDescriptions,
} = require("./enrichment/batch");

const ROOT = path.resolve(__dirname, "..", "..");
const STATUS_FILE = path.join(ROOT, "data", "cache", "maintenance-status.json");
const LOCK_FILE = path.join(ROOT, "data", "cache", "maintenance.lock");

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

// Per-phase child-process timeout. The runtime characteristics come
// from the old GH workflows: reviews/desc are ~6-8 min for 60 rows,
// OSM is bounded by the 1.1s sleep × limit, etc. Doubled to give
// headroom for Hostinger MySQL flaps.
const PHASE_TIMEOUTS_MS = {
    reviews:            15 * 60_000,
    descriptions:       15 * 60_000,
    osm:                 5 * 60_000,
    tripadvisor:        10 * 60_000,
    socials:            10 * 60_000,
    opmRating:           5 * 60_000,
    // Playwright is ~3s/row + ~10s Chromium cold-start. burn=20 rows
    // → ~70s typical, ~3min worst-case under heavy DOM. 10 min covers
    // CAPTCHA-retry stalls.
    playwrightFallback: 10 * 60_000,
};

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

// ─── Phase runners ──────────────────────────────────────────────────────────

// Spawn a Node script as a child process. The script is run from the
// repo root so its `require('../lib/bootstrap')` resolves. stdout +
// stderr are collected (truncated to last 4KB) so they show up in the
// status JSON without bloating disk.
function spawnScript(name, scriptPath, args, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [scriptPath, ...args], {
            cwd: ROOT,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        const cap = 4096;
        child.stdout.on("data", (b) => { stdout = (stdout + b.toString()).slice(-cap); });
        child.stderr.on("data", (b) => { stderr = (stderr + b.toString()).slice(-cap); });

        const killer = setTimeout(() => {
            child.kill("SIGTERM");
            // Hard-kill if SIGTERM didn't take in 10s.
            setTimeout(() => { try { child.kill("SIGKILL"); } catch (_) {} }, 10_000);
        }, timeoutMs);

        child.on("error", (err) => {
            clearTimeout(killer);
            resolve({ ok: false, exitCode: null, error: err.message, stdout, stderr });
        });
        child.on("exit", (code, signal) => {
            clearTimeout(killer);
            resolve({
                ok: code === 0,
                exitCode: code,
                signal,
                stdout: stdout.slice(-cap),
                stderr: stderr.slice(-cap),
            });
        });
    });
}

const PHASES = [
    {
        name: "resolve",
        async run(opts) { return runResolveBatch({ limit: opts.resolve }); },
    },
    {
        name: "photos",
        async run(opts) { return runPhotosBatch({ limit: opts.photos }); },
    },
    {
        name: "reviews",
        async run(opts) {
            return spawnScript(
                "reviews",
                path.join(ROOT, "scripts", "scrapers", "scrape-reviews.js"),
                ["--apply", `--limit=${opts.reviews}`],
                PHASE_TIMEOUTS_MS.reviews,
            );
        },
    },
    {
        name: "descriptions",
        async run(opts) {
            return spawnScript(
                "descriptions",
                path.join(ROOT, "scripts", "enrichment", "generate-descriptions.js"),
                ["--apply", `--limit=${opts.descriptions}`],
                PHASE_TIMEOUTS_MS.descriptions,
            );
        },
    },
    {
        name: "osm",
        async run(opts) {
            return spawnScript(
                "osm",
                path.join(ROOT, "scripts", "enrichment", "enrich-osm.js"),
                ["--apply", `--limit=${opts.osm}`],
                PHASE_TIMEOUTS_MS.osm,
            );
        },
    },
    {
        name: "tripadvisor",
        gateHour: HOUR_GATES.tripadvisor,
        async run(opts) {
            return spawnScript(
                "tripadvisor",
                path.join(ROOT, "scripts", "enrichment", "enrich-tripadvisor.js"),
                ["--apply", `--limit=${opts.tripadvisor}`],
                PHASE_TIMEOUTS_MS.tripadvisor,
            );
        },
    },
    {
        name: "socials",
        gateHour: HOUR_GATES.socials,
        async run(opts) {
            return spawnScript(
                "socials",
                path.join(ROOT, "scripts", "backfills", "backfill-socials-from-website.js"),
                ["--apply", `--limit=${opts.socials}`],
                PHASE_TIMEOUTS_MS.socials,
            );
        },
    },
    {
        name: "opmRating",
        gateHour: HOUR_GATES.opmRating,
        async run() {
            return spawnScript(
                "opmRating",
                path.join(ROOT, "scripts", "backfills", "backfill-opm-rating.js"),
                ["--apply"],
                PHASE_TIMEOUTS_MS.opmRating,
            );
        },
    },
    {
        name: "clearFallbackDescriptions",
        async run() { return runClearFallbackDescriptions(); },
    },
    // Playwright long-tail fallback. Drives a real Chromium browser to
    // scrape phone/website/hours/rating from the Google Maps place
    // panel for rows the Places API can't resolve (small-town venues,
    // name mismatches). Per `project_enricher_backlog.md` this was the
    // phase that unstuck the long-tail rows during the 2026-05-09
    // recovery — keeping it as the last phase so a Chromium crash
    // never blocks the other 9 phases from running.
    //
    // Runs LAST on purpose: if Chromium / system-lib deps aren't
    // available on Hostinger shared, this phase exits non-zero but
    // every other phase has already completed. Status JSON will show
    // exactly which phase fails, making the "move to Unraid" decision
    // (or refactor-to-in-process decision) data-driven.
    {
        name: "playwrightFallback",
        async run(opts) {
            return spawnScript(
                "playwrightFallback",
                path.join(ROOT, "scripts", "enrichment", "resolve-via-gmaps.js"),
                ["--need-meta", "--apply", `--limit=${opts.playwrightFallback}`],
                PHASE_TIMEOUTS_MS.playwrightFallback,
            );
        },
    },
];

// ─── Orchestrator ───────────────────────────────────────────────────────────

function shouldRunPhase(phase, { force, skip, hour }) {
    if (skip && skip.includes(phase.name)) return false;
    if (force && force.includes(phase.name)) return true;
    if (phase.gateHour != null) return phase.gateHour === hour;
    return true;
}

async function runMaintenance({ mode = "min", force = null, skip = null, overrides = {} } = {}) {
    const preset = MODE_PRESETS[mode] || MODE_PRESETS.min;
    const opts = { ...preset, ...overrides };
    const startedAt = new Date();
    const hour = startedAt.getUTCHours();

    writeLock({ mode, startedAt: startedAt.getTime(), pid: process.pid });

    const phaseResults = [];
    for (const phase of PHASES) {
        if (!shouldRunPhase(phase, { force, skip, hour })) {
            phaseResults.push({ name: phase.name, skipped: true, reason: "not scheduled this hour" });
            continue;
        }
        const phaseStart = Date.now();
        let result;
        try {
            result = await phase.run(opts);
        } catch (err) {
            result = { ok: false, error: err.message, stack: err.stack };
        }
        phaseResults.push({
            name: phase.name,
            durationMs: Date.now() - phaseStart,
            ...result,
        });
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
    };

    const status = loadStatus();
    status.runs = [run, ...(status.runs || [])].slice(0, 20);
    saveStatus(status);
    clearLock();

    return run;
}

// Returns an object { accepted, reason }. If a run is already in
// flight, accepted=false and the caller should respond 409 Conflict
// (cron-job.org treats 4xx as failure → marks the tick as missed,
// which is correct behavior).
function tryStartMaintenance({ mode = "min", force = null, skip = null, overrides = {} } = {}) {
    const lock = readLock();
    if (lock) {
        return { accepted: false, reason: "already running", currentRun: lock };
    }
    // Fire-and-forget: kick off the work without awaiting, return
    // immediately so the route handler can respond 202.
    runMaintenance({ mode, force, skip, overrides }).catch((err) => {
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
    MODE_PRESETS,
    HOUR_GATES,
};
