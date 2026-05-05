#!/usr/bin/env node
// Auto-classify pizza styles using Gemini 2.0 Flash (free tier).
// Fetches untagged places (or all with --all), uses website text + name/city/country
// as context, then asks Gemini to pick from the 14-style taxonomy.
// Requires: GEMINI_API_KEY env var (free at https://aistudio.google.com/apikey)
//
// Usage:
//   node scripts/classify-styles.js --dry-run          # print suggestions, no DB writes
//   node scripts/classify-styles.js --apply            # write to DB
//   node scripts/classify-styles.js --apply --all      # re-classify everything
//   node scripts/classify-styles.js --apply --id=123   # single place
//   node scripts/classify-styles.js --apply --min-confidence=0.8

const { prisma } = require("../lib/bootstrap");
const https = require("https");
const http = require("http");

const DRY_RUN = process.argv.includes("--dry-run");
const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");
const SINGLE_ID = (() => { const m = process.argv.find(a => a.startsWith("--id=")); return m ? Number(m.split("=")[1]) : null; })();
const MIN_CONFIDENCE = (() => { const m = process.argv.find(a => a.startsWith("--min-confidence=")); return m ? Number(m.split("=")[1]) : 0.7; })();
const LIMIT = (() => { const m = process.argv.find(a => a.startsWith("--limit=")); return m ? Number(m.split("=")[1]) : 500; })();

if (!DRY_RUN && !APPLY) {
    console.error("Usage: node classify-styles.js --dry-run | --apply [--all] [--id=N] [--min-confidence=0.8] [--limit=N]");
    process.exit(1);
}

const STYLES = [
    { slug: "neapolitan",    name: "Neapolitan",         hint: "Neapolitan (STG/VPN-adjacent, soft cornicione, 00 flour, wood-fired)" },
    { slug: "italian-style", name: "Italian Style",      hint: "Italian Style (quality Italian pizza that doesn't fit a specific denomination — catch-all for Italian pizzerias)" },
    { slug: "romana",        name: "Roman-Style",        hint: "Roman-Style / Romana (thin crispy round, tonda romana)" },
    { slug: "al-taglio",     name: "Pizza al Taglio",    hint: "Pizza al Taglio (Roman rectangular by-the-slice)" },
    { slug: "pinsa",         name: "Pinsa",              hint: "Pinsa romana (oval Roman flatbread, lighter dough)" },
    { slug: "pizza-fritta",  name: "Pizza Fritta",       hint: "Pizza Fritta (deep-fried pizza, Neapolitan tradition)" },
    { slug: "ny",            name: "New York–Style",     hint: "New York-Style (large foldable slices, tomato sauce, low moisture mozzarella)" },
    { slug: "new-haven",     name: "New Haven Apizza",   hint: "New Haven Apizza / Apizza (thin charred crust, clam pizza, Connecticut style)" },
    { slug: "detroit",       name: "Detroit-Style",      hint: "Detroit-Style (rectangular deep-dish, crispy cheese edges, square slices)" },
    { slug: "chicago",       name: "Chicago Deep-Dish",  hint: "Chicago Deep-Dish (deep thick crust, chunky tomato sauce on top)" },
    { slug: "sicilian",      name: "Sicilian",           hint: "Sicilian (thick rectangular, sfincione, spongy crust)" },
    { slug: "apulian",       name: "Apulian",            hint: "Apulian (from Puglia, focaccia barese, thick round)" },
    { slug: "padellino",     name: "Pizza al Padellino", hint: "Pizza al Padellino (Turin-style small pan pizza, crispy base)" },
    { slug: "focaccia-recco",name: "Focaccia di Recco",  hint: "Focaccia di Recco (Ligurian, very thin, filled with stracchino cheese)" },
];

const STYLE_SLUGS = STYLES.map(s => s.slug);

function fetchUrl(url, timeoutMs = 8000) {
    return new Promise((resolve) => {
        try { new URL(url); } catch (_) { return resolve(""); }
        const lib = url.startsWith("https") ? https : http;
        const req = lib.get(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; OPM-classifier/1.0)" },
            timeout: timeoutMs,
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = new URL(res.headers.location, url).href;
                return fetchUrl(next, timeoutMs).then(resolve);
            }
            let body = "";
            res.setEncoding("utf8");
            res.on("data", chunk => { if (body.length < 20000) body += chunk; });
            res.on("end", () => resolve(body));
        });
        req.on("error", () => resolve(""));
        req.on("timeout", () => { req.destroy(); resolve(""); });
    });
}

function extractText(html) {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 1500);
}

async function callGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set — get a free key at https://aistudio.google.com/apikey");

    const body = JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: 256, temperature: 0.1 },
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
                    resolve(parsed.candidates?.[0]?.content?.parts?.[0]?.text || "");
                } catch (e) { reject(e); }
            });
        });
        req.on("error", reject);
        req.write(body);
        req.end();
    });
}

function buildPrompt(place, websiteText) {
    const styleList = STYLES.map(s => `- ${s.slug}: ${s.hint}`).join("\n");
    const context = [
        `Name: ${place.name}`,
        `City: ${place.city || "unknown"}`,
        `Country: ${place.country || "unknown"}`,
        place.descriptionHtml ? `Description: ${place.descriptionHtml.replace(/<[^>]+>/g, " ").slice(0, 400)}` : null,
        websiteText ? `Website content (excerpt): ${websiteText}` : null,
    ].filter(Boolean).join("\n");

    return `You are a pizza style expert. Classify the following pizzeria into 1-2 pizza styles from the list below.

PIZZERIA INFO:
${context}

AVAILABLE STYLES:
${styleList}

Rules:
- Return only the slug(s), comma-separated if multiple (max 2)
- Prefer a single specific style when clear
- Use "italian-style" as fallback for Italian pizzerias that don't fit any other style
- Return "unknown" if you genuinely cannot determine the style
- Format: STYLE: <slug(s)> | CONFIDENCE: <0.0-1.0>
- Example: STYLE: neapolitan | CONFIDENCE: 0.95
- Example: STYLE: neapolitan,pizza-fritta | CONFIDENCE: 0.85`;
}

function parseResponse(text) {
    const styleMatch = text.match(/STYLE:\s*([a-z,\-]+)/i);
    const confMatch = text.match(/CONFIDENCE:\s*([\d.]+)/i);
    if (!styleMatch) return null;
    const slugs = styleMatch[1].split(",").map(s => s.trim()).filter(s => STYLE_SLUGS.includes(s));
    const confidence = confMatch ? parseFloat(confMatch[1]) : 0.5;
    if (!slugs.length) return null;
    return { slugs, confidence };
}

async function applyStyles(placeId, slugs) {
    const styles = await prisma.style.findMany({ where: { slug: { in: slugs } } });
    if (!styles.length) return;
    await prisma.placeStyle.createMany({
        data: styles.map(s => ({ placeId, styleId: s.id })),
        skipDuplicates: true,
    });
    const place = await prisma.place.findUnique({
        where: { id: placeId },
        include: { styles: { include: { style: true } } },
    });
    if (place) {
        await prisma.place.update({
            where: { id: placeId },
            data: { stylesJson: JSON.stringify(place.styles.map(s => s.style.slug)) },
        });
    }
}

async function main() {
    const where = SINGLE_ID
        ? { id: SINGLE_ID }
        : ALL
            ? {}
            : { styles: { none: {} }, isVisible: true };

    const places = await prisma.place.findMany({
        where,
        take: LIMIT,
        orderBy: { id: "asc" },
        select: { id: true, name: true, city: true, country: true, websiteUrl: true, descriptionHtml: true },
    });

    console.log(`[classify] ${places.length} places to process (dry-run=${DRY_RUN}, min-confidence=${MIN_CONFIDENCE})`);

    let applied = 0, skipped = 0, failed = 0;

    for (const place of places) {
        let websiteText = "";
        if (place.websiteUrl) {
            try {
                const html = await fetchUrl(place.websiteUrl);
                websiteText = extractText(html);
            } catch (_) {}
        }

        let result = null;
        try {
            const prompt = buildPrompt(place, websiteText);
            const response = await callGemini(prompt);
            result = parseResponse(response);
        } catch (err) {
            console.error(`[classify] #${place.id} Claude error: ${err.message}`);
            failed++;
            continue;
        }

        if (!result || result.slugs[0] === "unknown") {
            console.log(`[classify] #${place.id} "${place.name}" → unknown`);
            skipped++;
            continue;
        }

        const conf = result.confidence >= MIN_CONFIDENCE ? "✓" : "✗";
        console.log(`[classify] #${place.id} "${place.name}" (${place.city}, ${place.country}) → ${result.slugs.join(", ")} (${(result.confidence * 100).toFixed(0)}%) ${conf}`);

        if (APPLY && result.confidence >= MIN_CONFIDENCE) {
            await applyStyles(place.id, result.slugs);
            applied++;
        } else if (result.confidence < MIN_CONFIDENCE) {
            skipped++;
        }

        // Small delay to avoid hammering the API
        await new Promise(r => setTimeout(r, 150));
    }

    console.log(`\n[classify] Done — applied=${applied} skipped=${skipped} failed=${failed}`);
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
