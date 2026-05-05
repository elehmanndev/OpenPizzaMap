// Hostinger's git deploy strips exec bits, so any Prisma binary copied into
// node_modules ends up mode 0644 by default. The Rust query engine then
// fails to launch and every DB call throws PrismaClientRustPanicError, which
// is exactly the outage we hit on 2026-05-03 (whole site 503'd while the
// process itself was alive).
//
// We run this script twice from postinstall:
//   1. After `npm install` — covers the engines dropped under
//      node_modules/@prisma/engines and the prisma CLI in node_modules/.bin
//      (needed for `prisma migrate deploy` in scripts/migrate.js).
//   2. After `prisma generate` — covers node_modules/.prisma/client, which
//      is the directory @prisma/client actually loads at runtime. This was
//      missing before and is the proximate cause of the 2026-05-03 outage.

const fs = require("fs");
const path = require("path");

const TARGETS = [
    "node_modules/@prisma/engines",
    "node_modules/.prisma/client",
    "node_modules/.bin",
];

for (const dir of TARGETS) {
    const abs = path.resolve(dir);
    let entries;
    try {
        entries = fs.readdirSync(abs);
    } catch (_e) {
        continue;
    }
    for (const name of entries) {
        const full = path.join(abs, name);
        try {
            fs.chmodSync(full, 0o755);
        } catch (_e) {
            // Best-effort: a missing/locked file shouldn't fail the deploy.
        }
    }
}
