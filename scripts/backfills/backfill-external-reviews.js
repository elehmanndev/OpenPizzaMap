// One-time (idempotent) backfill: copy scraped review snapshots from the
// legacy Place.googleReviewsJson / tripadvisorReviewsJson blobs into the
// ExternalReview table — one row per review, blob array order = position.
//
// Safe to re-run: upserts on (placeId, source, dedupKey) and the `update`
// branch deliberately omits isHidden, so admin hide-flags set after cutover
// are preserved. Does NOT touch the JSON columns; the read/scraper cutover
// happens in separate commits.
//
// Usage:
//   node scripts/backfills/backfill-external-reviews.js            # dry-run
//   node scripts/backfills/backfill-external-reviews.js --apply

const crypto = require("crypto");
const { prisma } = require("../lib/bootstrap");

function dedupKey(source, author, text) {
    return crypto
        .createHash("sha1")
        .update(`${source}|${(author || "").trim().toLowerCase()}|${(text || "").trim().slice(0, 200)}`)
        .digest("hex")
        .slice(0, 40);
}

function parseArr(json) {
    if (!json) return [];
    try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
}

function num(v) {
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

async function run({ apply }) {
    const places = await prisma.place.findMany({
        where: {
            OR: [
                { googleReviewsJson: { not: null } },
                { tripadvisorReviewsJson: { not: null } },
            ],
        },
        select: { id: true, googleReviewsJson: true, tripadvisorReviewsJson: true },
    });

    let placeCount = 0, rowCount = 0, emptyText = 0;
    for (const p of places) {
        const sources = [
            ["google", parseArr(p.googleReviewsJson)],
            ["tripadvisor", parseArr(p.tripadvisorReviewsJson)],
        ];
        let touched = false;
        for (const [source, reviews] of sources) {
            const seen = new Set();
            let pos = 0;
            for (const r of reviews) {
                const author = r && typeof r === "object" ? (r.author || null) : null;
                const text = typeof r === "string" ? r : (r && r.text) || "";
                const key = dedupKey(source, author, text);
                if (seen.has(key)) continue; // collapse exact dupes within one blob
                seen.add(key);
                pos += 1;
                rowCount += 1;
                if (!String(text).trim()) emptyText += 1;
                touched = true;
                if (apply) {
                    const data = {
                        position: pos,
                        author: author ? String(author).slice(0, 191) : null,
                        rating: num(r && r.rating),
                        text: text ? String(text) : null,
                        relativeTime: r && r.relativeTime ? String(r.relativeTime).slice(0, 60) : null,
                        profilePhoto: r && r.profilePhoto ? String(r.profilePhoto).slice(0, 500) : null,
                        publishedAt: parseDate(r && r.publishedAt),
                        lang: r && r.lang ? String(r.lang).slice(0, 10) : null,
                    };
                    await prisma.externalReview.upsert({
                        where: { placeId_source_dedupKey: { placeId: p.id, source, dedupKey: key } },
                        update: data, // omits isHidden on purpose — preserve admin flag
                        create: { placeId: p.id, source, dedupKey: key, ...data },
                    });
                }
            }
        }
        if (touched) placeCount += 1;
    }

    console.log(`[backfill-external-reviews] ${apply ? "APPLIED" : "DRY-RUN"} — ${rowCount} reviews across ${placeCount} places (${emptyText} with empty text)`);
}

run({ apply: process.argv.includes("--apply") })
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
