const { PrismaClient } = require("@prisma/client");

let _instance = null;

// Cap each Passenger worker's connection pool. Hostinger shared hosting has a
// hard ~120 entry-process cap for the whole account. Prisma's default pool is
// `cpus*2+1` PER worker, and each worker also runs its own query-engine
// process — so a handful of workers (plus the Unraid opm-runner hitting the
// same MySQL) can exhaust the cap and take `/api/places` down for hours.
// connection_limit=3 is plenty for this low-traffic read-mostly site and keeps
// total connections bounded no matter how many workers Passenger spawns.
// Override via DATABASE_URL query params if ever needed; this only fills the
// default when they're absent.
function buildDatasourceUrl() {
    const base = process.env.DATABASE_URL;
    if (!base) return undefined;
    if (/[?&]connection_limit=/.test(base)) return base; // respect explicit value
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}connection_limit=3&pool_timeout=20`;
}

function getClient() {
    if (!_instance) {
        const url = buildDatasourceUrl();
        _instance = url
            ? new PrismaClient({ datasources: { db: { url } } })
            : new PrismaClient();
    }
    return _instance;
}

function resetClient() {
    if (_instance) {
        _instance.$disconnect().catch(() => {});
        _instance = null;
    }
}

// Proxy defers `new PrismaClient()` until the first DB call, which happens
// after Passenger forks workers. Without this, the tokio timer threads in
// the parent don't survive the fork, causing "PANIC: timer has gone away"
// on the first query in every worker.
const prisma = new Proxy({}, {
    get(_, prop) { return getClient()[prop]; },
});

module.exports = { prisma, resetClient };
