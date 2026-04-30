#!/usr/bin/env node
// Generate downscaled variants next to every place upload in
// public/uploads/places/. Two variants:
//
//   {N}-thumb.jpg  ← 400 px wide,  q78  (used by the map popup)
//   {N}-large.jpg  ← 1200 px wide, q82  (used by /place/:id hero)
//
// Originals (10-28 MB raw photos) flooded Hostinger IOPS and gave 600 ms
// TTFBs; the variants drop both costs by ~94% / ~85%.
//
// Idempotent: skips files where every needed variant is fresher than the
// source. Pass --force to regenerate everything. Pass --file <path> to
// process a single source image (used by download-images.js to thumb new
// arrivals). Pass --variant thumb|large|all (default: all).
//
// Sharp can't decode some pathological AVIFs (libheif "bad seek"). When that
// happens we fall back to a Playwright-rendered Chromium screenshot, which
// handles every AVIF the browser does. Playwright is loaded lazily so the
// hot path stays fast.

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const PLACES_DIR = path.join(ROOT, "public", "uploads", "places");

const VARIANTS = {
    thumb: { suffix: "-thumb", width: 400, quality: 78 },
    large: { suffix: "-large", width: 1200, quality: 82 },
};

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const SINGLE_FILE = (() => {
    const i = args.indexOf("--file");
    return i === -1 ? null : args[i + 1];
})();
const VARIANT_ARG = (() => {
    const i = args.indexOf("--variant");
    return i === -1 ? "all" : args[i + 1];
})();
const REQUESTED_VARIANTS = VARIANT_ARG === "all"
    ? Object.keys(VARIANTS)
    : [VARIANT_ARG].filter((v) => VARIANTS[v]);

if (!REQUESTED_VARIANTS.length) {
    console.error(`Unknown --variant ${VARIANT_ARG}. Use thumb|large|all.`);
    process.exit(1);
}

function variantPath(srcPath, variant) {
    const dir = path.dirname(srcPath);
    const ext = path.extname(srcPath);
    const base = path.basename(srcPath, ext);
    if (base.endsWith("-thumb") || base.endsWith("-large")) return null;
    return path.join(dir, `${base}${VARIANTS[variant].suffix}.jpg`);
}

let playwrightContext = null;
async function getPlaywrightContext() {
    if (playwrightContext) return playwrightContext;
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    const context = await browser.newContext({ deviceScaleFactor: 1 });
    playwrightContext = { browser, context };
    return playwrightContext;
}
async function closePlaywrightContext() {
    if (!playwrightContext) return;
    try {
        await playwrightContext.context.close();
        await playwrightContext.browser.close();
    } catch {}
    playwrightContext = null;
}

// Fallback: render the source image in headless Chromium and screenshot a
// downscaled view. Slow per-call (~3 s) but only used when sharp fails.
async function renderViaPlaywright(srcPath, dstPath, width, quality) {
    const { context } = await getPlaywrightContext();
    const page = await context.newPage();
    try {
        const buf = fs.readFileSync(srcPath);
        const ext = path.extname(srcPath).slice(1).toLowerCase() || "jpg";
        const mime = ext === "avif" ? "image/avif"
            : ext === "webp" ? "image/webp"
                : ext === "png" ? "image/png"
                    : ext === "gif" ? "image/gif"
                        : "image/jpeg";
        const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>
            html,body{margin:0;padding:0;background:#000;}
            img{display:block;width:${width}px;height:auto;}
        </style><img src="${dataUrl}" />`);
        const img = await page.locator("img");
        await img.waitFor({ state: "visible", timeout: 10000 });
        // Wait for natural dimensions to populate, otherwise screenshot may catch a 0×0 frame.
        await page.waitForFunction(() => {
            const el = document.querySelector("img");
            return el && el.naturalWidth > 0;
        }, { timeout: 10000 });
        const pngBuf = await img.screenshot({ type: "png" });
        // Re-encode PNG → JPEG via sharp (sharp can always read PNG).
        await sharp(pngBuf)
            .jpeg({ quality, mozjpeg: true })
            .toFile(dstPath);
    } finally {
        await page.close();
    }
}

async function buildVariant(srcPath, variant) {
    const dstPath = variantPath(srcPath, variant);
    if (!dstPath) return { skipped: "is-variant" };

    if (!FORCE && fs.existsSync(dstPath)) {
        const srcStat = fs.statSync(srcPath);
        const dstStat = fs.statSync(dstPath);
        if (dstStat.mtimeMs >= srcStat.mtimeMs) {
            return { skipped: "fresh", dstPath };
        }
    }

    const { width, quality } = VARIANTS[variant];

    try {
        await sharp(srcPath)
            .rotate()
            .resize({ width, withoutEnlargement: true })
            .jpeg({ quality, mozjpeg: true })
            .toFile(dstPath);
    } catch (sharpErr) {
        // Sharp choked (typically libheif on weird AVIFs). Try Playwright.
        try {
            await renderViaPlaywright(srcPath, dstPath, width, quality);
        } catch (pwErr) {
            const err = new Error(`sharp: ${sharpErr.message}; playwright: ${pwErr.message}`);
            err.cause = sharpErr;
            throw err;
        }
    }

    const srcBytes = fs.statSync(srcPath).size;
    const dstBytes = fs.statSync(dstPath).size;
    return { dstPath, srcBytes, dstBytes };
}

async function buildAll(srcPath) {
    const out = {};
    for (const variant of REQUESTED_VARIANTS) {
        out[variant] = await buildVariant(srcPath, variant);
    }
    return out;
}

async function main() {
    if (SINGLE_FILE) {
        const result = await buildAll(SINGLE_FILE);
        for (const [variant, r] of Object.entries(result)) {
            if (r.skipped) {
                console.log(`skip ${variant} (${r.skipped}): ${SINGLE_FILE}`);
            } else {
                console.log(`built ${variant}: ${r.dstPath} (${(r.srcBytes / 1024).toFixed(0)} KB → ${(r.dstBytes / 1024).toFixed(0)} KB)`);
            }
        }
        await closePlaywrightContext();
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
        return !base.endsWith("-thumb") && !base.endsWith("-large");
    });

    console.log(`Scanning ${sources.length} source images, variants=[${REQUESTED_VARIANTS.join(",")}]`);

    let built = 0, skipped = 0, failed = 0;
    const totals = Object.fromEntries(REQUESTED_VARIANTS.map((v) => [v, { src: 0, out: 0 }]));

    for (const name of sources) {
        const srcPath = path.join(PLACES_DIR, name);
        let anyBuilt = false;
        for (const variant of REQUESTED_VARIANTS) {
            try {
                const r = await buildVariant(srcPath, variant);
                if (r.skipped) {
                    skipped++;
                } else {
                    built++;
                    anyBuilt = true;
                    totals[variant].src += r.srcBytes;
                    totals[variant].out += r.dstBytes;
                }
            } catch (err) {
                failed++;
                console.warn(`  failed ${variant} ${name}: ${err.message}`);
            }
        }
        if (anyBuilt && built % 50 === 0) {
            console.log(`  ${built} variants built…`);
        }
    }

    console.log("");
    console.log(`Built:   ${built}`);
    console.log(`Skipped: ${skipped} (already fresh)`);
    console.log(`Failed:  ${failed}`);
    for (const [variant, t] of Object.entries(totals)) {
        if (t.src) {
            const srcMb = (t.src / 1024 / 1024).toFixed(1);
            const outMb = (t.out / 1024 / 1024).toFixed(1);
            const ratio = (100 * (1 - t.out / t.src)).toFixed(1);
            console.log(`  ${variant}: ${srcMb} MB → ${outMb} MB (${ratio}% smaller)`);
        }
    }

    await closePlaywrightContext();
}

main().catch(async (err) => {
    console.error(err);
    await closePlaywrightContext();
    process.exit(1);
});
