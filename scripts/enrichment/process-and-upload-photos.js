#!/usr/bin/env node
// Photo-pipeline v2 — runs on opm-runner (Unraid, residential IP).
//
// Replaces the v1 path where opm-runner sent photo URLs to Hostinger
// and Hostinger did the download + sharp + write. That topology pegged
// Hostinger's 120-process cap on every tick (libvips spawning threads,
// Passenger scaling up workers under apparent load).
//
// New flow per photo URL:
//   1. fetch() the URL → bytes Buffer
//   2. sharp().metadata() → width/height/format. Cheap, no resize yet.
//   3. Filter: reject if < 600px on long edge OR aspect > 3:1.
//   4. sharp() to produce -large (1200px, jpeg q82) and -thumb (400px).
//   5. POST multipart to /api/admin/upload-place-photo with all 3 files.
//   6. Sleep ~1-2s between photos to keep Hostinger flat.
//
// Caller passes `jobs` — same shape as scrape-gallery.js#run() returns:
//   jobs[].placeId, jobs[].slug, jobs[].photos[].sourceUrl, jobs[].photos[].sourceRef
//
// Each photo in jobs[].photos is assumed already deduped by sourceRef.
// We DO NOT re-call scrape-gallery — the URLs are already in hand,
// and lh3 URLs expire in minutes so we process them immediately.

const sharp = require("sharp");
const path = require("path");
const { execSync } = require("child_process");

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
const SPACING_MS = parseInt(process.env.PIPELINE_SPACING_MS, 10) || 1500;
const MIN_LONG_EDGE = 600;
const MAX_ASPECT = 3.0;

// Sharp output sizes — match what build-thumbs.js produces for legacy
// heroes so the URL pattern <position>-large.jpg / <position>-thumb.jpg
// is consistent across sources.
const LARGE_EDGE = 1200;
const THUMB_EDGE = 400;
const JPEG_QUALITY = 82;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchPhoto(url) {
    // Some lh3 URLs return 200 with a tiny "image expired" placeholder
    // instead of a 404. Catch by content-length sanity (< 2KB = almost
    // certainly a placeholder, real photos are tens to hundreds of KB).
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 2048) throw new Error(`tiny payload (${buf.length}B) — likely expired`);
    return buf;
}

async function processOne({ placeId, source, sourceUrl, sourceRef, position }) {
    let original;
    try {
        original = await fetchPhoto(sourceUrl);
    } catch (err) {
        return { ok: false, reason: `fetch: ${err.message}`, sourceRef };
    }

    let meta;
    try {
        meta = await sharp(original).metadata();
    } catch (err) {
        return { ok: false, reason: `sharp metadata: ${err.message}`, sourceRef };
    }

    const longEdge = Math.max(meta.width || 0, meta.height || 0);
    const shortEdge = Math.min(meta.width || 0, meta.height || 0);
    if (longEdge < MIN_LONG_EDGE) {
        return { ok: false, reason: `too small (${meta.width}x${meta.height})`, sourceRef };
    }
    if (shortEdge && (longEdge / shortEdge) > MAX_ASPECT) {
        return { ok: false, reason: `bad aspect (${longEdge}/${shortEdge}=${(longEdge/shortEdge).toFixed(2)})`, sourceRef };
    }

    // Produce variants. .rotate() respects EXIF orientation; .jpeg()
    // normalises both variants to a single format so the URL handler
    // doesn't have to fan out by extension.
    let large, thumb;
    try {
        large = await sharp(original)
            .rotate()
            .resize({ width: LARGE_EDGE, height: LARGE_EDGE, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
        thumb = await sharp(original)
            .rotate()
            .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: JPEG_QUALITY })
            .toBuffer();
    } catch (err) {
        return { ok: false, reason: `sharp resize: ${err.message}`, sourceRef };
    }

    // POST multipart. Node's native FormData (Node 18+) handles this.
    const fd = new FormData();
    fd.set("placeId", String(placeId));
    fd.set("position", String(position));
    fd.set("source", source);
    if (sourceRef) fd.set("sourceRef", sourceRef);
    if (sourceUrl) fd.set("sourceUrl", sourceUrl);
    fd.set("width", String(meta.width));
    fd.set("height", String(meta.height));

    const ext = (meta.format === "jpeg") ? "jpg" : (meta.format || "jpg");
    const origMime = meta.format === "jpeg" ? "image/jpeg" : `image/${meta.format || "jpeg"}`;
    fd.set("original", new Blob([original], { type: origMime }), `original.${ext}`);
    fd.set("large", new Blob([large], { type: "image/jpeg" }), "large.jpg");
    fd.set("thumb", new Blob([thumb], { type: "image/jpeg" }), "thumb.jpg");

    const r = await fetch(`${HOSTINGER_URL}/api/admin/upload-place-photo`, {
        method: "POST",
        headers: { "x-api-key": ADMIN_API_KEY },
        body: fd,
    });
    const body = await r.text().catch(() => "");
    if (r.status === 201) {
        const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
        return { ok: true, idempotent: false, placeImageId: parsed.placeImageId, sourceRef };
    }
    if (r.status === 409) {
        const parsed = (() => { try { return JSON.parse(body); } catch { return {}; } })();
        return { ok: true, idempotent: true, placeImageId: parsed.placeImageId, sourceRef };
    }
    return { ok: false, reason: `upload HTTP ${r.status}: ${body.slice(0,200)}`, sourceRef };
}

// Push one place's batch of photos through the pipeline. Position
// numbering starts at `startPosition` so callers can offset (e.g. TA
// photos start after Google's last position).
async function processPlace({ placeId, slug, source = "google", photos, startPosition = 1 }) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        return { ok: false, reason: "HOSTINGER_URL or ADMIN_API_KEY not set" };
    }
    if (!Array.isArray(photos) || photos.length === 0) {
        return { ok: true, results: [], reason: "no photos" };
    }

    const results = [];
    let position = startPosition;
    for (const p of photos) {
        const result = await processOne({
            placeId,
            source,
            sourceUrl: p.sourceUrl,
            sourceRef: p.sourceRef,
            position,
        });
        results.push(result);
        if (result.ok) position++;        // only advance position on success
        await sleep(SPACING_MS);
    }

    const ok = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    return { ok: true, placeId, slug, source, uploaded: ok, failed, results };
}

// Stamp galleryLastScrapedAt=now() so the queue picker moves on.
// Called after processPlace() completes a place's photo batch.
async function stampGalleryScraped(placeId) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) return { ok: false };
    try {
        const r = await fetch(`${HOSTINGER_URL}/api/admin/place/${placeId}/gallery-scraped`, {
            method: "POST",
            headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
            body: "{}",
        });
        return { ok: r.ok, status: r.status };
    } catch (err) {
        return { ok: false, error: err.message };
    }
}

// Fetch MAX(position) for a place so callers (TA scrape, future
// sources) can start their position numbering AFTER any existing
// rows — keeps Google's photos in 1..10 and TA's in 11..15, etc.
// Uses opm-runner's direct DB connection (same Prisma client as
// scrape-gallery), no Hostinger round-trip needed.
async function maxPosition(prisma, placeId) {
    const r = await prisma.placeImage.aggregate({
        where: { placeId },
        _max: { position: true },
    });
    return r._max.position || 0;
}

module.exports = { processOne, processPlace, stampGalleryScraped, maxPosition };
