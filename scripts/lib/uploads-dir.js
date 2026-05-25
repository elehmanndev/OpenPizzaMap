// Resolve where to write upload files. Mirrors src/app.js's read-path
// logic (commit 5a5b53b): write to persistent/uploads/ when available,
// fall back to public/uploads/ for local dev where persistent/ doesn't
// exist. Without this, files written by scripts get wiped by Hostinger's
// deploy pipeline (it restores nodejs/public/uploads/ from
// .builds/last-source on every git push, killing untracked slug subdirs
// and most runtime-written files).
//
// Usage:
//   const { getPlacesUploadDir } = require("../lib/uploads-dir");
//   const PLACES_DIR = getPlacesUploadDir();
//   // PLACES_DIR is `<persistent>/uploads/places` on Hostinger,
//   //              `<repo>/public/uploads/places` locally.

const fs = require("fs");
const path = require("path");

function getUploadsRoot(opts = {}) {
    const repoRoot = opts.repoRoot
        || path.resolve(__dirname, "..", "..");
    const persistentTarget = process.env.UPLOADS_DIR
        || path.join(repoRoot, "..", "persistent", "uploads");
    if (fs.existsSync(persistentTarget)) return persistentTarget;
    return path.join(repoRoot, "public", "uploads");
}

function getPlacesUploadDir(opts = {}) {
    return path.join(getUploadsRoot(opts), "places");
}

module.exports = { getUploadsRoot, getPlacesUploadDir };
