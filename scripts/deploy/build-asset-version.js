// Compute the asset-version cache-bust string once at deploy time and write
// it to .builds/asset-version.txt. Cold worker boots then read the file
// instead of walking public/{css,js,assets} on every spawn — Hostinger's
// Passenger respawn churn was making this hot.

const fs = require("fs");
const path = require("path");

const ROOT = process.cwd();
const PUBLIC_ROOT = path.join(ROOT, "public");
const SCAN_DIRS = ["css", "js", "assets"];
const OUT_DIR = path.join(ROOT, ".builds");
const OUT_FILE = path.join(OUT_DIR, "asset-version.txt");

function latestMtimeMs(dir) {
    let latest = 0;
    if (!fs.existsSync(dir)) return latest;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            latest = Math.max(latest, latestMtimeMs(full));
        } else if (entry.isFile()) {
            latest = Math.max(latest, fs.statSync(full).mtimeMs);
        }
    }
    return latest;
}

let latest = 0;
for (const sub of SCAN_DIRS) {
    latest = Math.max(latest, latestMtimeMs(path.join(PUBLIC_ROOT, sub)));
}

const value = latest ? String(Math.floor(latest)) : String(Date.now());
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, value, "utf8");
console.log(`Asset version: ${value} -> ${path.relative(ROOT, OUT_FILE)}`);
