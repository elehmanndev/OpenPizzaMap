#!/usr/bin/env node
// One-shot: discover tripadvisorLocationId for every place that doesn't
// have one. Two-tier strategy per place:
//
//   1. TA /location/search — free + uncounted. Returns name-similarity
//      ranked candidates; pick if best score >= NAME_MATCH_MIN (0.7).
//   2. Google "site:tripadvisor.com <name> <city>" via Playwright on
//      opm-runner's residential IP. Google indexes the full TA site
//      (including venues missing from TA's API search, like Cipriano).
//      Extract the d<id> from the first result URL.
//   3. -1 sentinel if both strategies miss.
//
// No /details calls in this pass — that's the regular v2 tick's job.
// We only resolve IDs here.
//
// Budget: /location/search is FREE (uncounted), separate from the
// 5k/mo /details budget. Google searches are also free. Wall time
// dominated by Playwright nav (~10s/place for Google fallback).
//
// Run on opm-runner:
//   docker exec -it opm-runner node scripts/backfills/backfill-ta-location-ids.js
//
// Flags:
//   --limit N      cap places processed (default: all eligible)
//   --dry-run      just count eligible, don't call APIs

const { prisma } = require("../lib/bootstrap");
const { taFetch, NAME_MATCH_MIN } = require("../lib/tripadvisor");
const { createGmapsPage } = require("../lib/gmaps");
const { normalizeName, jaroWinkler } = require("../lib/utils");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const TA_SPACING_MS = 1100;        // 1 req/sec to TA API — well under 10k/day cap
const GOOGLE_SPACING_MS = 3000;    // be polite to Google
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function arg(name, def) {
    const i = process.argv.indexOf(name);
    if (i === -1) return def;
    const v = process.argv[i + 1];
    if (v === undefined || v.startsWith("--")) return true;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : def;
}

async function pickQueue(limit) {
    return prisma.place.findMany({
        where: {
            isVisible: true,
            tripadvisorLocationId: null,
        },
        select: { id: true, name: true, city: true, country: true },
        orderBy: { id: "asc" },
        take: limit,
    });
}

async function postTaUpdate(payload) {
    const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
        method: "POST",
        headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
    return { ok: r.ok, status: r.status };
}

// Tier 1 — TA's own search API. Returns location_id or null.
async function tryTaApiSearch(name, city) {
    try {
        const params = { searchQuery: name, category: "restaurants" };
        if (city) params.address = city;
        const j = await taFetch("/location/search", params);
        const candidates = (j && j.data) || [];
        if (!candidates.length) return null;

        const wanted = normalizeName(name);
        let best = null, bestSim = 0;
        for (const c of candidates) {
            const sim = jaroWinkler(wanted, normalizeName(c.name || ""));
            if (sim > bestSim) { bestSim = sim; best = c; }
        }
        if (!best || bestSim < NAME_MATCH_MIN) return null;
        return Number(best.location_id);
    } catch (err) {
        // taFetch throws on quota / referer. Don't crash the whole batch.
        console.warn(`  api-search error: ${err.message}`);
        return null;
    }
}

// Tier 2 — Google search for "site:tripadvisor.com <name> <city>".
// First result that's a Restaurant_Review URL → extract d<id>.
async function tryGoogleSearch(page, { name, city, country }) {
    const q = encodeURIComponent(`site:tripadvisor.com ${name} ${city || ""}`);
    try {
        await page.goto(`https://www.google.com/search?q=${q}&hl=en`, {
            waitUntil: "domcontentloaded", timeout: 30000,
        });
        await sleep(1500);
        const url = page.url();
        if (/\/sorry\/index/.test(url)) {
            return { locationId: null, captcha: true };
        }
        const found = await page.evaluate(() => {
            // Google wraps each result anchor in various div nests but the
            // canonical hrefs are stable in the anchor's href attribute.
            // Pick the first href that matches TA's Restaurant_Review d-id
            // shape.
            for (const a of document.querySelectorAll('a[href*="tripadvisor"][href*="-d"]')) {
                const m = a.href.match(/-d(\d+)-/);
                if (m) return { locationId: Number(m[1]), url: a.href };
            }
            return null;
        });
        return found || { locationId: null };
    } catch (err) {
        return { locationId: null, error: err.message };
    }
}

(async () => {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        console.error("HOSTINGER_URL or ADMIN_API_KEY unset");
        process.exit(1);
    }
    const limit = arg("--limit", 10000);
    const dryRun = arg("--dry-run", false);

    const queue = await pickQueue(limit);
    console.log(`[ta-backfill] ${queue.length} places to resolve${dryRun ? " (dry-run)" : ""}`);
    if (dryRun) { await prisma.$disconnect(); return; }

    const { browser, page } = await createGmapsPage();
    const stats = { resolvedApi: 0, resolvedGoogle: 0, sentinel: 0, captcha: 0, errors: 0 };
    const t0 = Date.now();

    try {
        for (let i = 0; i < queue.length; i++) {
            const p = queue[i];
            const tag = `#${p.id} "${p.name.slice(0, 40)}"`;

            // Tier 1: TA API search
            let locId = await tryTaApiSearch(p.name, p.city);
            if (locId) {
                await postTaUpdate({ placeId: p.id, tripadvisorLocationId: locId });
                stats.resolvedApi++;
                console.log(`  ${tag} → ${locId} (api)`);
                await sleep(TA_SPACING_MS);
                continue;
            }

            // Tier 2: Google fallback
            const g = await tryGoogleSearch(page, p);
            if (g.captcha) {
                console.warn(`  ${tag} → Google CAPTCHA — pausing 5 min`);
                stats.captcha++;
                await sleep(300_000);
                continue;
            }
            if (g.locationId) {
                await postTaUpdate({ placeId: p.id, tripadvisorLocationId: g.locationId });
                stats.resolvedGoogle++;
                console.log(`  ${tag} → ${g.locationId} (google)`);
                await sleep(GOOGLE_SPACING_MS);
                continue;
            }

            // Sentinel
            await postTaUpdate({ placeId: p.id, tripadvisorLocationId: -1 });
            stats.sentinel++;
            console.log(`  ${tag} → -1 (no match)`);
            await sleep(GOOGLE_SPACING_MS);

            // Progress every 50
            if ((i + 1) % 50 === 0) {
                const elapsedMin = Math.round((Date.now() - t0) / 60_000);
                console.log(`[ta-backfill] ${i + 1}/${queue.length} done in ${elapsedMin}m — api=${stats.resolvedApi} google=${stats.resolvedGoogle} sentinel=${stats.sentinel}`);
            }
        }
    } finally {
        await browser.close().catch(() => {});
    }

    const elapsedMin = Math.round((Date.now() - t0) / 60_000);
    console.log(`\n[ta-backfill] DONE in ${elapsedMin}m`);
    console.log(`  resolved via TA API:     ${stats.resolvedApi}`);
    console.log(`  resolved via Google:     ${stats.resolvedGoogle}`);
    console.log(`  -1 sentinel (no match):  ${stats.sentinel}`);
    console.log(`  CAPTCHAs encountered:    ${stats.captcha}`);
    console.log(`  errors:                  ${stats.errors}`);

    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
