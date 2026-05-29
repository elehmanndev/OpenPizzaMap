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
const { normalizeName, jaroWinkler } = require("../lib/utils");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const TA_SPACING_MS = 1100;        // 1 req/sec to TA API — well under 10k/day cap
const DDG_SPACING_MS = 1500;       // be polite to DuckDuckGo
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

// Tier 2 — DuckDuckGo HTML search for "site:tripadvisor.com <name> <city>".
// DDG's /html endpoint serves static HTML (no JS mounting) AND is far
// more bot-tolerant than Google — no CAPTCHA after a handful of queries
// from a residential IP. Plain fetch is enough; no Playwright needed.
//
// Result format: DDG wraps each external link in a redirect like
//   <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.tripadvisor.com%2F...">
// We don't need to unwrap the redirect — the encoded uddg param contains
// the full TA URL, and "-d<digits>-" inside that is the locationId.
async function tryDdgSearch({ name, city }) {
    const q = encodeURIComponent(`site:tripadvisor.com ${name} ${city || ""}`);
    try {
        const r = await fetch(`https://duckduckgo.com/html/?q=${q}`, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
        });
        if (!r.ok) return { locationId: null, error: `HTTP ${r.status}` };
        const html = await r.text();

        // Look for the first tripadvisor.com Restaurant_Review URL with a d<id>.
        // Regex matches both raw URLs and DDG-redirect-wrapped URL-encoded URLs.
        const decoded = html.replace(/%2F/gi, "/").replace(/%3A/gi, ":").replace(/%3D/gi, "=").replace(/%26/gi, "&");
        const m = decoded.match(/tripadvisor\.com\/Restaurant_Review-[^"\s]*-d(\d+)-/i);
        if (m) return { locationId: Number(m[1]) };
        return { locationId: null };
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
    const apiOnly = arg("--api-only", false);

    const queue = await pickQueue(limit);
    console.log(`[ta-backfill] ${queue.length} places to resolve${dryRun ? " (dry-run)" : ""}${apiOnly ? " (api-only, skipping DDG fallback)" : ""}`);
    if (dryRun) { await prisma.$disconnect(); return; }

    // DDG fallback uses plain fetch — no Playwright/Chromium required.
    const stats = { resolvedApi: 0, resolvedDdg: 0, sentinel: 0, ddgError: 0, errors: 0 };
    const t0 = Date.now();

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

        // Tier 2: DuckDuckGo fallback (unless --api-only)
        if (!apiOnly) {
            const d = await tryDdgSearch(p);
            if (d.error) stats.ddgError++;
            if (d.locationId) {
                await postTaUpdate({ placeId: p.id, tripadvisorLocationId: d.locationId });
                stats.resolvedDdg++;
                console.log(`  ${tag} → ${d.locationId} (ddg)`);
                await sleep(DDG_SPACING_MS);
                continue;
            }
        }

        // Sentinel
        await postTaUpdate({ placeId: p.id, tripadvisorLocationId: -1 });
        stats.sentinel++;
        console.log(`  ${tag} → -1 (no match)`);
        await sleep(apiOnly ? TA_SPACING_MS : DDG_SPACING_MS);

        // Progress every 50
        if ((i + 1) % 50 === 0) {
            const elapsedMin = Math.round((Date.now() - t0) / 60_000);
            console.log(`[ta-backfill] ${i + 1}/${queue.length} done in ${elapsedMin}m — api=${stats.resolvedApi} ddg=${stats.resolvedDdg} sentinel=${stats.sentinel}`);
        }
    }

    const elapsedMin = Math.round((Date.now() - t0) / 60_000);
    console.log(`\n[ta-backfill] DONE in ${elapsedMin}m`);
    console.log(`  resolved via TA API:     ${stats.resolvedApi}`);
    console.log(`  resolved via DuckDuckGo: ${stats.resolvedDdg}`);
    console.log(`  -1 sentinel (no match):  ${stats.sentinel}`);
    console.log(`  DDG errors:              ${stats.ddgError}`);
    console.log(`  other errors:            ${stats.errors}`);

    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
