#!/usr/bin/env node
// Phase 2 of the review-based description pipeline.
// Reads google-reviews-cache.json (produced by scrape-reviews.js) and uses
// Gemini 2.5 Flash Lite to summarise the reviews into a 2-sentence description
// with unique, specific insights from real customers.
//
// Falls back to website text for places not in the reviews cache.
//
// Free tier: 15 RPM Gemini → script paces itself automatically.
//
// Usage:
//   node scripts/generate-descriptions.js --dry-run            # preview, no writes
//   node scripts/generate-descriptions.js --apply              # write to DB
//   node scripts/generate-descriptions.js --apply --limit=100
//   node scripts/generate-descriptions.js --apply --id=42      # single place
//   node scripts/generate-descriptions.js --apply --all        # overwrite existing too
//
// Requires: GEMINI_API_KEY in .env
// Reviews source: google-reviews-cache.json (run scrape-reviews.js first)

require("dotenv").config();
const { PrismaClient } = require("@prisma/client");
const https = require("https");
const http = require("http");
const path = require("path");
const fs = require("fs");

const prisma = new PrismaClient();

const ROOT = path.resolve(__dirname, "..");
const REVIEWS_CACHE_PATH = path.join(ROOT, "google-reviews-cache.json");

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY   = process.argv.includes("--apply");
const ALL     = process.argv.includes("--all");
const SINGLE_ID = (() => { const m = process.argv.find(a => a.startsWith("--id=")); return m ? Number(m.split("=")[1]) : null; })();
const LIMIT   = (() => { const m = process.argv.find(a => a.startsWith("--limit=")); return m ? Number(m.split("=")[1]) : 200; })();

// 15 RPM → 4s between calls to stay comfortably under
const DELAY_MS = 4100;

if (!DRY_RUN && !APPLY) {
    console.error("Usage: node generate-descriptions.js --dry-run | --apply [--all] [--id=N] [--limit=N]");
    process.exit(1);
}

// ─── Reviews cache ────────────────────────────────────────────────────────────

function loadReviewsCache() {
    try { return JSON.parse(fs.readFileSync(REVIEWS_CACHE_PATH, "utf8")); } catch { return {}; }
}

// ─── Website fallback ─────────────────────────────────────────────────────────

function fetchUrl(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try {
            try { new URL(url); } catch (_) { return resolve(""); }
            const lib = url.startsWith("https") ? https : http;
            const req = lib.get(url, {
                headers: { "User-Agent": "Mozilla/5.0 (compatible; OPM/1.0)" },
                timeout: timeoutMs,
            }, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    const next = new URL(res.headers.location, url).href;
                    return fetchUrl(next, timeoutMs).then(resolve);
                }
                let body = "";
                res.setEncoding("utf8");
                res.on("data", chunk => { if (body.length < 15000) body += chunk; });
                res.on("end", () => resolve(body));
            });
            req.on("error", () => resolve(""));
            req.on("timeout", () => { req.destroy(); resolve(""); });
        } catch (_) { resolve(""); }
    });
}

function extractText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000);
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

function buildWebsitePrompt(place, styles, websiteText) {
    const styleNames = styles.map(s => s.name).join(", ");
    const lines = [
        `Name: ${place.name}`,
        `City: ${place.city || "unknown"}`,
        `Country: ${place.country || "unknown"}`,
        styleNames ? `Pizza style(s): ${styleNames}` : null,
        websiteText ? `Website excerpt: ${websiteText}` : null,
    ].filter(Boolean).join("\n");

    return `You are writing concise, enthusiastic descriptions for an international pizza map called OpenPizzaMap.

Write a 2-sentence HTML description for this pizzeria. Rules:
- Max 2 sentences, max 180 characters total
- Use only <strong> tags if needed, no other HTML
- Focus on what makes this place special or notable
- Mention the pizza style if known and distinctive
- Do NOT mention the city or country (it's already shown on the map)
- Do NOT start with the restaurant name
- Write in English
- Output only the description, nothing else

PIZZERIA INFO:
${lines}`;
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

async function main() {
    const reviewsCache = loadReviewsCache();
    const cachedIds = new Set(Object.keys(reviewsCache));
    console.log(`[describe] Loaded reviews cache: ${cachedIds.size} places`);

    const where = SINGLE_ID
        ? { id: SINGLE_ID }
        : ALL
            ? {}
            : { descriptionHtml: null, isVisible: true };

    const places = await prisma.place.findMany({
        where,
        take: LIMIT,
        orderBy: { id: "asc" },
        select: {
            id: true, name: true, city: true, country: true,
            websiteUrl: true,
            styles: { include: { style: { select: { name: true } } } },
        },
    });

    const totalMissing = ALL ? "all" : await prisma.place.count({ where: { descriptionHtml: null, isVisible: true } });
    const withReviews = places.filter(p => cachedIds.has(String(p.id))).length;
    console.log(`[describe] ${places.length} places in this run (${totalMissing} total missing descriptions)`);
    console.log(`[describe] ${withReviews} have cached reviews → review prompt`);
    console.log(`[describe] ${places.length - withReviews} will use website fallback`);
    console.log(`[describe] dry-run=${DRY_RUN}, delay=${DELAY_MS}ms between Gemini calls\n`);

    let written = 0, skipped = 0, failed = 0;

    for (let idx = 0; idx < places.length; idx++) {
        // Reconnect every 30 iterations to avoid MySQL idle-connection timeout.
        if (idx > 0 && idx % 30 === 0) {
            await prisma.$disconnect();
            await prisma.$connect();
        }
        const place = places[idx];
        const styles = place.styles.map(s => s.style);
        let prompt, source;

        const cached = reviewsCache[String(place.id)];
        if (cached && cached.reviews && cached.reviews.length > 0) {
            prompt = buildReviewPrompt(place, styles, cached.reviews);
            source = `reviews(${cached.reviews.length})`;
        } else {
            let websiteText = "";
            if (place.websiteUrl) {
                try {
                    const html = await fetchUrl(place.websiteUrl);
                    websiteText = extractText(html);
                } catch (_) {}
            }
            prompt = buildWebsitePrompt(place, styles, websiteText);
            source = websiteText ? "website" : "metadata-only";
        }

        let description = "";
        try {
            const raw = await callGemini(prompt);
            description = cleanDescription(raw);
        } catch (err) {
            console.error(`[describe] #${place.id} "${place.name}" — Gemini error: ${err.message}`);
            failed++;
            await new Promise(r => setTimeout(r, DELAY_MS));
            continue;
        }

        if (!description) {
            console.log(`[describe] #${place.id} "${place.name}" — empty response, skipping`);
            skipped++;
            await new Promise(r => setTimeout(r, DELAY_MS));
            continue;
        }

        console.log(`[describe] #${place.id} "${place.name}" (${place.city}, ${place.country}) [${source}]`);
        console.log(`           → ${description}\n`);

        if (APPLY) {
            try {
                await prisma.place.update({
                    where: { id: place.id },
                    data: { descriptionHtml: description },
                });
            } catch (err) {
                if (err.code === "P1017" || err.code === "P1001") {
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

        await new Promise(r => setTimeout(r, DELAY_MS));
    }

    console.log(`\n[describe] Done — written=${written} skipped=${skipped} failed=${failed}`);
    if (DRY_RUN) console.log("[describe] Dry-run — no changes written. Re-run with --apply to save.");
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
