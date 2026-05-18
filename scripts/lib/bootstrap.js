// Single source of truth for env loading + Prisma client across ALL scripts.
//
// Why: before this existed, ~30 scripts each had their own `require('dotenv')`
// invocation — at least 7 different patterns. Some climbed four directories
// up, some assumed cwd was the repo root, only batch-enrich.js knew about
// Hostinger's `.builds/config/.env` layout. Result: scripts that worked
// locally crashed on Hostinger, scripts that worked on Hostinger crashed in
// the GitHub Actions cron, and every new script was a fresh chance to get the
// env path wrong. Commits 9fb2eb8, ed4b30a, 381c28a were all this same bug.
//
// Usage:
//   const { prisma } = require('../lib/bootstrap');   // from scripts/<subdir>/foo.js
//   const { prisma } = require('./lib/bootstrap');    // from scripts/foo.js
//
//   // Or, if the script doesn't need DB access (e.g. pure scrape-to-JSON):
//   require('../lib/bootstrap');                       // env-only
//
// Env precedence (matches src/app.js exactly so scripts and live app see the
// same config):
//   1. .builds/config/.env       — Hostinger deploy layout
//   2. .env.local                — local override (gitignored)
//   3. .env                      — default (gitignored)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

const ENV_CANDIDATES = [
    path.join(ROOT, ".builds", "config", ".env"),
    path.join(ROOT, ".env.local"),
    path.join(ROOT, ".env"),
];

// Accept either a .env file (local + Hostinger) OR pre-populated process.env
// (GitHub Actions workflows pass secrets via `env:` blocks; there's no file).
// File takes precedence so local edits override stale env in the parent shell.
const envPath = ENV_CANDIDATES.find((p) => fs.existsSync(p));
if (envPath) {
    // Mirror src/app.js: preserve a parent-supplied PORT across the
    // dotenv override so the preview harness / launch.json can pin a
    // different port without touching the user's .env.local (which
    // keeps PORT=3000 for normal solo dev). bootstrap.js runs again
    // INSIDE the live worker when src/services/maintenance.js requires
    // the enrichment scripts, so without this guard the second dotenv
    // pass undoes app.js's restore and the app binds 3000 anyway.
    const _pinnedPort = process.env.PORT;
    require("dotenv").config({ path: envPath, override: true });
    if (_pinnedPort) process.env.PORT = _pinnedPort;
} else if (!process.env.DATABASE_URL) {
    console.error("[bootstrap] No .env file found and DATABASE_URL not set in process.env.");
    console.error("[bootstrap] Looked for .env in:");
    for (const c of ENV_CANDIDATES) console.error("  -", c);
    console.error("[bootstrap] Refusing to start — this would crash on the first DB call.");
    process.exit(1);
}

if (!process.env.DATABASE_URL) {
    console.error(`[bootstrap] DATABASE_URL not set after loading ${envPath || "(no file)"}.`);
    console.error("[bootstrap] Refusing to start — this would crash on the first DB call.");
    process.exit(1);
}

// Reuse src/db.js so scripts share the same lazy-init Proxy as the live app.
// This matters on Hostinger where Passenger forks workers; a script that
// imports its own PrismaClient at top level can hit the same "tokio timer"
// panic the lazy-init Proxy was designed to avoid.
//
// Lazy-loaded inside the Proxy so scripts that only need env (e.g.
// scripts/deploy/migrate.js, which runs `prisma migrate deploy` and must
// not crash if @prisma/client isn't generated yet on a fresh Hostinger
// checkout) can `require('../lib/bootstrap')` without triggering
// `require('@prisma/client')`. The first actual `prisma.<x>` access pays
// the import cost.
let _db = null;
const prisma = new Proxy({}, {
    get(_, prop) {
        if (!_db) _db = require(path.join(ROOT, "src", "db.js"));
        return _db.prisma[prop];
    },
});

// Canonical on-disk locations for script artifacts. Use these everywhere
// instead of hard-coding `path.join(ROOT, 'something.json')` so the next
// "where does this file live" question has one answer.
//
//   scrapes  — input JSONs from scrape-* scripts (committed? no, regenerable)
//   cache    — cross-run caches (geocode, gmaps, reviews) — survives runs
//   reports  — audit/dedup/error outputs — disposable
const PATHS = {
    scrapes: path.join(ROOT, "data", "scrapes"),
    cache:   path.join(ROOT, "data", "cache"),
    reports: path.join(ROOT, "data", "reports"),
};
// Make sure the dirs exist so callers don't need to. Cheap on hot paths
// (mkdir recursive is a no-op when the dir exists).
for (const dir of Object.values(PATHS)) {
    fs.mkdirSync(dir, { recursive: true });
}

module.exports = {
    prisma,
    envPath,
    ROOT,
    PATHS,
};
