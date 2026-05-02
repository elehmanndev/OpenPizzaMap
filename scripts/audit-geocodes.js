// Flags Place rows whose lat/lng is far from the median centroid of their
// (city, country) cluster. Pure DB-side audit — no external geocoder calls,
// so no budget hit. Outputs JSON to ../geocode-audit.json (project root,
// matching the existing scrape outputs).
//
// Usage:
//   node scripts/audit-geocodes.js                    # threshold 50 km
//   node scripts/audit-geocodes.js --threshold 25     # tighter
//
// A row is flagged when:
//   1. Its (city, country) bucket has at least MIN_PEERS other rows AND
//   2. Its haversine distance from the median lat/lng of that bucket
//      exceeds the threshold.
//
// "Suggested" coords are the median of the rest of the bucket — useful when
// the row is a copy-paste import error and the city itself is well placed.

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", "..", ".env.local") });
require("dotenv").config({ path: path.join(__dirname, "..", "..", "..", "..", ".env") });

const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const { haversineKm } = require("../src/services/geo");

const prisma = new PrismaClient();

const MIN_PEERS = 2; // need ≥2 other rows in the bucket to trust the centroid
const DEFAULT_THRESHOLD_KM = 50;

function median(nums) {
    const s = [...nums].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function parseArgs(argv) {
    const out = { threshold: DEFAULT_THRESHOLD_KM };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === "--threshold" && argv[i + 1]) {
            out.threshold = Number(argv[++i]);
        }
    }
    if (!Number.isFinite(out.threshold) || out.threshold <= 0) {
        out.threshold = DEFAULT_THRESHOLD_KM;
    }
    return out;
}

async function main() {
    const { threshold } = parseArgs(process.argv.slice(2));
    console.log(`Auditing geocodes — flag if > ${threshold} km from city centroid (min ${MIN_PEERS} peers).`);

    const places = await prisma.place.findMany({
        where: { status: "active", isVisible: true },
        select: { id: true, name: true, city: true, country: true, lat: true, lng: true },
    });
    console.log(`Loaded ${places.length} active+visible places.`);

    // Bucket by (city, region, country) when region is set so that e.g.
    // Arlington VA and Arlington TX get separate buckets. Falls back to
    // (city, country) when region is missing.
    const buckets = new Map();
    for (const p of places) {
        if (!p.city || !p.country) continue;
        const lat = Number(p.lat);
        const lng = Number(p.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const key = `${p.city}|${p.region || ""}|${p.country}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push({ id: p.id, name: p.name, lat, lng });
    }

    const flagged = [];
    const unverified = []; // singleton cities — can't audit, but worth listing

    for (const [key, rows] of buckets) {
        const [city, region, country] = key.split("|");
        if (rows.length === 1) {
            unverified.push({ city, region, country, id: rows[0].id, name: rows[0].name });
            continue;
        }
        if (rows.length < MIN_PEERS + 1) continue;

        // Use the median of the WHOLE bucket, not peers-minus-self. With
        // peers-minus-self in a 3-row bucket where one row is way off, the
        // remaining two get averaged and any clean row gets dragged toward
        // the bad one. The full-bucket median is robust for n ≥ 3.
        const medLat = median(rows.map((r) => r.lat));
        const medLng = median(rows.map((r) => r.lng));

        for (const row of rows) {
            const dist = haversineKm(row.lat, row.lng, medLat, medLng);
            if (dist > threshold) {
                flagged.push({
                    id: row.id,
                    name: row.name,
                    city, region, country,
                    currentLat: row.lat,
                    currentLng: row.lng,
                    distanceKm: Math.round(dist),
                    bucketSize: rows.length,
                    suggestedLat: Number(medLat.toFixed(7)),
                    suggestedLng: Number(medLng.toFixed(7)),
                });
            }
        }
    }

    flagged.sort((a, b) => b.distanceKm - a.distanceKm);

    const out = {
        thresholdKm: threshold,
        scannedPlaces: places.length,
        bucketsScanned: buckets.size,
        unverifiedCount: unverified.length,
        flaggedCount: flagged.length,
        flagged,
        unverified,
    };

    const outPath = path.join(__dirname, "..", "..", "..", "..", "geocode-audit.json");
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
    console.log(`Flagged ${flagged.length} rows; ${unverified.length} singleton-city rows can't be audited.`);
    console.log(`Wrote ${outPath}`);
    if (flagged.length) {
        console.log("\nTop 20 worst offenders:");
        for (const f of flagged.slice(0, 20)) {
            console.log(`  ${String(f.distanceKm).padStart(5)} km  id=${String(f.id).padEnd(5)} ${f.city}, ${f.country.padEnd(3)} — ${f.name}`);
        }
    }

    await prisma.$disconnect();
}

main().catch((err) => {
    console.error(err);
    prisma.$disconnect().finally(() => process.exit(1));
});
