// Country bounding-box audit — catches wholesale-wrong rows that the
// centroid heuristic in audit-geocodes.js can't see (singleton-city buckets,
// or whole buckets that share a wrong country pin). Pairs with
// audit-geocodes.js: that script flags rows far from their city centroid;
// this one flags rows that aren't even in the right country.
//
// Usage:
//   node scripts/audit-geocodes-bbox.js                  # all visible rows
//   node scripts/audit-geocodes-bbox.js --include-hidden # all rows
//
// A row is flagged when:
//   1. We have a bbox for the country in scripts/country-bboxes.json AND
//   2. The row's lat/lng is OUTSIDE that bbox.
// Rows whose country has no bbox entry are reported separately as
// "unmappedCountry" (e.g. data bugs like country="ES" instead of "Spain").

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const BBOX_FILE = path.join(__dirname, "country-bboxes.json");
const OUT_FILE = path.join(__dirname, "..", "geocode-bbox-audit.json");

function parseArgs(argv) {
    return { includeHidden: argv.includes("--include-hidden") };
}

function loadBboxes() {
    const raw = JSON.parse(fs.readFileSync(BBOX_FILE, "utf8"));
    const out = new Map();
    for (const [k, v] of Object.entries(raw)) {
        if (k.startsWith("_")) continue;
        if (!Array.isArray(v)) continue;
        // Two accepted shapes: a single bbox [s,w,n,e] or a list of bboxes
        // [[s,w,n,e], [s,w,n,e], ...] for countries with non-contiguous
        // territory (e.g. United States + Hawaii + Guam + Puerto Rico).
        if (v.length === 4 && v.every((n) => typeof n === "number")) out.set(k, [v]);
        else if (v.every((b) => Array.isArray(b) && b.length === 4)) out.set(k, v);
    }
    return out;
}

function inAnyBbox(lat, lng, bboxes) {
    for (const [s, w, n, e] of bboxes) {
        if (lat >= s && lat <= n && lng >= w && lng <= e) return true;
    }
    return false;
}

async function main() {
    const { includeHidden } = parseArgs(process.argv.slice(2));
    const bboxes = loadBboxes();
    console.log(`Loaded ${bboxes.size} country bboxes.`);

    const where = { status: "active" };
    if (!includeHidden) where.isVisible = true;

    const places = await prisma.place.findMany({
        where,
        select: { id: true, name: true, city: true, region: true, country: true, lat: true, lng: true, isVisible: true },
    });
    console.log(`Loaded ${places.length} places (${includeHidden ? "all active" : "active+visible only"}).`);

    const flagged = [];
    const unmappedCountry = new Map(); // country → [{id,name,city}]
    const skippedNoCoords = [];
    let inBoxCount = 0;

    for (const p of places) {
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
            skippedNoCoords.push({ id: p.id, name: p.name, city: p.city, country: p.country });
            continue;
        }
        const bboxList = p.country ? bboxes.get(p.country) : null;
        if (!bboxList) {
            const k = p.country || "(null)";
            if (!unmappedCountry.has(k)) unmappedCountry.set(k, []);
            unmappedCountry.get(k).push({ id: p.id, name: p.name, city: p.city, lat, lng, isVisible: p.isVisible });
            continue;
        }
        if (inAnyBbox(lat, lng, bboxList)) {
            inBoxCount++;
            continue;
        }
        flagged.push({
            id: p.id,
            name: p.name,
            city: p.city,
            region: p.region,
            country: p.country,
            isVisible: p.isVisible,
            lat,
            lng,
            bboxes: bboxList,
        });
    }

    flagged.sort((a, b) => (a.country || "").localeCompare(b.country || ""));

    const out = {
        scanned: places.length,
        inBbox: inBoxCount,
        flaggedCount: flagged.length,
        unmappedCountryCount: [...unmappedCountry.values()].reduce((a, b) => a + b.length, 0),
        skippedNoCoordsCount: skippedNoCoords.length,
        flagged,
        unmappedCountry: Object.fromEntries(unmappedCountry),
        skippedNoCoords,
    };

    fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
    console.log(`In-bbox: ${inBoxCount}  Flagged: ${flagged.length}  Unmapped-country: ${out.unmappedCountryCount}  No-coords: ${skippedNoCoords.length}`);
    console.log(`Wrote ${OUT_FILE}`);

    if (flagged.length) {
        console.log("\nFlagged (lat/lng outside country bbox):");
        for (const f of flagged) {
            console.log(`  id=${String(f.id).padEnd(5)} ${f.country.padEnd(18)} ${f.city || "?"} — ${f.name}  [${f.lat.toFixed(3)}, ${f.lng.toFixed(3)}] ${f.isVisible ? "" : "(hidden)"}`);
        }
    }

    if (out.unmappedCountryCount) {
        console.log("\nUnmapped country values (need a bbox entry or a normalisation pass):");
        for (const [country, rows] of unmappedCountry) {
            console.log(`  ${country}: ${rows.length} row(s)`);
            for (const r of rows.slice(0, 3)) console.log(`    - id=${r.id} ${r.name} (${r.city || "?"})`);
            if (rows.length > 3) console.log(`    … and ${rows.length - 3} more`);
        }
    }

    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    prisma.$disconnect().finally(() => process.exit(1));
});
