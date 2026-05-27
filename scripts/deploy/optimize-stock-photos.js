#!/usr/bin/env node

// optimize-stock-photos.js
//
// Resize + recompress every JPEG/PNG under public/img/stock/{hero,cities,styles}
// to 1200x1200 square (cover-crop, center), JPEG q82 with mozjpeg, EXIF
// stripped. Drives the public homepage's stock photo pool — Adobe Stock
// originals can be 6000x4000 multi-MB shots; after this they land around
// 150–250 KB each.
//
// Behavior:
//   - Idempotent: files already at 1200x1200 with no EXIF are skipped
//   - One-time backup: originals copied to public/img/stock/.raw-backup/
//     before first run (delete the backup folder once you're happy)
//   - Output is always .jpg (lowercase); .jpeg / .png inputs get renamed
//   - Subfolder filter: `node optimize-stock-photos.js hero` only does hero/
//
// Run: npm run optimize:stock   (added to package.json scripts)

const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..", "..");
const STOCK_ROOT = path.join(ROOT, "public", "img", "stock");
const BACKUP_ROOT = path.join(STOCK_ROOT, ".raw-backup");
const SUBFOLDERS = ["hero", "cities", "styles"];
const TARGET_SIZE = 1200;
const JPEG_QUALITY = 82;

// CLI filter: optional positional arg restricts to one subfolder.
const onlySub = process.argv[2];
const subs = onlySub ? [onlySub] : SUBFOLDERS;
if (onlySub && !SUBFOLDERS.includes(onlySub)) {
  console.error(`Unknown subfolder "${onlySub}". Use one of: ${SUBFOLDERS.join(", ")}`);
  process.exit(1);
}

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / (1024 * 1024)).toFixed(2) + " MB";
}

async function processFile(src, dst) {
  const meta = await sharp(src).metadata();
  const alreadySquare1200 =
    meta.width === TARGET_SIZE && meta.height === TARGET_SIZE;
  const hasExif = !!meta.exif;

  // Idempotent skip: file is already the target dimensions and has no EXIF
  // payload to strip. We still rename .jpeg→.jpg if extensions differ.
  if (alreadySquare1200 && !hasExif && src === dst) {
    return { status: "skipped", srcBytes: 0, dstBytes: 0 };
  }

  const srcBytes = fs.statSync(src).size;

  // Write to a temp file first so an interrupted run can't corrupt the
  // original. Then atomic rename into place and delete the source if it
  // had a different name (e.g. .jpeg → .jpg).
  const tmp = dst + ".tmp";
  await sharp(src)
    .rotate() // honor EXIF orientation BEFORE stripping it
    .resize(TARGET_SIZE, TARGET_SIZE, { fit: "cover", position: "center" })
    .jpeg({ quality: JPEG_QUALITY, mozjpeg: true, progressive: true })
    .withMetadata({ orientation: undefined }) // strip everything else
    .toFile(tmp);

  fs.renameSync(tmp, dst);
  if (src !== dst && fs.existsSync(src)) fs.unlinkSync(src);

  const dstBytes = fs.statSync(dst).size;
  return { status: "optimized", srcBytes, dstBytes };
}

function gatherInputs(folder) {
  const dir = path.join(STOCK_ROOT, folder);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function backupOriginalsOnce() {
  if (fs.existsSync(BACKUP_ROOT)) return false;
  fs.mkdirSync(BACKUP_ROOT, { recursive: true });
  for (const sub of SUBFOLDERS) {
    const srcDir = path.join(STOCK_ROOT, sub);
    if (!fs.existsSync(srcDir)) continue;
    const dstDir = path.join(BACKUP_ROOT, sub);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      if (!/\.(jpe?g|png)$/i.test(name)) continue;
      fs.copyFileSync(path.join(srcDir, name), path.join(dstDir, name));
    }
  }
  return true;
}

async function main() {
  console.log(`[optimize-stock] root: ${STOCK_ROOT}`);
  console.log(`[optimize-stock] target: ${TARGET_SIZE}x${TARGET_SIZE} JPEG q${JPEG_QUALITY}`);

  const didBackup = await backupOriginalsOnce();
  if (didBackup) {
    console.log(`[optimize-stock] backup created at .raw-backup/ (delete after verifying)`);
  } else {
    console.log(`[optimize-stock] .raw-backup/ already present (skipped)`);
  }

  let totals = { processed: 0, skipped: 0, srcBytes: 0, dstBytes: 0 };

  for (const sub of subs) {
    const files = gatherInputs(sub);
    if (files.length === 0) {
      console.log(`\n[${sub}] no files`);
      continue;
    }
    console.log(`\n[${sub}] ${files.length} file(s)`);
    for (const src of files) {
      const ext = path.extname(src).toLowerCase();
      const dst = ext === ".jpg" ? src : src.replace(/\.(jpe?g|png)$/i, ".jpg");
      try {
        const r = await processFile(src, dst);
        if (r.status === "skipped") {
          console.log(`  · ${path.basename(src)} — already optimized`);
          totals.skipped += 1;
        } else {
          const pct = r.srcBytes > 0 ? Math.round(100 * (1 - r.dstBytes / r.srcBytes)) : 0;
          console.log(`  ✓ ${path.basename(dst)} — ${fmtBytes(r.srcBytes)} → ${fmtBytes(r.dstBytes)} (−${pct}%)`);
          totals.processed += 1;
          totals.srcBytes += r.srcBytes;
          totals.dstBytes += r.dstBytes;
        }
      } catch (err) {
        console.error(`  ✗ ${path.basename(src)} — ${err.message}`);
      }
    }
  }

  console.log("");
  console.log(`[optimize-stock] processed=${totals.processed} skipped=${totals.skipped}`);
  if (totals.processed > 0) {
    const pct = Math.round(100 * (1 - totals.dstBytes / totals.srcBytes));
    console.log(`[optimize-stock] total: ${fmtBytes(totals.srcBytes)} → ${fmtBytes(totals.dstBytes)} (−${pct}%)`);
  }
}

main().catch((err) => {
  console.error("[optimize-stock] fatal:", err);
  process.exit(1);
});
