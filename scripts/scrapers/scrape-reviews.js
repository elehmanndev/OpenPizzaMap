#!/usr/bin/env node
// Phase 1 of the review-based description pipeline.
// Calls the Google Places API (New) to fetch up to 5 reviews per place and
// saves them to google-reviews-cache.json. Run this first; generate-descriptions.js
// reads from that file on the next step.
//
// Importable: exports `run(opts)` so src/services/maintenance.js can
// call it in-process inside the live worker (avoids the Hostinger
// Prisma "tokio panic" hit when this is spawned as a bare CLI script).
//
// Requires: GOOGLE_MAPS_API_KEY in .env
// Targets places with googlePlaceId set. Places without one are skipped.
//
// Usage:
//   node scripts/scrape-reviews.js --dry-run            # show what would be fetched
//   node scripts/scrape-reviews.js --apply              # fetch and save
//   node scripts/scrape-reviews.js --apply --limit=50
//   node scripts/scrape-reviews.js --apply --id=42      # single place
//   node scripts/scrape-reviews.js --apply --all        # re-fetch already cached

const path = require("path");
const fs = require("fs");
const https = require("https");
const { prisma, PATHS } = require("../lib/bootstrap");

const CACHE_PATH = path.join(PATHS.cache, "google-reviews-cache.json");

// Polite delay between API calls (~5 req/sec).
const DELAY_MS = 200;

function loadCache() {
    try { return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")); } catch { return {}; }
}
function saveCache(cache) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Fetch up to 5 reviews for a place from the Places API (New).
// Returns an array of review text strings (original language preferred).
function fetchReviews(googlePlaceId, apiKey) {
    return new Promise((resolve, reject) => {
        const req = https.request({
            hostname: "places.googleapis.com",
            path: `/v1/places/${encodeURIComponent(googlePlaceId)}`,
            method: "GET",
            headers: {
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask": "reviews",
            },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));
                    const reviews = (json.reviews || [])
                        .map(r => (r.originalText?.text || r.text?.text || "").replace(/\s+/g, " ").trim())
                        .filter(t => t.length >= 20);
                    resolve(reviews);
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.end();
    });
}

async function run({ dryRun = false, apply = true, all = false, singleId = null, limit = 500 } = {}) {
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
        console.error("[reviews] GOOGLE_MAPS_API_KEY not set in .env");
        return { ok: false, error: "GOOGLE_MAPS_API_KEY not set" };
    }

    const cache = loadCache();

    const where = singleId
        ? { id: singleId, googlePlaceId: { not: null } }
        : { googlePlaceId: { not: null }, isVisible: true };

    const allPlaces = await prisma.place.findMany({
        where,
        orderBy: { id: "asc" },
        select: { id: true, name: true, city: true, country: true, googlePlaceId: true },
    });

    const places = all
        ? allPlaces
        : allPlaces.filter(p => !cache[String(p.id)]);

    const capped = places.slice(0, limit);

    console.log(`[reviews] ${allPlaces.length} places with googlePlaceId`);
    console.log(`[reviews] ${capped.length} to fetch this run (${all ? "all, re-fetching cached" : "skipping already cached"})`);
    console.log(`[reviews] dryRun=${dryRun}\n`);

    if (dryRun) {
        for (const p of capped) {
            console.log(`[reviews] would fetch #${p.id} "${p.name}" (${p.city}, ${p.country})`);
        }
        return { ok: true, dryRun: true, candidates: capped.length };
    }

    let saved = 0, empty = 0, failed = 0;

    for (const place of capped) {
        let reviews = [];
        try {
            reviews = await fetchReviews(place.googlePlaceId, apiKey);
        } catch (err) {
            console.error(`[reviews] #${place.id} "${place.name}" — error: ${err.message}`);
            failed++;
            await new Promise(r => setTimeout(r, DELAY_MS));
            continue;
        }

        const label = `#${place.id} "${place.name}" (${place.city}, ${place.country})`;
        if (reviews.length === 0) {
            console.log(`[reviews] ${label} — no reviews`);
            empty++;
            // Cache the empty result so we don't re-hit the API.
            cache[String(place.id)] = { reviews: [], fetchedAt: new Date().toISOString(), googlePlaceId: place.googlePlaceId };
            saveCache(cache);
        } else {
            console.log(`[reviews] ${label} — ${reviews.length} reviews`);
            cache[String(place.id)] = { reviews, fetchedAt: new Date().toISOString(), googlePlaceId: place.googlePlaceId };
            saveCache(cache);
            saved++;
        }

        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    console.log(`\n[reviews] Done — saved=${saved} empty=${empty} failed=${failed}`);
    console.log(`[reviews] Cache: ${CACHE_PATH}`);
    return { ok: true, saved, empty, failed, total: capped.length };
}

function parseCliArgs() {
    const args = process.argv;
    return {
        dryRun: args.includes("--dry-run"),
        apply: args.includes("--apply"),
        all: args.includes("--all"),
        singleId: (() => { const m = args.find(a => a.startsWith("--id=")); return m ? Number(m.split("=")[1]) : null; })(),
        limit: (() => { const m = args.find(a => a.startsWith("--limit=")); return m ? Number(m.split("=")[1]) : 500; })(),
    };
}

if (require.main === module) {
    const opts = parseCliArgs();
    if (!opts.dryRun && !opts.apply) {
        console.error("Usage: node scrape-reviews.js --dry-run | --apply [--all] [--id=N] [--limit=N]");
        process.exit(1);
    }
    run(opts)
        .catch(err => { console.error(err); process.exit(1); })
        .finally(() => prisma.$disconnect());
}

module.exports = { run };
