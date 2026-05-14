// Seed the Country table from country codes already present in City.
//
// Why: /country/:code 404s in prod because the Country table is empty,
// even though City and Place reference 60+ country codes. This idempotently
// creates one Country row per code, names it via Intl.DisplayNames, and
// publishes it. Re-runnable; existing rows are left alone (name + slug only
// filled if missing, isVisible never downgraded).

const { prisma } = require("../lib/bootstrap");

function slugify(s) {
    return String(s)
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

const displayNames = new Intl.DisplayNames(["en"], { type: "region" });

function nameFor(code) {
    try {
        const n = displayNames.of(code);
        if (n && n !== code) return n;
    } catch (_) { /* fall through */ }
    return code;
}

async function main() {
    const cityCodes = await prisma.city.groupBy({ by: ["countryCode"] });
    const codes = cityCodes
        .map((r) => String(r.countryCode || "").trim().toUpperCase())
        .filter((c) => c.length === 2);

    const existing = await prisma.country.findMany({ select: { code: true, name: true, slug: true } });
    const existingByCode = new Map(existing.map((c) => [c.code, c]));
    const usedSlugs = new Set(existing.map((c) => c.slug).filter(Boolean));

    let created = 0;
    let updated = 0;

    for (const code of codes.sort()) {
        const name = nameFor(code);
        let slug = slugify(name);
        if (!slug) slug = code.toLowerCase();
        // Ensure slug uniqueness across the run (e.g. duplicates from name collisions).
        let candidate = slug;
        let n = 2;
        const prior = existingByCode.get(code);
        const priorSlug = prior && prior.slug;
        while (usedSlugs.has(candidate) && candidate !== priorSlug) {
            candidate = `${slug}-${n++}`;
        }
        slug = candidate;
        usedSlugs.add(slug);

        if (!prior) {
            await prisma.country.create({
                data: { code, name, slug, isVisible: true },
            });
            created++;
            console.log(`+ ${code}  ${name}  /${slug}`);
        } else {
            const patch = {};
            if (!prior.name) patch.name = name;
            if (!prior.slug) patch.slug = slug;
            if (Object.keys(patch).length) {
                await prisma.country.update({ where: { code }, data: patch });
                updated++;
                console.log(`~ ${code}  ${JSON.stringify(patch)}`);
            }
        }
    }

    console.log(`\ndone: ${created} created, ${updated} backfilled, ${codes.length} codes seen.`);
}

main()
    .catch((err) => {
        console.error(err);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());
