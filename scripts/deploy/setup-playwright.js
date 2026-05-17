// Make Playwright runnable on Hostinger after every deploy:
//
// 1. chmod +x on node_modules/.bin/playwright and node_modules/
//    playwright-core/cli.js — Hostinger's git auto-deploy strips the
//    executable bit (same bug docs/runbook.md documents for the Prisma
//    engines). Without the +x, `npx playwright install` fails with
//    EACCES.
//
// 2. `npx playwright install chromium --no-shell` — Chromium binaries
//    live in ~/.cache/ms-playwright/ which is OUTSIDE the deploy tree,
//    so they SHOULD survive deploys. But if Hostinger ever wipes the
//    cache or the playwright version bumps and adds a new browser
//    revision, the next `chromium.launch()` panics with "Executable
//    doesn't exist." Running install on every deploy is idempotent
//    (it skips browsers already at the right version) and ~free on
//    subsequent deploys.
//
// Single-process mode is set inside scripts/lib/gmaps.js's launch
// args (the only way Chromium runs on Hostinger shared, see the
// 2026-05-17 investigation). This script handles binary presence;
// the launch args handle process model.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const BINARIES_TO_CHMOD = [
    path.join(ROOT, "node_modules", ".bin", "playwright"),
    path.join(ROOT, "node_modules", "playwright-core", "cli.js"),
];

function chmodIfExists(p) {
    if (!fs.existsSync(p)) {
        console.log(`[playwright-setup] skip chmod (not present): ${p}`);
        return;
    }
    try {
        fs.chmodSync(p, 0o755);
        console.log(`[playwright-setup] chmod 755: ${p}`);
    } catch (err) {
        console.error(`[playwright-setup] chmod failed for ${p}: ${err.message}`);
    }
}

for (const p of BINARIES_TO_CHMOD) chmodIfExists(p);

// Run the install. `--with-deps` would need apt-get (won't work on
// Hostinger shared); we install the binary only. If a needed system
// lib is missing the launch errors out at runtime, not here.
//
// SKIP_PLAYWRIGHT_INSTALL=1 escape hatch for local dev / CI where you
// don't want to download the 300MB chromium bundle on every npm install.
if (process.env.SKIP_PLAYWRIGHT_INSTALL === "1") {
    console.log("[playwright-setup] SKIP_PLAYWRIGHT_INSTALL=1, skipping chromium install");
    process.exit(0);
}

try {
    // Pin browser path to the REAL user home (from /etc/passwd via
    // os.userInfo) — same logic scripts/lib/gmaps.js uses at runtime.
    // Without the pin, Hostinger's Passenger sets $HOME to the app
    // directory, install + launch disagree on the path, and the
    // launch fails with "Executable doesn't exist". See 2026-05-17.
    const installEnv = { ...process.env };
    if (!installEnv.PLAYWRIGHT_BROWSERS_PATH) {
        try {
            const homedir = require("os").userInfo().homedir;
            if (homedir) {
                installEnv.PLAYWRIGHT_BROWSERS_PATH = path.join(homedir, ".cache", "ms-playwright");
                console.log(`[playwright-setup] PLAYWRIGHT_BROWSERS_PATH=${installEnv.PLAYWRIGHT_BROWSERS_PATH}`);
            }
        } catch (_) { /* fall back to default */ }
    }
    console.log("[playwright-setup] running: npx playwright install chromium");
    execSync("npx playwright install chromium", {
        cwd: ROOT,
        stdio: "inherit",
        env: installEnv,
    });
    console.log("[playwright-setup] chromium install complete");
} catch (err) {
    // Don't fail the deploy if chromium install fails — the other 9
    // maintenance phases still work and the playwrightFallback phase
    // will report ok:false with the underlying error. Deploy keeps
    // moving.
    console.error(`[playwright-setup] chromium install failed (non-fatal): ${err.message}`);
}
