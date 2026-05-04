// Place-name normalisation used by the dedup gate. Strips accents,
// non-alphanumerics, and a list of common prefixes that vary between
// sources for the same venue ("Pizzeria Starita" / "Starita", "Antica
// Pizzeria Ciro" / "Ciro", "10 Pizzeria Diego" / "Diego"). Suffixes are
// deliberately NOT stripped — words like `bistrot` / `restaurant` often
// distinguish a venue's standalone bar from its main pizzeria at the same
// address (see Pass B of the 2026-05-02 dedup audit).
//
// Originally lived inline at scripts/import-places.js:236; extracted so
// the enrichment pipeline (src/services/enrichment/index.js) can apply
// the exact same rule.

const NAME_PREFIX_RE = /^(pizzeria|pizzaria|antica|the|le|la|il|el|los|las|\d+\s+|–|—|-)\s*/i;

function normalizePlaceName(name) {
    let s = String(name || "")
        .normalize("NFD").replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // Loop because the same row can have stacked prefixes ("10 Pizzeria Diego").
    for (let i = 0; i < 5; i++) {
        const next = s.replace(NAME_PREFIX_RE, "").trim();
        if (next === s) break;
        s = next;
    }
    return s;
}

module.exports = { normalizePlaceName };
