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
//   RUNNER_PHOTOS_BURN_LIMIT — places per tick for the googlePhotosBurn
//                              phase. Default 0 (phase disabled). Set
//                              to e.g. 30 to drain the candidate pool
//                              at ~$1.20/tick (~$0.04/place for 5 photos
//                              via Place Details + Place Photo API).
//                              Disable by leaving unset/0.

const path = require('path');
const fs = require('fs');
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

// Dispatch the photo-download jobs collected on Unraid this tick to
// Hostinger so the bytes get fetched before lh3 URLs expire. Splits
// the jobs into chunks small enough to fit under Hostinger's LiteSpeed
// proxy timeout (~30-60s typical) — large batches were timing out at
// 500 even though the work itself completed in the live worker.
const PUSH_CHUNK_SIZE = 8; // ~40 photos per chunk = ~30-40s on Hostinger
async function pushGalleryJobs(jobs) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        return { skipped: true, reason: 'HOSTINGER_URL or ADMIN_API_KEY not set' };
    }
    if (!Array.isArray(jobs) || jobs.length === 0) {
        return { skipped: true, reason: 'no jobs this tick' };
    }
    const url = `${HOSTINGER_URL}/api/admin/gallery-download`;
    const chunks = [];
    for (let i = 0; i < jobs.length; i += PUSH_CHUNK_SIZE) {
        chunks.push(jobs.slice(i, i + PUSH_CHUNK_SIZE));
    }
    const totals = { processed: 0, inserted: 0, skipped: 0, failed: 0, chunkFails: 0 };
    const errors = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: {
                    'x-api-key': ADMIN_API_KEY,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ jobs: chunks[i] }),
            });
            const body = await res.text().catch(() => '');
            if (!res.ok) {
                totals.chunkFails++;
                errors.push(`chunk ${i+1}/${chunks.length}: ${res.status} ${body.slice(0,120)}`);
                continue;
            }
            const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
            if (parsed) {
                totals.processed += parsed.processed || 0;
                totals.inserted  += parsed.inserted  || 0;
                totals.skipped   += parsed.skipped   || 0;
                totals.failed    += parsed.failed    || 0;
            }
        } catch (err) {
            totals.chunkFails++;
            errors.push(`chunk ${i+1}/${chunks.length}: ${err.message}`);
        }
    }
    return {
        ok: totals.chunkFails === 0,
        chunks: chunks.length,
        ...totals,
        errors: errors.length ? errors.slice(0, 3) : undefined,
    };
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
        // galleryScrape stats (Track 2). selfHealed prints even at 0 so
        // the line confirms the mechanism is running each tick.
        p.scraped != null   && `scraped=${p.scraped}`,
        p.noPhotos          && `noPhotos=${p.noPhotos}`,
        p.captcha           && `captcha=${p.captcha}`,
        p.failed            && `failed=${p.failed}`,
        p.selfHealed != null && `selfHealed=${p.selfHealed}`,
        p.dupes ?            `dupes=${p.dupes}` : null,
        p.errors ?           `errors=${p.errors}` : null,
        // googlePhotosBurn stats
        p.processed != null && `processed=${p.processed}`,
        p.details != null   && `details=${p.details}`,
        p.photos != null    && `photos=${p.photos}`,
        p.inserted != null  && `inserted=${p.inserted}`,
        p.estCostUsd != null && `cost=$${p.estCostUsd}`,
        p.remainingCandidates != null && `remaining=${p.remainingCandidates}`,
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

    // Push photo-source jobs from this tick. Two paths:
    //
    //   v1 (legacy) — POST URLs to Hostinger /api/admin/gallery-download.
    //     Hostinger fetches bytes, runs sharp, writes files. Heavy on
    //     Hostinger CPU; was the source of the 120-process spike.
    //
    //   v2 (OPM_PIPELINE_V2=true) — opm-runner downloads bytes, runs
    //     sharp locally, POSTs the 3 finished files per photo to
    //     Hostinger /api/admin/upload-place-photo. Hostinger does
    //     multipart-receive + atomic write + 1 DB insert per call.
    //     Sharp never runs on Hostinger.
    //
    // The legacy path stays callable for 2 weeks as a rollback safety
    // net. Toggle by setting OPM_PIPELINE_V2=true in the opm-runner env.
    const useV2 = String(process.env.OPM_PIPELINE_V2 || "").toLowerCase() === "true";
    try {
        const phases = result?.phases || [];
        const galleryJobs = phases.find(p => p.name === 'galleryScrape')?.jobs || [];
        const burnJobs = phases.find(p => p.name === 'googlePhotosBurn')?.jobs || [];
        const allJobs = [...galleryJobs, ...burnJobs];
        if (allJobs.length === 0) {
            console.log(`[runner]   photo push: SKIP (no jobs this tick)`);
        } else if (useV2) {
            // v2 path — load lazily so opm-runner without the pipeline
            // env vars set doesn't crash on require().
            const { processPlace, stampGalleryScraped, maxPosition } = require('../enrichment/process-and-upload-photos');
            const { prisma } = require('../lib/bootstrap');
            const tag = `gallery=${galleryJobs.length} burn=${burnJobs.length}`;
            let uploaded = 0, failed = 0;
            for (const job of allJobs) {
                const startPosition = (await maxPosition(prisma, job.placeId)) + 1;
                const r = await processPlace({
                    placeId: job.placeId,
                    slug: job.slug,
                    source: 'google',
                    photos: job.photos,
                    startPosition,
                });
                uploaded += r.uploaded || 0;
                failed += r.failed || 0;
                if (r.uploaded > 0) {
                    await stampGalleryScraped(job.placeId);
                }
            }
            console.log(`[runner]   photo push v2: places=${allJobs.length} uploaded=${uploaded} failed=${failed}  [${tag}]`);
        } else {
            const push = await pushGalleryJobs(allJobs);
            const tag = `gallery=${galleryJobs.length} burn=${burnJobs.length}`;
            if (push.skipped) {
                console.log(`[runner]   photo push: SKIP (${push.reason})  [${tag}]`);
            } else {
                const status = push.ok ? 'OK' : `FAIL (${push.chunkFails}/${push.chunks} chunks)`;
                console.log(`[runner]   photo push: ${status}  chunks=${push.chunks} processed=${push.processed} inserted=${push.inserted} skipped=${push.skipped} failed=${push.failed}  [${tag}]`);
                if (push.errors) push.errors.forEach((e) => console.warn(`[runner]     ${e}`));
            }
        }
    } catch (err) {
        console.warn(`[runner]   photo push: crash ${err.message}`);
    }

    // v2-only scrape phases. Each pulls a tiny per-tick batch from
    // its own queue + writes back to Hostinger via the existing
    // /api/admin/* endpoints. Gated on the same OPM_PIPELINE_V2 flag
    // so flipping that env var off rolls back to "Hostinger does the
    // photo work; nothing else extra."
    //
    // Tick budget: at 30-min cadence with 3-place limits per scrape
    // type, the runner touches ~6 places per hour per phase — plenty
    // of throughput against a 90-day TA refresh + 30-day ratings-dist
    // refresh, gentle on both opm-runner CPU and Hostinger HTTP load.
    if (useV2) {
        // Google ratings distribution scrape.
        try {
            const { run: runRatingsDist } = require('../enrichment/scrape-google-ratings-dist');
            const r = await runRatingsDist({ limit: 3, disconnect: false });
            if (r.skipped) {
                console.log(`[runner]   ratingsDist: SKIP (${r.reason})`);
            } else {
                console.log(`[runner]   ratingsDist: scraped=${r.stats?.scraped || 0} failed=${r.stats?.failed || 0}`);
            }
        } catch (err) {
            console.warn(`[runner]   ratingsDist: crash ${err.message}`);
        }

        // TripAdvisor scrape (uses CloakBrowser, separate browser instance).
        try {
            const { run: runTaScrape } = require('../enrichment/scrape-tripadvisor');
            const r = await runTaScrape({ limit: 3, disconnect: false });
            if (r.scraped === 0 && r.failed === 0) {
                console.log(`[runner]   taScrape: queue empty`);
            } else {
                console.log(`[runner]   taScrape: scraped=${r.scraped || 0} found=${r.found || 0} miss=${r.miss || 0} photos+${r.photosUploaded || 0} failed=${r.failed || 0}`);
            }
        } catch (err) {
            console.warn(`[runner]   taScrape: crash ${err.message}`);
        }

        // Playwright place resolver (for new submissions without googlePlaceId).
        try {
            const { run: runResolve } = require('../enrichment/scrape-resolve');
            const r = await runResolve({ limit: 3, disconnect: false });
            if (r.resolved === 0 && r.missed === 0) {
                console.log(`[runner]   resolve(v2): queue empty`);
            } else {
                console.log(`[runner]   resolve(v2): resolved=${r.resolved || 0} missed=${r.missed || 0} mismatch=${r.mismatch || 0} captcha=${r.captcha || 0}`);
            }
        } catch (err) {
            console.warn(`[runner]   resolve(v2): crash ${err.message}`);
        }

        // Gemini descriptions — pick places that have Google review quotes
        // (from the ratingsDist piggyback) but no description yet, and ask
        // Gemini 2.5 Flash Lite to summarize the reviews into a 2-sentence
        // blurb. The downstream generate-descriptions.js script reads its
        // input from data/cache/google-reviews-cache.json (legacy path),
        // so we hydrate that file from DB before invoking — bridges the
        // old cache-file flow to the new DB-stored reviews shape.
        //
        // Limit 20/tick. Gemini free tier (gemini-2.5-flash-lite) is
        // 1000 RPD as of Google's 2025-12-07 quota cut (was 1500). At the
        // 60-min default interval that's 20*24 = 480/day (safe). If the
        // interval is dropped to 30 min, 20*48 = 960/day = 96% of cap —
        // lower this cap to ~15 first. 4100ms delay keeps us under 15 RPM.
        // Bump GEMINI_DELAY_MS in env if rate-limit errors appear.
        if (!SKIP.includes('descriptions')) {
            try {
                const { prisma } = require('../lib/bootstrap');
                const candidates = await prisma.place.findMany({
                    where: {
                        isVisible: true,
                        descriptionHtml: null,
                        // Eligible if we have EITHER Google or TripAdvisor review
                        // text. TA reviews were previously fetched + logged here
                        // but never used for descriptions, so places with only TA
                        // reviews (e.g. high-id spots the free Google review
                        // scrape never reaches) sat description-less forever.
                        OR: [
                            { googleReviewsJson: { not: null } },
                            { tripadvisorReviewsJson: { not: null } },
                        ],
                    },
                    select: {
                        id: true,
                        name: true,
                        city: true,
                        googleReviewsJson: true,
                        tripadvisorReviewsJson: true,
                    },
                    orderBy: [{ enrichPriorityAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }],
                    take: 20,
                });
                if (!candidates.length) {
                    console.log(`[runner]   descriptions: queue empty`);
                } else {
                    // Photo breakdown by source for the candidate set —
                    // single grouped query so we can log "Ng + Mta photos"
                    // alongside the review breakdown.
                    const candIds = candidates.map(c => c.id);
                    const photoGroups = await prisma.placeImage.groupBy({
                        by: ['placeId', 'source'],
                        where: { placeId: { in: candIds }, isHidden: false },
                        _count: { _all: true },
                    }).catch(() => []);
                    const photoCounts = new Map(); // placeId → { google, tripadvisor, other }
                    for (const g of photoGroups) {
                        const slot = photoCounts.get(g.placeId) || { google: 0, tripadvisor: 0, other: 0 };
                        const src = (g.source || '').toLowerCase();
                        if (src === 'google') slot.google += g._count._all;
                        else if (src === 'tripadvisor' || src === 'ta') slot.tripadvisor += g._count._all;
                        else slot.other += g._count._all;
                        photoCounts.set(g.placeId, slot);
                    }

                    // Per-candidate breakdown — what data sources we have
                    // for each place going into the Gemini call.
                    console.log(`[runner]   descriptions: queue ${candidates.length} places`);
                    const cacheDir = path.join(ROOT, 'data', 'cache');
                    fs.mkdirSync(cacheDir, { recursive: true });
                    const cachePath = path.join(cacheDir, 'google-reviews-cache.json');
                    const cache = {};
                    for (const p of candidates) {
                        let gReviews = [];
                        try {
                            gReviews = JSON.parse(p.googleReviewsJson) || [];
                            if (!Array.isArray(gReviews)) gReviews = [];
                        } catch { gReviews = []; }
                        let taReviews = [];
                        try {
                            taReviews = JSON.parse(p.tripadvisorReviewsJson || '[]') || [];
                            if (!Array.isArray(taReviews)) taReviews = [];
                        } catch { taReviews = []; }
                        const photos = photoCounts.get(p.id) || { google: 0, tripadvisor: 0, other: 0 };
                        const otherStr = photos.other ? ` + ${photos.other} other` : '';
                        console.log(`[descriptions] #${p.id} "${p.name}" (${p.city || '?'}) — reviews: ${gReviews.length}g + ${taReviews.length}ta, photos: ${photos.google}g + ${photos.tripadvisor}ta${otherStr}`);

                        // Hydrate the legacy cache shape the script expects:
                        //   { [placeId]: { reviews: [{ text, ... }] } }
                        // Prefer Google review text; fall back to TripAdvisor
                        // when Google has none. Both share the { text, ... }
                        // shape usableReviewTexts() reads.
                        const reviewsForDesc = gReviews.length ? gReviews : taReviews;
                        if (reviewsForDesc.length) {
                            cache[String(p.id)] = { reviews: reviewsForDesc };
                        }
                    }

                    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));
                    const cacheCount = Object.keys(cache).length;
                    if (cacheCount === 0) {
                        console.log(`[runner]   descriptions: 0 candidates had usable review JSON, skipping`);
                    } else {
                        const { run: runDescriptions } = require('../enrichment/generate-descriptions');
                        const r = await runDescriptions({
                            apply: true,
                            limit: 20,
                            reconnectMidLoop: false,
                        });
                        console.log(`[runner]   descriptions: written=${r.written || 0} skipped=${r.skipped || 0} failed=${r.failed || 0}`);
                    }
                }
            } catch (err) {
                console.warn(`[runner]   descriptions: crash ${err.message}`);
            }
        }
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
