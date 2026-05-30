#!/usr/bin/env node
// Apply a batch of placeId,locationId,name lines to the DB via
// Hostinger's /api/admin/update-place-ta endpoint. Reads from the file
// `scripts/exports/ta-batch-results.txt` by default (the output of the
// 2026-05-30 agent-assisted bulk TA lookup pass).
//
// File format (one entry per line):
//   <placeId>,<locationId>,<placeName>
// Lines starting with `#` are comments (MISS entries, headers, etc.)
// and are skipped silently.
//
// Run on opm-runner:
//   docker exec opm-runner node scripts/exports/apply-ta-batch-from-file.js
//   docker exec opm-runner node scripts/exports/apply-ta-batch-from-file.js --file scripts/exports/ta-batch-results.txt

const fs = require("fs");
const path = require("path");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

(async () => {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        console.error("HOSTINGER_URL or ADMIN_API_KEY unset");
        process.exit(1);
    }

    const fileIdx = process.argv.indexOf("--file");
    const filePath = fileIdx !== -1 && process.argv[fileIdx + 1]
        ? process.argv[fileIdx + 1]
        : path.join(__dirname, "ta-batch-results.txt");

    if (!fs.existsSync(filePath)) {
        console.error(`file not found: ${filePath}`);
        process.exit(1);
    }

    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    const pairs = [];
    for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith("#")) continue;
        const [pidRaw, lidRaw, ...nameParts] = t.split(",");
        const placeId = Number(pidRaw);
        const locationId = Number(lidRaw);
        const name = nameParts.join(",").trim();
        if (!Number.isFinite(placeId) || !Number.isFinite(locationId)) {
            console.warn(`bad line: ${t}`);
            continue;
        }
        pairs.push({ placeId, locationId, name });
    }

    console.log(`# Loaded ${pairs.length} pairs from ${filePath}`);

    let applied = 0, failed = 0;
    for (const { placeId, locationId, name } of pairs) {
        const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
            method: "POST",
            headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ placeId, tripadvisorLocationId: locationId }),
        });
        if (r.ok) {
            console.log(`  #${placeId} "${name}" → ${locationId}`);
            applied++;
        } else {
            const body = await r.text().catch(() => "");
            console.warn(`  #${placeId} "${name}" → HTTP ${r.status} :: ${body.slice(0, 300)}`);
            failed++;
        }
        await new Promise((res) => setTimeout(res, 80));
    }

    console.log(`\n# DONE`);
    console.log(`  applied: ${applied}`);
    console.log(`  failed:  ${failed}`);
})().catch((e) => { console.error(e); process.exit(1); });
