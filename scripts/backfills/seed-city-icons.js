// Seed City.iconSlug for the stamp-icon system.
//
// Idempotent — re-runs are safe. Writes the iconSlug column only.
//
// Run paths:
//   npm run seed:city-icons          (local / Unraid runner — Prisma fine)
//   POST /api/admin/maintenance      (Hostinger — bypasses the prisma-CLI
//                                    panic per memory
//                                    `feedback_hostinger_prisma_cli_panic`)
//
// Mismatched rows (city slug in mapping but no DB row) are logged and skipped.
// Never inserts new City rows — adding cities goes through /admin/cities.
//
// Two iconSlug formats render-time:
//   "svg:<basename>"     → /public/img/stamps/<basename>.svg (CSS mask in me.ejs)
//   "mingcute:<name>"    → MIT-licensed Iconify slug, web component resolves it

const { prisma } = require("../lib/bootstrap");

// Mapping lives inline here (not in scripts/data/ — that path is gitignored
// by the catch-all `data/` rule). If this grows, move to a sibling
// `city-icons-data.js` in this folder and require it back in.
const mapping = [
    // ── Italy · landmark-specific (traced from PNGs) ─────────────
    { country: "IT", slug: "roma",     iconSlug: "svg:colosseum" },
    { country: "IT", slug: "milano",   iconSlug: "svg:duomo-di-milano" },
    { country: "IT", slug: "firenze",  iconSlug: "svg:florence" },
    { country: "IT", slug: "pisa",     iconSlug: "svg:pisa" },
    { country: "IT", slug: "venezia",  iconSlug: "svg:gondola" },
    { country: "IT", slug: "torino",   iconSlug: "svg:mole-antonelliana" },
    { country: "IT", slug: "napoli",   iconSlug: "svg:volcano" },
    { country: "IT", slug: "pompei",   iconSlug: "svg:temple" },

    // ── Italy · MingCute fallback ────────────────────────────────
    { country: "IT", slug: "bologna",  iconSlug: "mingcute:tower-2-line" },
    { country: "IT", slug: "caserta",  iconSlug: "mingcute:palace-line" },
    { country: "IT", slug: "catania",  iconSlug: "svg:volcano" },              // shares Vesuvius/Etna
    { country: "IT", slug: "genova",   iconSlug: "hugeicons:lighthouse" },
    { country: "IT", slug: "palermo",  iconSlug: "mingcute:church-line" },
    { country: "IT", slug: "sorrento", iconSlug: "mingcute:wave-line" },
    { country: "IT", slug: "salerno",  iconSlug: "mingcute:wave-line" },
    { country: "IT", slug: "bari",     iconSlug: "mingcute:wave-line" },
    { country: "IT", slug: "verona",   iconSlug: "mingcute:tower-line" },
    { country: "IT", slug: "caiazzo",  iconSlug: "mingcute:tree-line" },

    // ── Spain · landmark-specific (traced from PNGs) ─────────────
    { country: "ES", slug: "barcelona", iconSlug: "svg:sagrada-familia" },
    { country: "ES", slug: "madrid",    iconSlug: "svg:royal-palace" },
    { country: "ES", slug: "sevilla",   iconSlug: "svg:giralda" },
    { country: "ES", slug: "granada",   iconSlug: "svg:alhambra-granada" },
    { country: "ES", slug: "segovia",   iconSlug: "svg:aqueduct" },

    // ── Spain · MingCute fallback ────────────────────────────────
    { country: "ES", slug: "valencia",  iconSlug: "mingcute:wave-line" },
    { country: "ES", slug: "cordoba",   iconSlug: "mingcute:church-line" },
    { country: "ES", slug: "malaga",    iconSlug: "mingcute:wave-line" },
    { country: "ES", slug: "bilbao",    iconSlug: "mingcute:building-3-line" },
    { country: "ES", slug: "toledo",    iconSlug: "tabler:building-fortress" },

    // ── Wildcards (traced from PNGs) ─────────────────────────────
    { country: "FR", slug: "paris",    iconSlug: "svg:eiffel-tower" },
    { country: "GB", slug: "london",   iconSlug: "svg:big-ben" },
    { country: "DE", slug: "berlin",   iconSlug: "svg:brandenburg-gate" },
    { country: "PT", slug: "lisboa",   iconSlug: "svg:belem-tower" },
    { country: "GR", slug: "athina",   iconSlug: "svg:parthenon" },
    { country: "US", slug: "new-york", iconSlug: "svg:statue-of-liberty" },
];

async function main() {
    let updated = 0;
    let skipped = 0;
    let unchanged = 0;
    const misses = [];

    for (const entry of mapping) {
        const city = await prisma.city.findUnique({
            where: { countryCode_slug: { countryCode: entry.country, slug: entry.slug } },
            select: { id: true, iconSlug: true, name: true },
        });

        if (!city) {
            misses.push(`${entry.country}/${entry.slug}`);
            skipped++;
            continue;
        }

        if (city.iconSlug === entry.iconSlug) {
            unchanged++;
            continue;
        }

        await prisma.city.update({
            where: { id: city.id },
            data: { iconSlug: entry.iconSlug },
        });
        console.log(`  ${entry.country}/${entry.slug.padEnd(22)} ← ${entry.iconSlug}`);
        updated++;
    }

    console.log(`\nDone: ${updated} updated, ${unchanged} already-current, ${skipped} skipped (no row).`);
    if (misses.length) {
        console.log(`\nCities in mapping but not in DB:`);
        misses.forEach((m) => console.log(`  ${m}`));
        console.log("  → add via /admin/cities and rerun, or remove from this file.");
    }
}

main()
    .catch((e) => {
        console.error("seed-city-icons failed:", e);
        process.exit(1);
    })
    .finally(async () => {
        await prisma.$disconnect();
    });
