#!/usr/bin/env node
// One-off: apply soft-deletes to the 14 high-confidence duplicate pairs
// surfaced by 2026-05-02-dedup-audit.md.
//
// For each pair:
//   1. Decide which row to keep. Default = older createdAt ("vintage").
//      If the newer row has 4+ more non-null user-visible fields than the
//      older row, swap and keep the newer ("richer").
//   2. Migrate Visit and Favorite rows from drop_id → keep_id (preserves
//      user data — visits/favorites are the only place users have
//      "claimed" a place). Skips any (userId, placeId) pair that already
//      exists on keep_id.
//   3. Soft-delete: set isVisible = false on drop_id. Status stays
//      `active` so `prisma db push` won't see it as inconsistent and so
//      we can flip it back if a decision is reversed.
//
// Each pair runs inside a single $transaction so we never end up with
// half-migrated visits and a still-visible drop row.

const { prisma } = require("../lib/bootstrap");

// (keep_id, drop_id) — keep is the older row in every pair (verified
// against the audit table). The script will re-evaluate based on field
// count and warn if it disagrees.
const PAIRS = [
    [171, 1664],   // Pizzeria Giovanni Santarpia / Giovanni Santarpia (Florence)
    [180, 1620],   // Pizzeria Starita a Materdei / Starita a Materdei (Naples)
    [285, 1684],   // Pizzeria Da Attilio / Da Attilio (Naples)
    [324, 1622],   // Vesi / Pizzeria Vesi (Naples)
    [272, 1683],   // Pizzeria Guglielmo & Enrico Vuolo Verona / Guglielmo & Enrico Vuolo Verona (Verona)
    [300, 1433],   // Antica Pizzeria Ciro 1923 / Antica Pizzeria Ciro 1923 (Gaeta)
    [323, 1413],   // Enosteria Lipen / Enosteria Lipen (Canonica Lambro / Triuggio)
    [1322, 1379],  // Napoli on the Road / Napoli on the Road (London)
    [1323, 1382],  // L'Antica Pizzeria / L'Antica Pizzeria (London)
    [1333, 1726],  // Vicoli di Napoli Pizzeria / Vicoli di Napoli (London)
    [462, 1479],   // Forno D'Oro / Forno d'Oro (Lisbon)
    [215, 1053],   // Lou Malnati's Pizzeria / Lou Malnati's (Chicago / IL 60610)
    [221, 1060],   // Louisa's Pizza & Pasta x2 (Crestwood / IL 60445)
    [541, 699],    // Tarumbò x2 (Sant'Arpino / Cardito)
];

// Fields users care about when deciding which row is "richer". Skip
// timestamps, slugs, and admin flags.
const RICHNESS_FIELDS = [
    "addressLine", "region", "postalCode", "phone", "websiteUrl",
    "googleMapsUrl", "instagramUrl", "openingHours", "tripadvisorLocationId",
    "tripadvisorRanking", "tripadvisorRating", "tripadvisorReviewCount",
    "tripadvisorUrl", "googleRating", "googleReviewCount", "googleUrl",
    "yelpRating", "yelpReviewCount", "yelpUrl", "opmRating",
    "descriptionHtml", "heroImageUrl", "seoTitle", "seoDescription",
];

function richness(row) {
    let n = 0;
    for (const f of RICHNESS_FIELDS) {
        const v = row[f];
        if (v == null) continue;
        if (typeof v === "string" && v.trim() === "") continue;
        n++;
    }
    return n;
}

async function migrateUserLink(tx, table, dropId, keepId) {
    // Pull all rows on the drop side.
    const rows = await tx[table].findMany({ where: { placeId: dropId } });
    if (!rows.length) return { migrated: 0, skipped: 0, deleted: 0 };

    // For each, see if (userId, placeId=keepId) already exists. If yes,
    // delete the drop row (the user already claims keep). If no, repoint.
    let migrated = 0, skipped = 0, deleted = 0;
    for (const row of rows) {
        const collision = await tx[table].findUnique({
            where: { userId_placeId: { userId: row.userId, placeId: keepId } },
        });
        if (collision) {
            await tx[table].delete({ where: { id: row.id } });
            skipped++;
            deleted++;
        } else {
            await tx[table].update({ where: { id: row.id }, data: { placeId: keepId } });
            migrated++;
        }
    }
    return { migrated, skipped, deleted };
}

async function main() {
    const apply = process.argv.includes("--apply");
    if (!apply) {
        console.log("[dry-run] pass --apply to commit changes\n");
    }

    const report = [];

    for (const [hintKeep, hintDrop] of PAIRS) {
        const a = await prisma.place.findUnique({ where: { id: hintKeep } });
        const b = await prisma.place.findUnique({ where: { id: hintDrop } });
        if (!a || !b) {
            console.warn(`[skip] missing row keep=${hintKeep} drop=${hintDrop}`);
            continue;
        }

        const ra = richness(a), rb = richness(b);
        // Default keep = a (the older row in PAIRS). Swap only if b is
        // significantly richer (4+ more non-null fields per Eric's call).
        let keep = a, drop = b, reason = "older";
        if (rb - ra >= 4) {
            keep = b; drop = a; reason = "richer";
        }

        const apply1Pair = async (tx) => {
            const visits = await migrateUserLink(tx, "visit", drop.id, keep.id);
            const favs = await migrateUserLink(tx, "favorite", drop.id, keep.id);
            await tx.place.update({ where: { id: drop.id }, data: { isVisible: false } });
            return { visits, favs };
        };

        if (apply) {
            const out = await prisma.$transaction(apply1Pair);
            report.push({
                keep: keep.id, keepName: keep.name,
                drop: drop.id, dropName: drop.name,
                reason, ra, rb,
                visits_migrated: out.visits.migrated,
                visits_dedup_deleted: out.visits.deleted,
                favs_migrated: out.favs.migrated,
                favs_dedup_deleted: out.favs.deleted,
            });
        } else {
            // Dry-run: count what we would migrate without touching DB.
            const v = await prisma.visit.count({ where: { placeId: drop.id } });
            const f = await prisma.favorite.count({ where: { placeId: drop.id } });
            report.push({
                keep: keep.id, keepName: keep.name,
                drop: drop.id, dropName: drop.name,
                reason, ra, rb,
                visits_to_migrate: v, favs_to_migrate: f,
            });
        }
    }

    console.log("\n| keep_id | drop_id | reason | richness (keep / drop) | visits | favs |");
    console.log("|---:|---:|---|---|---:|---:|");
    for (const r of report) {
        const v = r.visits_migrated != null ? `${r.visits_migrated}+${r.visits_dedup_deleted}d` : `${r.visits_to_migrate}*`;
        const f = r.favs_migrated != null ? `${r.favs_migrated}+${r.favs_dedup_deleted}d` : `${r.favs_to_migrate}*`;
        console.log(`| ${r.keep} | ${r.drop} | ${r.reason} | ${r.ra} / ${r.rb} | ${v} | ${f} |`);
    }

    if (!apply) console.log("\n(dry-run: visit/fav counts marked with * — re-run with --apply to commit)");
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(async () => { await prisma.$disconnect(); });
