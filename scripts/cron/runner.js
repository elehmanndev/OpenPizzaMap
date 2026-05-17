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

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { runMaintenance } = require(path.join(ROOT, 'src', 'services', 'maintenance'));

const MODE = process.env.RUNNER_MODE === 'min' ? 'min' : 'burn';
const INTERVAL_MS = parseInt(process.env.RUNNER_INTERVAL_MS, 10) || 60 * 60 * 1000;
const SKIP = (process.env.RUNNER_SKIP || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
const INITIAL_DELAY_MS = parseInt(process.env.RUNNER_INITIAL_DELAY_MS, 10) || 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
        p.dupes ?            `dupes=${p.dupes}` : null,
        p.errors ?           `errors=${p.errors}` : null,
    ].filter(Boolean).join(' ');
    return `${p.name}: OK (${p.durationMs}ms) ${stats}`;
}

async function tick(n) {
    console.log(`\n[runner] === tick ${n} (mode=${MODE}${SKIP.length ? `, skip=${SKIP.join(',')}` : ''}) ===`);
    const start = Date.now();
    try {
        const result = await runMaintenance({
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
