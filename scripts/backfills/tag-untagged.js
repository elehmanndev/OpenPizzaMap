#!/usr/bin/env node
// One-off: clean up the 113 remaining untagged places.
// Pass 1: pattern-match names for obvious styles.
// Pass 2: retry Gemini at min-confidence=0.5 for the rest.
// Pass 3: hide clearly non-pizza places.

const { prisma } = require("../lib/bootstrap");

const APPLY = process.argv.includes("--apply");
if (!APPLY) console.log("[tag] DRY-RUN — pass --apply to write changes\n");

// Name patterns → style slug(s)
const NAME_RULES = [
    // Neapolitan chains in Spain
    [/^vezzo\b/i,                  ["neapolitan"]],
    [/^trozzo\b/i,                  ["neapolitan"]],
    [/\bnapoli\b|\bnapolitan/i,     ["neapolitan"]],
    [/\bnapoletana\b|\bnapoletano/i,["neapolitan"]],
    [/\bmalafemmena\b/i,            ["neapolitan"]],
    [/\bannare/i,                    ["neapolitan"]],
    [/\bfoorn\b/i,                  ["neapolitan"]],
    // Pinsa
    [/\bpinsa\b|\bpinseria\b/i,     ["pinsa"]],
    // Al taglio
    [/\btaglio\b/i,                 ["al-taglio"]],
    // Sicilian
    [/\bsiciliana?\b|\bsicilia\b/i, ["sicilian"]],
    // Chicago
    [/\bdeep.dish\b/i,              ["chicago"]],
    // Detroit
    [/\bdetroit\b/i,                ["detroit"]],
    // NY
    [/\bnew york\b/i,               ["ny"]],
];

// Names that are clearly not pizza places → hide
const HIDE_PATTERNS = [
    /\bclothing store\b/i,
    /\bkorean restaurant\b/i,
    /\bliquor\b/i,
];

async function getStyleId(slug) {
    const s = await prisma.style.findUnique({ where: { slug } });
    return s?.id ?? null;
}

async function applyStyles(placeId, slugs) {
    const styles = await prisma.style.findMany({ where: { slug: { in: slugs } } });
    if (!styles.length) return;
    await prisma.placeStyle.createMany({
        data: styles.map(s => ({ placeId, styleId: s.id })),
        skipDuplicates: true,
    });
    const place = await prisma.place.findUnique({
        where: { id: placeId },
        include: { styles: { include: { style: true } } },
    });
    if (place) {
        await prisma.place.update({
            where: { id: placeId },
            data: { stylesJson: JSON.stringify(place.styles.map(s => s.style.slug)) },
        });
    }
}

async function main() {
    const untagged = await prisma.place.findMany({
        where: { isVisible: true, styles: { none: {} } },
        orderBy: { id: "asc" },
        select: { id: true, name: true, city: true, country: true },
    });

    console.log(`[tag] ${untagged.length} untagged places\n`);

    let patternHits = 0, hidden = 0, remaining = [];

    for (const place of untagged) {
        // Check hide patterns first
        if (HIDE_PATTERNS.some(re => re.test(place.name))) {
            console.log(`[hide] #${place.id} "${place.name}" — not a pizza place`);
            if (APPLY) await prisma.place.update({ where: { id: place.id }, data: { isVisible: false } });
            hidden++;
            continue;
        }

        // Try name rules
        let matched = null;
        for (const [re, slugs] of NAME_RULES) {
            if (re.test(place.name)) { matched = slugs; break; }
        }

        if (matched) {
            console.log(`[pattern] #${place.id} "${place.name}" → ${matched.join(", ")}`);
            if (APPLY) await applyStyles(place.id, matched);
            patternHits++;
        } else {
            remaining.push(place);
        }
    }

    console.log(`\n[tag] Pattern pass: ${patternHits} tagged, ${hidden} hidden, ${remaining.length} remaining`);
    console.log("\nRemaining (needs manual review or Gemini retry):");
    remaining.forEach(p => console.log(`  #${p.id} "${p.name}" — ${p.city || "?"}, ${p.country || "?"}`));
}

main()
    .catch(err => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
