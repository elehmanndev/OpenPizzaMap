#!/usr/bin/env node
// Track 2 — one-shot migration of existing hero photos into PlaceImage.
//
// Today, ~1,820 places have a localized `/uploads/places/{id}.{ext}`
// heroImageUrl from previous downloads (scrape sources, manual admin
// uploads, the now-deprecated Google Places API path). These photos
// are often curated editorial shots better than Google's default top
// photo. We preserve them by:
//
//   1. Moving the file from /uploads/places/{id}.{ext} into the new
//      per-place subdirectory: /uploads/places/{id}/1.{ext}
//   2. Moving its -thumb / -large variants too
//   3. Inserting a PlaceImage row at position=1 with source='legacy'
//      (sourceRef left null — we don't know the original Google photo
//      ID for these, so the dedup unique constraint on (placeId,
//      sourceRef) accepts these without conflicting with future Google
//      scrapes)
//   4. Updating Place.heroImageUrl to the new path
//
// Idempotent: skips places that already have a PlaceImage row OR
// whose heroImageUrl already points into a subdirectory. Safe to
// re-run after partial completion.
//
// Run AFTER:
//   - `npx prisma migrate deploy` (creates PlaceImage table)
//   - On Hostinger (where the actual files live), not Unraid
//
// Usage:
//   node scripts/backfills/migrate-legacy-heroes.js                # dry-run preview
//   node scripts/backfills/migrate-legacy-heroes.js --apply        # do it
//   node scripts/backfills/migrate-legacy-heroes.js --apply --limit 50  # batch

const fs = require("fs");
const path = require("path");
const { prisma, ROOT } = require("../lib/bootstrap");

const PLACES_DIR = path.join(ROOT, "public", "uploads", "places");

function findExistingHeroFile(placeId, heroPathFromDb) {
    // Try the path stored in DB first.
    if (heroPathFromDb && heroPathFromDb.startsWith("/uploads/places/")) {
        const abs = path.join(ROOT, "public", heroPathFromDb.replace(/^\//, ""));
        if (fs.existsSync(abs)) return abs;
    }
    // Fall back to scanning for {id}.* in the legacy flat layout.
    for (const ext of ["jpg", "jpeg", "png", "webp", "gif", "avif"]) {
        const candidate = path.join(PLACES_DIR, `${placeId}.${ext}`);
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}

function moveFile(src, dst) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
}

async function run({ apply = false, limit = null, disconnect = true } = {}) {
    const candidates = await prisma.place.findMany({
        where: {
            heroImageUrl: { startsWith: "/uploads/places/" },
            // Skip places that already migrated — their heroImageUrl
            // will have a subdir form like /uploads/places/{id}/1.jpg.
            // The flat-layout form is /uploads/places/{id}.{ext}, no
            // intermediate slash.
            images: { none: {} },
        },
        select: {
            id: true, name: true, city: true, heroImageUrl: true,
        },
        orderBy: { id: "asc" },
        take: limit || undefined,
    });

    console.log(`[migrate-legacy] ${candidates.length} candidate places`);

    let moved = 0, skipped = 0, inserted = 0, missing = 0;
    for (const p of candidates) {
        // Reject already-migrated paths (subdirectory form).
        if (/^\/uploads\/places\/\d+\//.test(p.heroImageUrl)) {
            skipped++;
            continue;
        }
        const src = findExistingHeroFile(p.id, p.heroImageUrl);
        if (!src) {
            missing++;
            console.log(`[migrate-legacy] #${p.id} "${p.name}" — file missing for ${p.heroImageUrl}`);
            continue;
        }

        const ext = path.extname(src).slice(1).toLowerCase() || "jpg";
        const dstDir = path.join(PLACES_DIR, String(p.id));
        const dst = path.join(dstDir, `1.${ext}`);
        const newPath = `/uploads/places/${p.id}/1.${ext}`;

        if (!apply) {
            console.log(`[migrate-legacy] DRY #${p.id} "${p.name}": ${src} → ${dst}`);
            moved++;
            continue;
        }

        try {
            // Move original.
            moveFile(src, dst);

            // Move variants too if they exist.
            for (const variant of ["thumb", "large"]) {
                const variantSrc = path.join(PLACES_DIR, `${p.id}-${variant}.jpg`);
                if (fs.existsSync(variantSrc)) {
                    const variantDst = path.join(dstDir, `1-${variant}.jpg`);
                    moveFile(variantSrc, variantDst);
                }
            }

            // Get file size for the PlaceImage row.
            const stat = fs.statSync(dst);

            // Insert PlaceImage row at position 1, source='legacy'.
            await prisma.placeImage.create({
                data: {
                    placeId: p.id,
                    position: 1,
                    localPath: newPath,
                    source: "legacy",
                    sourceRef: null,    // unknown — pre-Google-API era or admin upload
                    sourceUrl: null,
                    bytes: stat.size,
                },
            });
            inserted++;

            // Update Place.heroImageUrl to the new path.
            await prisma.place.update({
                where: { id: p.id },
                data: { heroImageUrl: newPath },
            });
            moved++;

            if (moved % 50 === 0) console.log(`[migrate-legacy] ${moved} migrated…`);
        } catch (err) {
            console.warn(`[migrate-legacy] #${p.id} crashed: ${err.message}`);
        }
    }

    const summary = {
        candidates: candidates.length,
        moved,
        skipped,
        missingOnDisk: missing,
        placeImageRowsInserted: inserted,
        applied: apply,
    };
    console.log("[migrate-legacy] summary:", summary);

    if (disconnect) await prisma.$disconnect();
    return { ok: true, ...summary };
}

module.exports = { run };

if (require.main === module) {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const limit = (() => {
        const i = args.indexOf("--limit");
        if (i === -1) return null;
        const n = parseInt(args[i + 1], 10);
        return Number.isFinite(n) ? n : null;
    })();
    run({ apply, limit, disconnect: true })
        .catch((e) => { console.error(e); process.exit(1); });
}
