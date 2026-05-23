#!/usr/bin/env node
// Track 2 — galleryDownload phase. Runs on Hostinger (Passenger worker).
//
// Receives a "jobs" payload from the Unraid opm-runner's galleryScrape
// phase. Each job has a placeId + a list of lh3 photo URLs. For each
// photo: download bytes, write to public/uploads/places/{placeId}/{N}.{ext},
// build -thumb / -large variants, insert a PlaceImage row, update
// Place.galleryLastScrapedAt + Place.heroImageUrl (if it was null).
//
// CRITICAL: must run within minutes of galleryScrape — the signed lh3
// URLs expire fast. The dispatch from opm-runner → Hostinger is HTTP
// POST so the gap is seconds, not minutes.
//
// Idempotent: the PlaceImage @@unique([placeId, sourceRef]) constraint
// makes re-downloads a no-op. If admin marked a photo isHidden, the
// re-scrape won't unhide it (sourceRef matches → upsert preserves
// isHidden=true).
//
// Payload shape (sent from Unraid):
//   {
//     jobs: [
//       {
//         placeId: 1989,
//         name: "Batticuore",
//         city: "Reus",
//         photos: [
//           { sourceUrl: "https://lh3.googleusercontent.com/...", sourceRef: "AJRVUZ..." },
//           ...
//         ]
//       },
//       ...
//     ]
//   }

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { prisma, ROOT } = require("../lib/bootstrap");

const PLACES_DIR = path.join(ROOT, "public", "uploads", "places");
const UA = "OpenPizzaMap/0.1 (eric@openpizzamap.com)";

function extFromContentType(ct) {
    if (!ct) return null;
    const t = ct.split(";")[0].trim().toLowerCase();
    return ({
        "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "image/avif": "avif",
    })[t] || null;
}

async function downloadOne(url, outPath) {
    const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "image/*" }, redirect: "follow" });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const ct = res.headers.get("content-type");
    let ext = extFromContentType(ct) || "jpg";
    if (!/^(jpg|jpeg|png|webp|gif|avif)$/.test(ext)) ext = "jpg";
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = `${outPath}.${ext}`;
    fs.writeFileSync(dest, buf);
    // Build -thumb + -large via existing variant pipeline.
    const variantResult = spawnSync(process.execPath, [
        path.join(ROOT, "scripts", "deploy", "build-thumbs.js"),
        "--file", dest,
    ], { encoding: "utf8" });
    if (variantResult.status !== 0) {
        console.warn(`  variants failed for ${dest}: ${variantResult.stderr || variantResult.stdout}`);
    }
    return { path: dest, ext, bytes: buf.length };
}

async function processJob(job) {
    const placeDir = path.join(PLACES_DIR, String(job.placeId));
    fs.mkdirSync(placeDir, { recursive: true });

    const inserted = [];
    const skipped = [];
    const failed = [];

    let position = 1;
    for (const photo of job.photos.slice(0, 10)) {
        // Skip if this exact photo (by sourceRef) is already in the gallery
        // OR was explicitly hidden by an admin (preserve hide-forever intent).
        const existing = await prisma.placeImage.findUnique({
            where: { placeId_sourceRef: { placeId: job.placeId, sourceRef: photo.sourceRef } },
        }).catch(() => null);
        if (existing) {
            skipped.push({ position: existing.position, sourceRef: photo.sourceRef, reason: existing.isHidden ? "hidden" : "exists" });
            position = Math.max(position, existing.position + 1);
            continue;
        }

        try {
            const outBase = path.join(placeDir, String(position));
            const r = await downloadOne(photo.sourceUrl, outBase);
            const localPath = `/uploads/places/${job.placeId}/${position}.${r.ext}`;
            await prisma.placeImage.create({
                data: {
                    placeId: job.placeId,
                    position,
                    localPath,
                    source: "google",
                    sourceRef: photo.sourceRef,
                    sourceUrl: photo.sourceUrl,
                    bytes: r.bytes,
                },
            });
            inserted.push({ position, localPath });
            position++;
        } catch (err) {
            failed.push({ position, sourceRef: photo.sourceRef, error: err.message });
        }
    }

    // Update Place: mark scraped, default hero to position 1 if it was null
    const updates = { galleryLastScrapedAt: new Date() };
    if (inserted.length > 0) {
        // Only overwrite heroImageUrl if it's currently empty or pointing
        // at a path that doesn't exist on disk (covers the "DB says
        // /uploads/places/{id}.jpg but file missing" case from the
        // 2026-05-23 Track 1 regression).
        const place = await prisma.place.findUnique({
            where: { id: job.placeId },
            select: { heroImageUrl: true },
        });
        const heroMissing = !place?.heroImageUrl
            || !fs.existsSync(path.join(ROOT, "public", place.heroImageUrl.replace(/^\//, "")));
        if (heroMissing) {
            updates.heroImageUrl = inserted[0].localPath;
        }
    }
    await prisma.place.update({
        where: { id: job.placeId },
        data: updates,
    });

    return { placeId: job.placeId, inserted: inserted.length, skipped: skipped.length, failed: failed.length };
}

async function run({ jobs, disconnect = false } = {}) {
    if (!Array.isArray(jobs) || jobs.length === 0) {
        return { ok: true, processed: 0, results: [] };
    }
    fs.mkdirSync(PLACES_DIR, { recursive: true });

    const results = [];
    let totalInserted = 0, totalSkipped = 0, totalFailed = 0;
    for (const job of jobs) {
        try {
            const r = await processJob(job);
            results.push(r);
            totalInserted += r.inserted;
            totalSkipped += r.skipped;
            totalFailed += r.failed;
        } catch (err) {
            console.warn(`[galleryDownload] job ${job.placeId} crashed: ${err.message}`);
            results.push({ placeId: job.placeId, error: err.message });
        }
    }
    if (disconnect) await prisma.$disconnect();
    return {
        ok: true,
        processed: jobs.length,
        inserted: totalInserted,
        skipped: totalSkipped,
        failed: totalFailed,
        results,
    };
}

module.exports = { run };
