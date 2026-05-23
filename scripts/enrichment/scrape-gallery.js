#!/usr/bin/env node
// Track 2 — galleryScrape phase. Runs on the Unraid opm-runner.
//
// For each place in the queue, drives Playwright to Google Maps via
// googlePlaceId, extracts up to 10 lh3.googleusercontent.com photo
// URLs from the carousel, and returns the URL list as a "job" payload.
//
// IMPORTANT: this script does NOT download bytes or write files. The
// urls it returns expire in MINUTES (see Track 1 regression notes from
// 2026-05-23 in notes/sessions/) so the caller MUST hand them off to
// the Hostinger galleryDownload phase immediately. The caller pattern,
// mirroring the existing localizeImages dispatch:
//
//   const result = await run({ limit: 10 });
//   await fetch(`${HOSTINGER_URL}/api/admin/gallery-download`, {
//       method: "POST",
//       headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
//       body: JSON.stringify({ jobs: result.jobs }),
//   });
//
// Queue logic:
//   - Visible places only
//   - With a googlePlaceId (required for direct nav)
//   - Either never gallery-scraped OR last scraped > 365 days ago (yearly refresh per docs/track2-photo-gallery.md decision #10)
//   - Ordered by id ASC (decision #9)
//   - Default limit 10/tick (decision #8)
//
// CAPTCHA handling: maintains a backoff cache at data/cache/gallery-backoff.json.
// On detected CAPTCHA: log the strike, abort current tick early. Three strikes
// in 24h escalates from 6h backoff to 7-day cooldown.

const fs = require("fs");
const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { createGmapsPage, scrapePhotos } = require("../lib/gmaps");

const BACKOFF_FILE = path.join(ROOT, "data", "cache", "gallery-backoff.json");
const STRIKE_WINDOW_MS = 24 * 60 * 60 * 1000;
const FIRST_BACKOFF_MS = 6 * 60 * 60 * 1000;
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_DAYS = 365;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadBackoff() {
    try { return JSON.parse(fs.readFileSync(BACKOFF_FILE, "utf8")); }
    catch { return { captchas: [], blockedUntil: null, cooldownUntil: null }; }
}
function saveBackoff(state) {
    fs.mkdirSync(path.dirname(BACKOFF_FILE), { recursive: true });
    fs.writeFileSync(BACKOFF_FILE, JSON.stringify(state, null, 2));
}
function isBlocked(state) {
    const now = Date.now();
    if (state.cooldownUntil && new Date(state.cooldownUntil).getTime() > now) {
        return { blocked: true, reason: "cooldown", until: state.cooldownUntil };
    }
    if (state.blockedUntil && new Date(state.blockedUntil).getTime() > now) {
        return { blocked: true, reason: "backoff", until: state.blockedUntil };
    }
    return { blocked: false };
}
function recordStrike(state) {
    const now = Date.now();
    state.captchas = (state.captchas || []).filter(t => now - new Date(t).getTime() < STRIKE_WINDOW_MS);
    state.captchas.push(new Date(now).toISOString());
    if (state.captchas.length >= 3) {
        state.cooldownUntil = new Date(now + COOLDOWN_MS).toISOString();
        state.escalation = "3-strikes-7day-cooldown";
    } else {
        state.blockedUntil = new Date(now + FIRST_BACKOFF_MS).toISOString();
    }
    return state;
}

async function pickQueue(limit) {
    const ttlBoundary = new Date(Date.now() - REFRESH_TTL_DAYS * 86400_000);
    return prisma.place.findMany({
        where: {
            isVisible: true,
            googlePlaceId: { not: null },
            OR: [
                { galleryLastScrapedAt: null },
                { galleryLastScrapedAt: { lt: ttlBoundary } },
            ],
        },
        select: {
            id: true, name: true, city: true, slug: true,
            addressLine: true, lat: true, lng: true,
            googlePlaceId: true,
        },
        orderBy: { id: "asc" },
        take: limit,
    });
}

// Returns:
//   { ok: true, jobs: [{ placeId, name, city, photos: [{sourceUrl, sourceRef}] }], stats, backoff }
//   { ok: true, blocked: true, reason, until }      if currently in cooldown
//
// Each row in jobs.photos has up to 10 entries. Caller posts the whole
// payload to Hostinger's /api/admin/gallery-download in one request.
async function run({ limit = 10, disconnect = true } = {}) {
    const state = loadBackoff();
    const blockStatus = isBlocked(state);
    if (blockStatus.blocked) {
        console.log(`[galleryScrape] ${blockStatus.reason} active until ${blockStatus.until} — skipping tick`);
        if (disconnect) await prisma.$disconnect();
        return { ok: true, skipped: true, ...blockStatus };
    }

    const queue = await pickQueue(limit);
    if (!queue.length) {
        console.log("[galleryScrape] queue empty (all places gallery-scraped within TTL)");
        if (disconnect) await prisma.$disconnect();
        return { ok: true, scraped: 0, jobs: [] };
    }

    console.log(`[galleryScrape] queue ${queue.length} places`);
    // Default page setup (images/media/font blocked) — tick 2 (allowImages
    // = true) yielded 3/10 successes vs tick 1's 6/10 with blocking on.
    // The real bug was the click-order in scrapePhotos picking the single-
    // photo lightbox before the See-photos grid (fixed 2026-05-23). Image
    // blocking stays on by default; we get URLs from the img.src
    // attribute which Google sets even when the network fetch is aborted.
    const { browser, page } = await createGmapsPage();
    const jobs = [];
    const stats = { scraped: 0, captcha: 0, noPhotos: 0, failed: 0 };
    let captchaHit = false;

    for (const p of queue) {
        // Pass name + addressLine + city + lat/lng so scrapePhotos can:
        //   1. Fall back to name+addr+city search if the place_id resolves
        //      to an address card or wrong entity (Forneria case)
        //   2. Detect coord mismatch when place_id points at a venue
        //      that's > 200m from our DB lat/lng (Marino case)
        const result = await scrapePhotos(page, {
            googlePlaceId: p.googlePlaceId,
            name: p.name,
            city: p.city,
            addressLine: p.addressLine,
            lat: p.lat,
            lng: p.lng,
            maxPhotos: 10,
        });

        if (result.captcha) {
            console.warn(`[galleryScrape] #${p.id} CAPTCHA — aborting tick`);
            stats.captcha++;
            captchaHit = true;
            // Mark this place as just-scraped so the next tick (post-backoff) moves on
            // — we'd rather skip than re-trigger the CAPTCHA on the same place.
            await prisma.place.update({
                where: { id: p.id },
                data: { galleryLastScrapedAt: new Date() },
            }).catch(() => {});
            break;
        }

        if (result.error) {
            console.warn(`[galleryScrape] #${p.id} "${p.name}" — error: ${result.error}`);
            stats.failed++;
            await prisma.place.update({
                where: { id: p.id },
                data: { galleryLastScrapedAt: new Date() },
            }).catch(() => {});
            continue;
        }

        if (!result.photos || !result.photos.length) {
            const reason = result.reason || "empty";
            console.log(`[galleryScrape] #${p.id} "${p.name}" — 0 photos (${reason})`);
            // Surface the diagnostic data added in gmaps.js scrapePhotos
            // when the entrypoint click succeeded but extraction yielded
            // nothing. Lets us diagnose canvas-rendering / wrong-click /
            // dropped-URL cases from the runner log alone.
            if (result.debug) {
                const d = result.debug;
                const fb = result.viaFallback ? " fallback=yes" : " fallback=no";
                const dist = d.distM != null ? ` distM=${d.distM}` : "";
                const wf = d.wantsFallback != null ? ` wantsFallback=${d.wantsFallback}` : "";
                const cm = d.coordMismatch != null ? ` coordMismatch=${d.coordMismatch}` : "";
                console.log(`[galleryScrape]   debug: via=${result.openVia || "n/a"}${fb}${wf}${cm}${dist} heading="${d.heading || ""}" imgs=${d.totalImgs} lh3=${d.lh3Imgs} bg=${d.bgUrls} dialog=${d.hasDialog} feed=${d.hasFeed} hasResults=${d.hasResults} title="${d.title || ""}"`);
                if (d.finalUrl) {
                    console.log(`[galleryScrape]   finalUrl: ${d.finalUrl}`);
                }
                if (d.lh3Sample && d.lh3Sample.length) {
                    console.log(`[galleryScrape]   lh3 sample: ${d.lh3Sample.join(" | ")}`);
                }
                if (d.bgSample && d.bgSample.length) {
                    console.log(`[galleryScrape]   bg  sample: ${d.bgSample.join(" | ")}`);
                }
            }
            stats.noPhotos++;
            await prisma.place.update({
                where: { id: p.id },
                data: { galleryLastScrapedAt: new Date() },
            }).catch(() => {});
            continue;
        }

        console.log(`[galleryScrape] #${p.id} "${p.name}" — ${result.photos.length} photos`);
        jobs.push({
            placeId: p.id,
            name: p.name,
            city: p.city,
            slug: p.slug,
            photos: result.photos,
        });
        stats.scraped++;

        // Polite delay between places. Doesn't affect URL freshness since
        // the URLs are still valid for minutes; this just keeps us under
        // Google's per-IP heuristics.
        await sleep(2500);
    }

    await browser.close().catch(() => {});

    if (captchaHit) {
        const next = recordStrike(state);
        saveBackoff(next);
        console.warn(`[galleryScrape] strike recorded — ${next.captchas.length}/3, blocked until ${next.cooldownUntil || next.blockedUntil}`);
    }

    if (disconnect) await prisma.$disconnect();
    return { ok: true, jobs, stats };
}

module.exports = { run };

if (require.main === module) {
    const args = process.argv.slice(2);
    const limit = (() => {
        const i = args.indexOf("--limit");
        if (i === -1) return 10;
        const n = parseInt(args[i + 1], 10);
        return Number.isFinite(n) ? n : 10;
    })();
    run({ limit, disconnect: true })
        .then((r) => { console.log(JSON.stringify({ summary: r.stats || {}, jobCount: r.jobs?.length || 0 }, null, 2)); })
        .catch((e) => { console.error(e); process.exit(1); });
}
