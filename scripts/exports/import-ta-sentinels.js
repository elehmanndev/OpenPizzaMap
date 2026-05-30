#!/usr/bin/env node
// Import a filled CSV from export-ta-sentinels.js back into the DB.
// Reads ta_url column, extracts the locationId via the URL pattern
// `Restaurant_Review-gXXXXXX-dNNNNNN-...`, POSTs to Hostinger's
// /api/admin/update-place-ta endpoint.
//
// Skips rows where ta_url is empty (Eric didn't find a match).
// Skips rows where the URL can't be parsed.
//
// Run on opm-runner:
//   docker exec -i opm-runner node scripts/exports/import-ta-sentinels.js < /tmp/sentinels.csv
// Or with explicit file:
//   docker exec opm-runner node scripts/exports/import-ta-sentinels.js --file /tmp/sentinels.csv

const fs = require("fs");
const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

function detectDelimiter(headerLine) {
    // Excel in EU locales (es/it/de/fr) saves CSV with semicolons. Detect
    // by counting candidates in the header line — whichever appears more
    // often wins. Defaults to comma if neither shows up.
    const commas = (headerLine.match(/,/g) || []).length;
    const semis = (headerLine.match(/;/g) || []).length;
    return semis > commas ? ";" : ",";
}

function parseCsvLine(line, delim = ",") {
    const out = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
            if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
            else if (c === '"') inQ = false;
            else cur += c;
        } else {
            if (c === '"') inQ = true;
            else if (c === delim) { out.push(cur); cur = ""; }
            else cur += c;
        }
    }
    out.push(cur);
    return out.map(s => s.trim());
}

function extractLocationId(taUrl) {
    if (!taUrl) return null;
    // Restaurant_Review-g194851-d3214749-Reviews-...
    const m = String(taUrl).match(/-d(\d+)-/);
    return m ? Number(m[1]) : null;
}

async function postTaUpdate(placeId, locationId) {
    const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
        method: "POST",
        headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ placeId, tripadvisorLocationId: locationId }),
    });
    return { ok: r.ok, status: r.status };
}

(async () => {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        console.error("HOSTINGER_URL or ADMIN_API_KEY unset");
        process.exit(1);
    }

    const fileArgIdx = process.argv.indexOf("--file");
    let raw;
    if (fileArgIdx !== -1 && process.argv[fileArgIdx + 1]) {
        raw = fs.readFileSync(process.argv[fileArgIdx + 1], "utf8");
    } else {
        raw = fs.readFileSync(0, "utf8"); // stdin
    }

    // Strip UTF-8 BOM that Excel adds when saving CSV
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);

    const lines = raw.split(/\r?\n/).filter(Boolean);
    if (!lines.length) { console.error("empty input"); process.exit(1); }

    const headerLine = lines.shift();
    const delim = detectDelimiter(headerLine);
    console.error(`# detected delimiter: ${delim === ";" ? "semicolon" : "comma"}`);

    const header = parseCsvLine(headerLine, delim);
    console.error(`# headers found: ${JSON.stringify(header)}`);

    const idIdx = header.indexOf("id");
    const nameIdx = header.indexOf("name");
    const taUrlIdx = header.indexOf("ta_url");
    if (idIdx === -1 || taUrlIdx === -1) {
        console.error("CSV missing required columns (id, ta_url)");
        process.exit(1);
    }

    const stats = { total: 0, applied: 0, skippedEmpty: 0, skippedBadUrl: 0, failed: 0 };

    for (const line of lines) {
        const cols = parseCsvLine(line, delim);
        const placeId = Number(cols[idIdx]);
        const name = cols[nameIdx] || "";
        const taUrl = (cols[taUrlIdx] || "").trim();
        stats.total++;

        if (!taUrl) { stats.skippedEmpty++; continue; }

        const locationId = extractLocationId(taUrl);
        if (!locationId) {
            console.warn(`  #${placeId} "${name}" → BAD URL: ${taUrl}`);
            stats.skippedBadUrl++;
            continue;
        }

        const res = await postTaUpdate(placeId, locationId);
        if (res.ok) {
            console.log(`  #${placeId} "${name}" → locationId=${locationId}`);
            stats.applied++;
        } else {
            console.warn(`  #${placeId} "${name}" → HTTP ${res.status}`);
            stats.failed++;
        }
        // light spacing — Hostinger is fine but no need to flood
        await new Promise(r => setTimeout(r, 100));
    }

    console.log(`\n# DONE`);
    console.log(`  total rows:           ${stats.total}`);
    console.log(`  applied:              ${stats.applied}`);
    console.log(`  skipped (empty):      ${stats.skippedEmpty}`);
    console.log(`  skipped (bad url):    ${stats.skippedBadUrl}`);
    console.log(`  failed (http):        ${stats.failed}`);
})().catch((e) => { console.error(e); process.exit(1); });
