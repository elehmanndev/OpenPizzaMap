// Run `prisma migrate deploy` only when the migrations folder has changed.
//
// Hostinger Passenger respawns the Node worker many times a day (idle reaps,
// new requests after a quiet period, etc.) and `npm start` chains migrate
// before the server. Running migrate on every respawn was hitting MySQL +
// spawning the migration engine subprocess for nothing — both contribute to
// the IOPS / Max Processes ceiling on shared hosting.
//
// Strategy: hash the names + sizes + mtimes of every migration.sql under
// prisma/migrations/ and store it in `.builds/last-migrate-hash` after a
// successful run. On boot, if the current hash matches the stored one, we
// skip the spawn entirely (~zero IO). Any change to a migration file (new
// folder, new SQL, edited SQL) busts the hash and triggers a fresh deploy.
//
// Set MIGRATE_FORCE=true to override and always run (useful if the sentinel
// gets out of sync).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const dotenv = require("dotenv");
const { spawnSync } = require("child_process");

const ROOT = process.cwd();
const hostingerEnv = path.join(ROOT, ".builds", "config", ".env");
const localEnv = path.join(ROOT, ".env.local");
const defaultEnv = path.join(ROOT, ".env");
const envPath = fs.existsSync(hostingerEnv)
    ? hostingerEnv
    : (fs.existsSync(localEnv) ? localEnv : defaultEnv);

dotenv.config({
    path: envPath,
    override: envPath === localEnv || envPath === hostingerEnv,
});

const MIGRATIONS_DIR = path.join(ROOT, "prisma", "migrations");
const SENTINEL_DIR = path.join(ROOT, ".builds");
const SENTINEL_PATH = path.join(SENTINEL_DIR, "last-migrate-hash");

function computeMigrationsHash() {
    if (!fs.existsSync(MIGRATIONS_DIR)) return null;
    const hash = crypto.createHash("sha256");
    function walk(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            const stat = fs.statSync(full);
            const rel = path.relative(MIGRATIONS_DIR, full);
            hash.update(`${rel}\0${stat.size}\0${Math.floor(stat.mtimeMs)}\n`);
        }
    }
    walk(MIGRATIONS_DIR);
    return hash.digest("hex");
}

const force = String(process.env.MIGRATE_FORCE || "").toLowerCase() === "true";
const currentHash = computeMigrationsHash();
const lastHash = fs.existsSync(SENTINEL_PATH)
    ? fs.readFileSync(SENTINEL_PATH, "utf8").trim()
    : null;

if (!force && currentHash && lastHash && currentHash === lastHash) {
    console.log("Migrations unchanged since last deploy — skipping prisma migrate.");
    process.exit(0);
}

const result = spawnSync(
    process.execPath,
    ["node_modules/.bin/prisma", "migrate", "deploy"],
    {
        stdio: "inherit",
        env: process.env,
    }
);

if (result.status !== 0) {
    console.error("Prisma migrate deploy failed.");
    // Strict-by-default: a failed migration must fail the deploy. Otherwise the
    // app boots with a stale schema and starts 503-ing only the routes that
    // touch the missing tables (we lost ~4h to this on 2026-04-30).
    // Set MIGRATE_LENIENT=true to opt out (only for explicit recovery flows).
    if (String(process.env.MIGRATE_LENIENT || "").toLowerCase() === "true") {
        console.warn("MIGRATE_LENIENT=true — booting anyway with possibly-stale schema.");
        process.exit(0);
    }
    process.exit(result.status || 1);
}

if (currentHash) {
    try {
        fs.mkdirSync(SENTINEL_DIR, { recursive: true });
        fs.writeFileSync(SENTINEL_PATH, currentHash);
    } catch (err) {
        console.warn(`Could not write migrate sentinel: ${err.message}`);
    }
}
