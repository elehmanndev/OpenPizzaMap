#!/usr/bin/env node
// Generate {N}-thumb.jpg variants (400 px wide, q78) next to every place
// upload in public/uploads/places/. The map popup uses these instead of the
// full-resolution originals (some of which are 10-28 MB raw photos), which
// was flooding Hostinger IOPS and giving 600 ms TTFB.
//
// Idempotent: skips files where the thumb is fresher than the source. Pass
// --force to regenerate everything. Pass --file <path> to thumb a single
// image (used by download-images.js to thumb new arrivals).

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const PLACES_DIR = path.join(ROOT, "public", "uploads", "places");
const THUMB_WIDTH = 400;
const THUMB_QUALITY = 78;

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const SINGLE_FILE = (() => {
    const i = args.indexOf("--file");
    return i === -1 ? null : args[i + 1];
})();

function thumbPathFor(srcPath) {
    const dir = path.dirname(srcPath);
    const ext = path.extname(srcPath);
    const base = path.basename(srcPath, ext);
    if (base.endsWith("-thumb")) return null;
    return path.join(dir, `${base}-thumb.jpg`);
}

async function buildThumb(srcPath) {
    const thumbPath = thumbPathFor(srcPath);
    if (!thumbPath) return { skipped: "is-thumb" };

    if (!FORCE && fs.existsSync(thumbPath)) {
        const srcStat = fs.statSync(srcPath);
        const thumbStat = fs.statSync(thumbPath);
        if (thumbStat.mtimeMs >= srcStat.mtimeMs) {
            return { skipped: "fresh", thumbPath };
        }
    }

    await sharp(srcPath)
        .rotate()
        .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
        .toFile(thumbPath);

    const srcBytes = fs.statSync(srcPath).size;
    const thumbBytes = fs.statSync(thumbPath).size;
    return { thumbPath, srcBytes, thumbBytes };
}

async function main() {
    if (SINGLE_FILE) {
        const result = await buildThumb(SINGLE_FILE);
        if (result.skipped) {
            console.log(`skip (${result.skipped}): ${SINGLE_FILE}`);
        } else {
            console.log(`built: ${result.thumbPath} (${(result.srcBytes / 1024).toFixed(0)} KB → ${(result.thumbBytes / 1024).toFixed(0)} KB)`);
        }
        return;
    }

    if (!fs.existsSync(PLACES_DIR)) {
        console.error(`No such dir: ${PLACES_DIR}`);
        process.exit(1);
    }

    const entries = fs.readdirSync(PLACES_DIR);
    const sources = entries.filter((name) => {
        if (!/\.(jpe?g|png|webp|gif|avif)$/i.test(name)) return false;
        const base = name.replace(/\.[^.]+$/, "");
        return !base.endsWith("-thumb");
    });

    console.log(`Scanning ${sources.length} source images in ${PLACES_DIR}`);

    let built = 0, skipped = 0, failed = 0;
    let totalSrc = 0, totalThumb = 0;

    for (const name of sources) {
        const srcPath = path.join(PLACES_DIR, name);
        try {
            const result = await buildThumb(srcPath);
            if (result.skipped) {
                skipped++;
            } else {
                built++;
                totalSrc += result.srcBytes;
                totalThumb += result.thumbBytes;
                if (built % 50 === 0) {
                    console.log(`  ${built} built…`);
                }
            }
        } catch (err) {
            failed++;
            console.warn(`  failed ${name}: ${err.message}`);
        }
    }

    console.log("");
    console.log(`Built:   ${built}`);
    console.log(`Skipped: ${skipped} (already fresh)`);
    console.log(`Failed:  ${failed}`);
    if (built) {
        const srcMb = (totalSrc / 1024 / 1024).toFixed(1);
        const thumbMb = (totalThumb / 1024 / 1024).toFixed(1);
        const ratio = totalSrc ? (100 * (1 - totalThumb / totalSrc)).toFixed(1) : "0";
        console.log(`Source:  ${srcMb} MB → Thumbs: ${thumbMb} MB  (${ratio}% smaller)`);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
