// Force Hostinger's Passenger to respawn the Node worker after a deploy.
//
// Without this, Passenger keeps the old worker running with the previous
// process state — including the previous Prisma engine. That bit us on
// 2026-05-03: a deploy regenerated node_modules/.prisma/client cleanly,
// but the live worker kept using the engine it had loaded at boot, so
// every DB query continued panicking until something else evicted the
// worker.
//
// Passenger restarts when the mtime of `tmp/restart.txt` (relative to the
// app root) changes. Touching that file from postinstall makes every
// deploy a hard restart.

const fs = require("fs");
const path = require("path");

const tmpDir = path.resolve("tmp");
const restartFile = path.join(tmpDir, "restart.txt");

try {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(restartFile, new Date().toISOString() + "\n");
} catch (err) {
    console.warn("[touch-passenger-restart] could not write tmp/restart.txt:", err && err.message);
}
