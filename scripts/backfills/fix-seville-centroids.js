#!/usr/bin/env node
// One-off: re-geocode the 2 Seville rows whose lat/lng landed on the
// city centroid (37.3886303, -5.9953403). Both rows have proper street
// addresses already, so Nominatim by addressLine should return a real
// street-level point.
//
// Acceptance: Haversine from the centroid must be ≥ 100 m. Anything
// closer than that is still effectively the centroid and we leave the
// row alone (Eric flagged it for hand-fix).
//
// Usage:
//   node scripts/fix-seville-centroids.js              # dry-run
//   node scripts/fix-seville-centroids.js --apply      # write to DB

const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");
const { haversineKm } = require(path.join(ROOT, "src", "services", "geo"));

const TARGETS = [1774, 1790];
const CENTROID = { lat: 37.3886303, lng: -5.9953403 };
const NOMINATIM_USER_AGENT = "OpenPizzaMap/0.1 (eric@openpizzamap.com)";
const NOMINATIM_DELAY_MS = 1100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(q) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`;
    const res = await fetch(url, { headers: { "User-Agent": NOMINATIM_USER_AGENT } });
    if (!res.ok) throw new Error(`Nominatim ${res.status}`);
    const arr = await res.json();
    if (!arr.length) return null;
    return {
        lat: Number(arr[0].lat),
        lng: Number(arr[0].lon),
        displayName: arr[0].display_name,
    };
}

async function main() {
    const apply = process.argv.includes("--apply");
    const report = [];

    for (const id of TARGETS) {
        const row = await prisma.place.findUnique({ where: { id } });
        if (!row) {
            report.push({ id, status: "missing" });
            continue;
        }
        const oldLat = Number(row.lat), oldLng = Number(row.lng);
        const distFromCentroidM = Math.round(haversineKm(oldLat, oldLng, CENTROID.lat, CENTROID.lng) * 1000);
        if (distFromCentroidM > 50) {
            report.push({ id, name: row.name, status: "not-centroid", distFromCentroidM });
            continue;
        }

        // Try queries in order of specificity. Stop on first acceptable hit.
        const queries = [];
        if (row.addressLine) queries.push(row.addressLine + ", Spain");
        queries.push(`${row.name}, ${row.city || "Sevilla"}, Spain`);

        let chosen = null, chosenQ = null;
        for (const q of queries) {
            await sleep(NOMINATIM_DELAY_MS);
            let hit;
            try { hit = await nominatim(q); }
            catch (e) { console.warn(`[id=${id}] nominatim error on "${q}":`, e.message); continue; }
            if (!hit) continue;
            const movedM = Math.round(haversineKm(hit.lat, hit.lng, oldLat, oldLng) * 1000);
            if (movedM < 100) continue; // still on the centroid
            chosen = hit;
            chosenQ = q;
            chosen.movedM = movedM;
            break;
        }

        if (!chosen) {
            report.push({ id, name: row.name, status: "no-acceptable-result", oldLat, oldLng });
            continue;
        }

        const result = {
            id,
            name: row.name,
            status: "resolved",
            oldLat, oldLng,
            newLat: chosen.lat,
            newLng: chosen.lng,
            movedM: chosen.movedM,
            query: chosenQ,
            displayName: chosen.displayName,
            mapsUrl: `https://www.google.com/maps?q=${chosen.lat},${chosen.lng}`,
        };

        if (apply) {
            await prisma.place.update({
                where: { id },
                data: { lat: chosen.lat, lng: chosen.lng },
            });
            result.applied = true;
        }
        report.push(result);
    }

    console.log("\n| id | name | old (lat,lng) | new (lat,lng) | moved | query | maps |");
    console.log("|---:|---|---|---|---:|---|---|");
    for (const r of report) {
        if (r.status !== "resolved") {
            console.log(`| ${r.id} | ${r.name || ""} | — | — | — | _${r.status}_ | — |`);
            continue;
        }
        console.log(`| ${r.id} | ${r.name} | (${r.oldLat}, ${r.oldLng}) | (${r.newLat}, ${r.newLng}) | ${r.movedM} m | ${r.query} | ${r.mapsUrl} |`);
    }

    if (!apply) console.log("\n(dry-run — pass --apply to write)");
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
