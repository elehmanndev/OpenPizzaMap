#!/usr/bin/env node
// One-shot burn through Google Place Photos API. Per place:
//   - 1 Place Details call with `photos` field → up to 10 photo refs
//   - up to 5 Place Photo calls → photoUri (lh3.* URL, ~minutes TTL)
//   - download bytes IMMEDIATELY (lh3 expires fast)
//   - write to <persistent>/uploads/places/<id>/<n>.<ext>
//   - insert PlaceImage row (source='google', sourceRef = photo ref name)
//   - generate -thumb / -large variants via the existing build-thumbs pipeline
//
// Cost per place (Places API New pricing):
//   1 Details Atmosphere field (photos)  = $0.005
//   5 Place Photos                       = $0.035
//   ────────────────────────────────────────────
//   total                                = ~$0.040
//
// Idempotent: skips photo refs already in DB by (placeId, sourceRef).
// Re-running just tops up missing positions.
//
// Importable: exports `run({ limit, apply, gapsOnly })` so the route
// handler in src/routes/api.admin.js can drive it from a live Hostinger
// worker (avoids the bare-CLI Prisma "tokio panic" hit).

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { prisma, ROOT } = require("../lib/bootstrap");
const { GoogleApiProvider } = require("../../src/services/enrichment/providers");
const { getPlacesUploadDir } = require("../lib/uploads-dir");

const PLACES_DIR = getPlacesUploadDir({ repoRoot: ROOT });
const PHOTOS_PER_PLACE = 5;
const PHOTO_WIDTH = 1200;
const COST_DETAILS = 0.005;
const COST_PHOTO = 0.007;
const PACE_MS = 80;

function extFromContentType(ct) {
    if (!ct) return "jpg";
    const t = ct.split(";")[0].trim().toLowerCase();
    return ({
        "image/jpeg": "jpg", "image/jpg": "jpg",
        "image/png": "png", "image/webp": "webp",
        "image/gif": "gif", "image/avif": "avif",
    })[t] || "jpg";
}

async function downloadOne(url, outBase) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ct = res.headers.get("content-type") || "";
    let ext = extFromContentType(ct);
    if (!/^(jpg|jpeg|png|webp|gif|avif)$/.test(ext)) ext = "jpg";
    const buf = Buffer.from(await res.arrayBuffer());
    const dest = `${outBase}.${ext}`;
    fs.writeFileSync(dest, buf);
    // Build -thumb + -large via the existing variant pipeline.
    spawnSync(process.execPath, [
        path.join(ROOT, "scripts", "deploy", "build-thumbs.js"),
        "--file", dest,
    ], { stdio: "ignore" });
    return { dest, ext, bytes: buf.length };
}

async function processPlace(provider, place) {
    const stats = { details: 0, photos: 0, inserted: 0, skipped: 0, errors: 0 };

    // 1. Place Details — photos field only ($0.005 Atmosphere SKU).
    const detailJson = await provider._get(
        `https://places.googleapis.com/v1/places/${place.googlePlaceId}?fields=photos&key=${provider.apiKey}`
    );
    stats.details = 1;
    const refs = (detailJson.photos || []).slice(0, PHOTOS_PER_PLACE);
    if (!refs.length) return stats;

    const placeDir = path.join(PLACES_DIR, String(place.id));
    fs.mkdirSync(placeDir, { recursive: true });

    // Start position AFTER any existing image rows so we don't collide
    // with the legacy hero at position 1, etc.
    const maxRow = await prisma.placeImage.aggregate({
        where: { placeId: place.id },
        _max: { position: true },
    }).catch(() => ({ _max: { position: null } }));
    let position = (maxRow?._max?.position || 0) + 1;

    for (const ref of refs) {
        const sourceRef = ref.name; // "places/ABC/photos/XYZ"

        // Dedup by sourceRef (also picks up admin "hide forever" rows).
        const existing = await prisma.placeImage.findUnique({
            where: { placeId_sourceRef: { placeId: place.id, sourceRef } },
        }).catch(() => null);
        if (existing) { stats.skipped++; continue; }

        // 2. Place Photo — returns lh3 photoUri with skipHttpRedirect ($0.007).
        let photoUri = null;
        try {
            const j = await provider._get(
                `https://places.googleapis.com/v1/${ref.name}/media?maxWidthPx=${PHOTO_WIDTH}&skipHttpRedirect=true`
            );
            stats.photos++;
            photoUri = j.photoUri || null;
        } catch (err) {
            stats.errors++;
            continue;
        }
        if (!photoUri) { stats.errors++; continue; }

        // 3. Download bytes immediately. lh3 URLs expire in minutes.
        try {
            const outBase = path.join(placeDir, String(position));
            const r = await downloadOne(photoUri, outBase);
            const slug = place.slug || "";
            const localPath = slug
                ? `/uploads/places/${place.id}/${slug}/${position}.${r.ext}`
                : `/uploads/places/${place.id}/${position}.${r.ext}`;
            await prisma.placeImage.create({
                data: {
                    placeId: place.id,
                    position,
                    localPath,
                    source: "google",
                    sourceRef,
                    sourceUrl: photoUri,
                    bytes: r.bytes,
                },
            });
            // Set heroImageUrl to the first photo when the place is hero-less.
            if (stats.inserted === 0 && !place.heroImageUrl) {
                await prisma.place.update({
                    where: { id: place.id },
                    data: { heroImageUrl: localPath },
                }).catch(() => {});
            }
            stats.inserted++;
            position++;
        } catch (err) {
            stats.errors++;
        }
    }

    return stats;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run({ limit = 50, apply = false, gapsOnly = true, ids = null } = {}) {
    if (!process.env.GOOGLE_MAPS_API_KEY) {
        return { ok: false, error: "GOOGLE_MAPS_API_KEY not set" };
    }

    // Candidate pool: visible places with a googlePlaceId.
    let where = { isVisible: true, googlePlaceId: { not: null } };
    if (ids && ids.length) where = { id: { in: ids }, googlePlaceId: { not: null } };

    const all = await prisma.place.findMany({
        where,
        select: { id: true, slug: true, name: true, googlePlaceId: true, heroImageUrl: true },
        orderBy: { id: "asc" },
    });

    // gapsOnly: drop places that already have ≥PHOTOS_PER_PLACE google-source rows.
    let candidates = all;
    if (gapsOnly) {
        const counts = await prisma.placeImage.groupBy({
            by: ["placeId"],
            where: { source: "google" },
            _count: { _all: true },
        });
        const byId = new Map(counts.map((c) => [c.placeId, c._count._all]));
        candidates = all.filter((p) => (byId.get(p.id) || 0) < PHOTOS_PER_PLACE);
    }

    const batch = candidates.slice(0, limit);
    if (!apply) {
        const estCost = batch.length * (COST_DETAILS + PHOTOS_PER_PLACE * COST_PHOTO);
        return {
            ok: true,
            mode: "dry-run",
            totalCandidates: candidates.length,
            batchSize: batch.length,
            estCost: Number(estCost.toFixed(2)),
        };
    }

    const provider = new GoogleApiProvider({ prisma, apiKey: process.env.GOOGLE_MAPS_API_KEY });
    const totals = { processed: 0, details: 0, photos: 0, inserted: 0, skipped: 0, errors: 0 };
    const start = Date.now();

    for (const place of batch) {
        try {
            const s = await processPlace(provider, place);
            totals.processed++;
            totals.details += s.details;
            totals.photos += s.photos;
            totals.inserted += s.inserted;
            totals.skipped += s.skipped;
            totals.errors += s.errors;
        } catch (err) {
            totals.errors++;
            console.warn(`[burn-photos] place ${place.id} crashed: ${err.message}`);
        }
        await sleep(PACE_MS);
    }

    const estCost = totals.details * COST_DETAILS + totals.photos * COST_PHOTO;
    const remaining = candidates.length - batch.length;

    return {
        ok: true,
        mode: "apply",
        durationMs: Date.now() - start,
        ...totals,
        estCostUsd: Number(estCost.toFixed(3)),
        remainingCandidates: remaining,
    };
}

module.exports = { run };

// CLI mode (won't work on Hostinger per tokio panic — use the API route there).
if (require.main === module) {
    const argv = process.argv.slice(2);
    const apply = argv.includes("--apply");
    const limitIdx = argv.indexOf("--limit");
    const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : 50;
    const gapsOnly = !argv.includes("--all");
    run({ limit, apply, gapsOnly }).then((r) => {
        console.log(JSON.stringify(r, null, 2));
        return prisma.$disconnect();
    }).catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
