#!/usr/bin/env node
// Smart postinstall — runs the deploy chain (chmod / prisma generate /
// playwright install / asset-version / passenger restart) but SKIPS
// the heavy steps when their trigger files haven't changed since the
// last successful run.
//
// The problem this solves:
//   Hostinger's git auto-deploy fires `npm install` on every push,
//   which runs our postinstall, which used to unconditionally run:
//     1. chmod prisma engines     (cheap)
//     2. prisma generate          (Rust engine extract, spawns sub-procs)
//     3. chmod prisma engines     (cheap)
//     4. playwright install       (~300MB chromium check, spawns curl + extract)
//     5. asset-version build      (cheap, but code might have changed)
//     6. touch passenger restart  (cheap)
//
//   Even when only a CSS file changed, Hostinger spun up ~80 transient
//   processes during this chain and hit the 120-process cap on the
//   shared host, returning 113 "fallas" (failed forks → 500 responses)
//   the moment a deploy coincided with normal traffic.
//
// The gating:
//   We hash each "trigger" set and store the hash in .deploy-state.json
//   under node_modules/ (gets wiped on a fresh install — fine, full
//   chain runs on cold installs anyway). On subsequent installs, each
//   heavy step compares its current trigger hash to the stored one and
//   skips if nothing changed.
//
//   Triggers:
//     prisma generate     → hash(prisma/schema.prisma)
//     playwright install  → hash(<playwright entry in package-lock.json>)
//     asset-version       → always re-build (cheap, always-fresh hashes
//                           matter for cache-busting on every code change)
//     chmod / touch       → always (cheap, near-zero cost)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const STATE_FILE = path.join(ROOT, "node_modules", ".deploy-state.json");

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { return {}; }
}
function saveState(state) {
    try {
        fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
        // Non-fatal — next deploy just re-runs the heavy steps.
        console.warn(`[smart-postinstall] state write failed: ${e.message}`);
    }
}
function hashFile(p) {
    try { return crypto.createHash("sha1").update(fs.readFileSync(p)).digest("hex"); }
    catch { return null; }
}
function runStep(label, cmd) {
    console.log(`[smart-postinstall] ▶ ${label}`);
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
}

const state = loadState();
const nextState = { ...state };

// 1. chmod prisma engines — cheap, always run. Ensures executable bit
//    survived the git checkout (Hostinger strips it on .node files).
runStep("chmod prisma engines (pre)", "node scripts/deploy/chmod-prisma-engines.js");

// 2. prisma generate — only when schema.prisma changed. The Rust engine
//    extract + client re-write is the heaviest step in the chain.
const schemaHash = hashFile(path.join(ROOT, "prisma", "schema.prisma"));
if (schemaHash && schemaHash === state.schemaHash) {
    console.log("[smart-postinstall] ⏭  prisma generate skipped (schema unchanged)");
} else {
    runStep("prisma generate", "npm run prisma:generate");
    nextState.schemaHash = schemaHash;
    // Re-chmod after generate — the freshly extracted engine binaries
    // don't carry the executable bit either.
    runStep("chmod prisma engines (post)", "node scripts/deploy/chmod-prisma-engines.js");
}

// 3. playwright install — only when the playwright entry in
//    package-lock.json changed. Detects version bumps without re-checking
//    the 300MB Chromium bundle on every deploy.
const lockPath = path.join(ROOT, "package-lock.json");
let playwrightHash = null;
try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    // Hash the playwright + playwright-core entries — version bumps in
    // either trigger a re-install.
    const pw = (lock.packages || {})["node_modules/playwright"];
    const pwc = (lock.packages || {})["node_modules/playwright-core"];
    const sig = JSON.stringify({ pw: pw && pw.version, pwc: pwc && pwc.version });
    playwrightHash = crypto.createHash("sha1").update(sig).digest("hex");
} catch {
    // If the lock file can't be read, fall through and run the install.
}
if (process.env.SKIP_PLAYWRIGHT_INSTALL === "1") {
    console.log("[smart-postinstall] ⏭  playwright install skipped (SKIP_PLAYWRIGHT_INSTALL=1)");
} else if (playwrightHash && playwrightHash === state.playwrightHash) {
    console.log("[smart-postinstall] ⏭  playwright install skipped (version unchanged)");
} else {
    runStep("playwright install", "node scripts/deploy/setup-playwright.js");
    if (playwrightHash) nextState.playwrightHash = playwrightHash;
}

// 4. asset-version — always run. Cheap, and the asset hashes need to
//    refresh on every code change to bust browser caches correctly.
runStep("asset-version build", "npm run build:asset-version");

// 5. touch passenger restart — always run. Cheap, and the whole point
//    is to bounce the app after the above completed.
runStep("touch passenger restart", "node scripts/deploy/touch-passenger-restart.js");

saveState(nextState);
console.log("[smart-postinstall] done");
