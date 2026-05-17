#!/usr/bin/env node
// Phase 2 of the review-based description pipeline.
// Reads google-reviews-cache.json (produced by scrape-reviews.js) and uses
// Gemini 2.5 Flash Lite to summarise the reviews into a 2-sentence description
// with unique, specific insights from real customers.
//
// Importable: exports `run(opts)` so src/services/maintenance.js can
// call it in-process inside the live worker (avoids the Hostinger
// Prisma "tokio panic" hit when this is spawned as a bare CLI script).
//
// Falls back to website text for places not in the reviews cache.
//
// Free tier: 15 RPM Gemini → script paces itself automatically (4.1s delay).
// Override with GEMINI_DELAY_MS env var when running on the burn workflow
// (Tier-1 paid tier allows up to 4000 RPM).
//
// Usage:
//   node scripts/generate-descriptions.js --dry-run            # preview, no writes
//   node scripts/generate-descriptions.js --apply              # write to DB
//   node scripts/generate-descriptions.js --apply --limit=100
//   node scripts/generate-descriptions.js --apply --id=42      # single place
//   node scripts/generate-descriptions.js --apply --all        # overwrite existing too
//   GEMINI_DELAY_MS=1100 node scripts/.../generate-descriptions.js --apply
//
// Requires: GEMINI_API_KEY in .env
// Reviews source: google-reviews-cache.json (run scrape-reviews.js first)

const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { prisma, PATHS } = require("../lib/bootstrap");

const REVIEWS_CACHE_PATH = path.join(PATHS.cache, "google-reviews-cache.json");

// ─── Reviews cache ────────────────────────────────────────────────────────────

function loadReviewsCache() {
    try { return JSON.parse(fs.readFileSync(REVIEWS_CACHE_PATH, "utf8")); } catch { return {}; }
}

// ─── Gemini ───────────────────────────────────────────────────────────────────

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
    });

    return new Promise((resolve, reject) => {
        const path = `/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${apiKey}`;
        const req = https.request({
            hostname: "generativelanguage.googleapis.com",
            path,
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            },
        }, (res) => {
            let data = "";
            res.on("data", c => data += c);
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.error) throw new Error(parsed.error.message);
                    resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || "");
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

// ─── Prompt builders ──────────────────────────────────────────────────────────

function buildReviewPrompt(place, styles, reviews) {
    const styleNames = styles.map(s => s.name).join(", ");
    const header = [
        `Name: ${place.name}`,
        styleNames ? `Pizza style(s): ${styleNames}` : null,
    ].filter(Boolean).join("\n");

    const reviewBlock = reviews
        .slice(0, 20)
        .map((r, i) => `${i + 1}. ${r.slice(0, 500)}`)
        .join("\n");

    return `Write a short summary of what customers say about this pizzeria using EXACTLY this format:

Pizza Lovers say: "[2-3 specific things reviewers praise, e.g. named dishes or qualities]. [One negative or mediocre point if present, otherwise a second positive]."

Rules:
- Start with exactly: Pizza Lovers say: "
- End with a closing double-quote and period
- Name specific dishes, ingredients, or qualities that real reviewers mention
- Include one honest negative/mixed point if reviewers mention one
- Max 200 characters total including the prefix
- No HTML tags
- Do NOT mention the city or country
- Do NOT start with the restaurant name
- Write in English
- Output only the single formatted line, nothing else

PIZZERIA: ${header}
REVIEWS (${reviews.length}):
${reviewBlock}`;
}

function cleanDescription(text) {
    const t = text.trim();
    // Only strip if the ENTIRE output is symmetrically wrapped in quotes
    // (Gemini sometimes wraps its full response). Don't strip trailing quotes
    // that are part of the "Pizza Lovers say: "..." format.
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        return t.slice(1, -1).trim();
    }
    return t;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function run({
    dryRun = false,
    apply = true,
    all = false,
    singleId = null,
    limit = 200,
    // When called from the live worker (in-process), DO NOT periodically
    // disconnect — that would close the shared Prisma singleton and
    // break the rest of the running app. Default true for CLI mode.
    reconnectMidLoop = true,
    delayMs = Number(process.env.GEMINI_DELAY_MS) || 4100,
} = {}) {
    const reviewsCache = loadReviewsCache();
    const cachedIds = new Set(Object.keys(reviewsCache));
    console.log(`[describe] Loaded reviews cache: ${cachedIds.size} places`);

    // Match the reviews phase's filter: only rows with a googlePlaceId
    // can have cached reviews. Without this, descriptions picks
    // low-id rows that don't have place_ids yet — reviews never
    // cached them, descriptions has nothing to summarise, the
    // backlog never drains. Bug surfaced on the first Unraid tick
    // (2026-05-18): reviews cached 40 rows, descriptions queried
    // 40 different rows, 0 written.
    const where = singleId
        ? { id: singleId }
        : all
            ? {}
            : { descriptionHtml: null, isVisible: true, googlePlaceId: { not: null } };

    const places = await prisma.place.findMany({
        where,
        take: limit,
        orderBy: { id: "asc" },
        select: {
            id: true, name: true, city: true, country: true,
            websiteUrl: true,
            styles: { include: { style: { select: { name: true } } } },
        },
    });

    const totalMissing = all ? "all" : await prisma.place.count({ where: { descriptionHtml: null, isVisible: true } });
    const withReviews = places.filter(p => cachedIds.has(String(p.id))).length;
    console.log(`[describe] ${places.length} places in this run (${totalMissing} total missing descriptions)`);
    console.log(`[describe] ${withReviews} have cached reviews → review prompt`);
    console.log(`[describe] ${places.length - withReviews} skipped (no cached reviews)`);
    console.log(`[describe] dryRun=${dryRun}, delay=${delayMs}ms between Gemini calls\n`);

    let written = 0, skipped = 0, failed = 0;

    for (let idx = 0; idx < places.length; idx++) {
        // Reconnect every 30 iterations to avoid MySQL idle-connection
        // timeout — ONLY in CLI mode where we own the Prisma client.
        if (reconnectMidLoop && idx > 0 && idx % 30 === 0) {
            await prisma.$disconnect();
            await prisma.$connect();
        }
        const place = places[idx];
        const styles = place.styles.map(s => s.style);
        let prompt, source;

        const cached = reviewsCache[String(place.id)];
        if (!cached || !cached.reviews || cached.reviews.length === 0) {
            // No reviews → no description. Skip until reviews are scraped.
            // Eric's rule: descriptions must come from real customers, never
            // from website blurbs or pure metadata.
            skipped++;
            continue;
        }
        prompt = buildReviewPrompt(place, styles, cached.reviews);
        source = `reviews(${cached.reviews.length})`;

        let description = "";
        try {
            const raw = await callGemini(prompt);
            description = cleanDescription(raw);
        } catch (err) {
            console.error(`[describe] #${place.id} "${place.name}" — Gemini error: ${err.message}`);
            failed++;
            await new Promise(r => setTimeout(r, delayMs));
            continue;
        }

        if (!description) {
            console.log(`[describe] #${place.id} "${place.name}" — empty response, skipping`);
            skipped++;
            await new Promise(r => setTimeout(r, delayMs));
            continue;
        }

        console.log(`[describe] #${place.id} "${place.name}" (${place.city}, ${place.country}) [${source}]`);
        console.log(`           → ${description}\n`);

        if (apply) {
            try {
                await prisma.place.update({
                    where: { id: place.id },
                    data: { descriptionHtml: description },
                });
            } catch (err) {
                if (reconnectMidLoop && (err.code === "P1017" || err.code === "P1001")) {
                    await prisma.$disconnect();
                    await new Promise(r => setTimeout(r, 2000));
                    await prisma.$connect();
                    await prisma.place.update({
                        where: { id: place.id },
                        data: { descriptionHtml: description },
                    });
                } else {
                    throw err;
                }
            }
            written++;
        }

        await new Promise(r => setTimeout(r, delayMs));
    }

    console.log(`\n[describe] Done — written=${written} skipped=${skipped} failed=${failed}`);
    if (dryRun) console.log("[describe] Dry-run — no changes written. Re-run with --apply to save.");

    return { ok: true, written, skipped, failed, total: places.length, cachedIds: cachedIds.size };
}

function parseCliArgs() {
    const args = process.argv;
    return {
        dryRun: args.includes("--dry-run"),
        apply: args.includes("--apply"),
        all: args.includes("--all"),
        singleId: (() => { const m = args.find(a => a.startsWith("--id=")); return m ? Number(m.split("=")[1]) : null; })(),
        limit: (() => { const m = args.find(a => a.startsWith("--limit=")); return m ? Number(m.split("=")[1]) : 200; })(),
        reconnectMidLoop: true,
    };
}

if (require.main === module) {
    const opts = parseCliArgs();
    if (!opts.dryRun && !opts.apply) {
        console.error("Usage: node generate-descriptions.js --dry-run | --apply [--all] [--id=N] [--limit=N]");
        process.exit(1);
    }
    run(opts)
        .catch(err => { console.error(err); process.exit(1); })
        .finally(() => prisma.$disconnect());
}

module.exports = { run };
