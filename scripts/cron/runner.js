#!/usr/bin/env node
// Long-running maintenance scheduler for the Unraid Docker container.
//
// Runs runMaintenance() in a loop with a sleep between ticks instead of
// relying on external cron. Single process, single lock file, clean
// signal handling — Docker can SIGTERM us and we exit cleanly without
// leaving a stuck lock.
//
// Why a loop (not setInterval): if a tick takes longer than the
// interval (descriptions phase + 40 Gemini calls at 4.1s each = ~3 min;
// reviews + 40 Google calls; etc.), setInterval would schedule a second
// tick on top of the first, racing for the lock. The await + sleep
// pattern guarantees serial execution and predictable spacing.
//
// Env vars:
//   DATABASE_URL          — required; points at Hostinger MySQL
//   GOOGLE_MAPS_API_KEY   — required for resolve / photos / reviews phases
//   GEMINI_API_KEY        — required for descriptions phase
//   TRIPADVISOR_API_KEY   — required for tripadvisor phase
//   RUNNER_MODE           — "burn" (default) or "min". See MODE_PRESETS
//                           in src/services/maintenance.js.
//   RUNNER_INTERVAL_MS    — sleep between ticks in milliseconds.
//                           Default 60 * 60 * 1000 (1 hour, matches burn cadence).
//   RUNNER_SKIP           — comma-separated phase names to skip
//                           (e.g. "tripadvisor,socials" if you want them
//                            off temporarily). Empty by default.
//   RUNNER_INITIAL_DELAY_MS — sleep before the FIRST tick. Useful when
//                             multiple replicas might start at once.
//                             Default 0.
//   HOSTINGER_URL          — base URL of the live Hostinger app (e.g.
//                            https://openpizzamap.com). When set,
//                            runner.js POSTs to /api/admin/maintenance
//                            with ?only=localizeImages after each tick
//                            so the file-writing phase fires on the
//                            live filesystem. Skipped if unset.
//   ADMIN_API_KEY          — x-api-key header value for the Hostinger
//                            /api/admin/* namespace. Required when
//                            HOSTINGER_URL is set.

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { runMaintenance } = require(path.join(ROOT, 'src', 'services', 'maintenance'));

const MODE = process.env.RUNNER_MODE === 'min' ? 'min' : 'burn';
const INTERVAL_MS = parseInt(process.env.RUNNER_INTERVAL_MS, 10) || 60 * 60 * 1000;
const SKIP = (process.env.RUNNER_SKIP || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
const INITIAL_DELAY_MS = parseInt(process.env.RUNNER_INITIAL_DELAY_MS, 10) || 0;
const HOSTINGER_URL = (process.env.HOSTINGER_URL || '').replace(/\/$/, '');
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Phases that have to run on Hostinger's filesystem (write to
// public/uploads/places/, build sharp variants, etc.) — Unraid's
// in-process tick handles only DB work, then this list is dispatched
// to the live worker via HTTPS. Add new file-writing phases here as
// they're built.
const HOSTINGER_ONLY_PHASES = ['localizeImages'];

async function pingHostingerLocalize() {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        return { skipped: true, reason: 'HOSTINGER_URL or ADMIN_API_KEY not set' };
    }
    const only = HOSTINGER_ONLY_PHASES.join(',');
    const url = `${HOSTINGER_URL}/api/admin/maintenance?mode=${MODE}&only=${encodeURIComponent(only)}`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'x-api-key': ADMIN_API_KEY },
        });
        const body = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, body: body.slice(0, 200) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Track 2 — dispatch the galleryScrape jobs collected on Unraid this
// tick to Hostinger so the bytes get downloaded before the lh3 URLs
// expire. Unlike pingHostingerLocalize this is NOT fire-and-forget: we
// await the response so the runner log shows per-place insert/skip
// counts in the same tick, and so a 5xx surfaces here instead of being
// silently swallowed by the live worker.
async function pushGalleryJobs(jobs) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        return { skipped: true, reason: 'HOSTINGER_URL or ADMIN_API_KEY not set' };
    }
    if (!Array.isArray(jobs) || jobs.length === 0) {
        return { skipped: true, reason: 'no jobs from galleryScrape this tick' };
    }
    const url = `${HOSTINGER_URL}/api/admin/gallery-download`;
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'x-api-key': ADMIN_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ jobs }),
        });
        const body = await res.text().catch(() => '');
        return { ok: res.ok, status: res.status, body: body.slice(0, 400) };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

let stopping = false;
process.on('SIGTERM', () => { console.log('[runner] SIGTERM received, will exit after current tick'); stopping = true; });
process.on('SIGINT',  () => { console.log('[runner] SIGINT received, will exit after current tick');  stopping = true; });

function fmtPhase(p) {
    if (p.reason) return `${p.name}: SKIP (${p.reason})`;
    if (p.ok === false) return `${p.name}: FAIL (${(p.error || '').slice(0, 80)})`;
    const stats = [
        p.enriched != null  && `enriched=${p.enriched}`,
        p.updated != null   && `updated=${p.updated}`,
        p.saved != null     && `saved=${p.saved}`,
        p.written != null   && `written=${p.written}`,
        p.resolved != null  && `resolved=${p.resolved}`,
        p.matched != null   && `matched=${p.matched}`,
        p.cleared != null   && `cleared=${p.cleared}`,
        p.computed != null  && `computed=${p.computed}`,
        p.fetched != null   && `fetched=${p.fetched}`,
        p.published != null && `published=${p.published}`,
        p.dupes ?            `dupes=${p.dupes}` : null,
        p.errors ?           `errors=${p.errors}` : null,
    ].filter(Boolean).join(' ');
    return `${p.name}: OK (${p.durationMs}ms) ${stats}`;
}

async function tick(n) {
    console.log(`\n[runner] === tick ${n} (mode=${MODE}${SKIP.length ? `, skip=${SKIP.join(',')}` : ''}) ===`);
    const start = Date.now();
    let result = null;
    try {
        result = await runMaintenance({
            mode: MODE,
            skip: SKIP.length ? SKIP : null,
        });
        const dur = (Date.now() - start) / 1000;
        console.log(`[runner] tick ${n} complete in ${dur.toFixed(1)}s`);
        for (const p of result.phases) console.log(`[runner]   ${fmtPhase(p)}`);
    } catch (err) {
        // runMaintenance handles per-phase errors internally; reaching
        // here means orchestration crashed. Log + keep looping.
        console.error(`[runner] tick ${n} crashed:`, err.message);
        console.error(err.stack);
    }

    // Dispatch file-writing phases to Hostinger. The HTTPS call is
    // fire-and-forget by design: the route returns 202 as soon as the
    // lock is acquired and the work continues in the live worker.
    // Failures here never fail the tick — the next loop will retry.
    const ping = await pingHostingerLocalize();
    if (ping.skipped) {
        console.log(`[runner]   localize ping: SKIP (${ping.reason})`);
    } else if (ping.ok) {
        console.log(`[runner]   localize ping: ${ping.status} ${ping.body}`);
    } else {
        console.warn(`[runner]   localize ping: FAIL (${ping.error || ping.status})`);
    }

    // Track 2 — push galleryScrape jobs from this tick to Hostinger
    // for byte download. The result above contains the phase outcome;
    // we extract `jobs` from the galleryScrape phase row, if any.
    try {
        const galleryPhase = (result?.phases || []).find(p => p.name === 'galleryScrape');
        const jobs = galleryPhase?.jobs || [];
        const push = await pushGalleryJobs(jobs);
        if (push.skipped) {
            console.log(`[runner]   gallery push: SKIP (${push.reason})`);
        } else if (push.ok) {
            console.log(`[runner]   gallery push: ${push.status} ${push.body}`);
        } else {
            console.warn(`[runner]   gallery push: FAIL (${push.error || push.status})`);
        }
    } catch (err) {
        console.warn(`[runner]   gallery push: crash ${err.message}`);
    }
}

async function loop() {
    console.log(`[runner] starting — mode=${MODE} interval=${INTERVAL_MS}ms skip=[${SKIP.join(',')}]`);
    if (INITIAL_DELAY_MS > 0) {
        console.log(`[runner] initial delay ${INITIAL_DELAY_MS}ms`);
        await sleep(INITIAL_DELAY_MS);
    }
    let n = 0;
    while (!stopping) {
        n++;
        await tick(n);
        if (stopping) break;
        console.log(`[runner] sleeping ${(INTERVAL_MS / 1000).toFixed(0)}s until tick ${n + 1}`);
        // Sleep in 5-second chunks so SIGTERM gets responded to quickly.
        const wakeAt = Date.now() + INTERVAL_MS;
        while (!stopping && Date.now() < wakeAt) {
            await sleep(Math.min(5000, wakeAt - Date.now()));
        }
    }
    console.log('[runner] exiting cleanly');
    process.exit(0);
}

loop().catch((err) => {
    console.error('[runner] loop crashed:', err);
    process.exit(1);
});
