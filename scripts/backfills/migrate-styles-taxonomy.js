#!/usr/bin/env node
// One-off: finalise style taxonomy
// - Rename "Contemporary Italian" → "Italian Style" (catch-all bucket)
// - Migrate "Traditional Italian" place assignments to "Italian Style"
// - Delete "Traditional Italian"
// - Insert Pinsa + Pizza Fritta
// - Fix sortOrders across all styles
const { prisma } = require("../lib/bootstrap");

async function main() {
    // Current IDs we know from the DB
    const TRADITIONAL_SLUG = "italian";       // id=2
    const CONTEMPORARY_SLUG = "contemporanea"; // id=9

    const traditional = await prisma.style.findUnique({ where: { slug: TRADITIONAL_SLUG } });
    const contemporary = await prisma.style.findUnique({ where: { slug: CONTEMPORARY_SLUG } });

    if (!traditional) throw new Error(`Style not found: ${TRADITIONAL_SLUG}`);
    if (!contemporary) throw new Error(`Style not found: ${CONTEMPORARY_SLUG}`);

    console.log(`[migrate] Traditional Italian id=${traditional.id}, Contemporary Italian id=${contemporary.id}`);

    // 1. Rename Contemporary → Italian Style
    await prisma.style.update({
        where: { id: contemporary.id },
        data: {
            slug: "italian-style",
            name: "Italian Style",
            shortLabel: "Italian",
        },
    });
    console.log(`[migrate] Renamed contemporary → Italian Style`);

    // 2. Find places that have Traditional but NOT the new Italian Style
    const italianStyleId = contemporary.id;
    const tradAssignments = await prisma.placeStyle.findMany({
        where: { styleId: traditional.id },
        select: { placeId: true },
    });
    const tradPlaceIds = tradAssignments.map(r => r.placeId);
    console.log(`[migrate] ${tradPlaceIds.length} places had Traditional Italian`);

    if (tradPlaceIds.length) {
        // Find which of those already have Italian Style
        const alreadyHave = await prisma.placeStyle.findMany({
            where: { styleId: italianStyleId, placeId: { in: tradPlaceIds } },
            select: { placeId: true },
        });
        const alreadyHaveIds = new Set(alreadyHave.map(r => r.placeId));
        const needsAdd = tradPlaceIds.filter(id => !alreadyHaveIds.has(id));

        if (needsAdd.length) {
            await prisma.placeStyle.createMany({
                data: needsAdd.map(placeId => ({ placeId, styleId: italianStyleId })),
                skipDuplicates: true,
            });
            console.log(`[migrate] Migrated ${needsAdd.length} places to Italian Style`);
        }
    }

    // 3. Delete all PlaceStyle rows for Traditional Italian
    const deleted = await prisma.placeStyle.deleteMany({ where: { styleId: traditional.id } });
    console.log(`[migrate] Removed ${deleted.count} PlaceStyle rows for Traditional Italian`);

    // 4. Also update stylesJson on affected places
    if (tradPlaceIds.length) {
        for (const placeId of tradPlaceIds) {
            const place = await prisma.place.findUnique({
                where: { id: placeId },
                include: { styles: { include: { style: true } } },
            });
            if (!place) continue;
            const slugs = place.styles.map(s => s.style.slug);
            await prisma.place.update({
                where: { id: placeId },
                data: { stylesJson: JSON.stringify(slugs) },
            });
        }
        console.log(`[migrate] Updated stylesJson on ${tradPlaceIds.length} places`);
    }

    // 5. Delete Traditional Italian style
    await prisma.style.delete({ where: { id: traditional.id } });
    console.log(`[migrate] Deleted Traditional Italian style`);

    // 6. Insert Pinsa + Pizza Fritta if not already present
    for (const style of [
        { slug: "pinsa", name: "Pinsa", shortLabel: "Pinsa", sortOrder: 5, isVisible: true },
        { slug: "pizza-fritta", name: "Pizza Fritta", shortLabel: "Fritta", sortOrder: 6, isVisible: true },
    ]) {
        const existing = await prisma.style.findUnique({ where: { slug: style.slug } });
        if (existing) {
            console.log(`[migrate] ${style.name} already exists, skipping`);
        } else {
            await prisma.style.create({ data: style });
            console.log(`[migrate] Created ${style.name}`);
        }
    }

    // 7. Fix sortOrders to match final taxonomy
    const sortMap = {
        "neapolitan":   1,
        "italian-style": 2,
        "romana":        3,
        "al-taglio":     4,
        "pinsa":         5,
        "pizza-fritta":  6,
        "ny":            7,
        "new-haven":     8,
        "detroit":       9,
        "chicago":       10,
        "sicilian":      11,
        "apulian":       12,
        "padellino":     13,
        "focaccia-recco": 14,
    };
    for (const [slug, sortOrder] of Object.entries(sortMap)) {
        const s = await prisma.style.findUnique({ where: { slug } });
        if (s) {
            await prisma.style.update({ where: { slug }, data: { sortOrder } });
        }
    }
    console.log(`[migrate] sortOrders updated`);

    // Final state
    const styles = await prisma.style.findMany({ orderBy: { sortOrder: "asc" }, include: { _count: { select: { places: true } } } });
    console.log("\n[migrate] Final taxonomy:");
    for (const s of styles) {
        console.log(`  ${s.sortOrder}. ${s.name} (${s.slug}) — ${s._count.places} places`);
    }
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
