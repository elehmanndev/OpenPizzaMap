#!/usr/bin/env node
// One-shot batch apply of the 44 manually-resolved sentinels from
// Eric's 2026-05-30 lookup pass over /tmp/sentinels.csv. Pairs are
// hardcoded so we don't have to re-deal with Excel's
// semicolon-delimiter / BOM mangling of the CSV.
//
// Run on opm-runner:
//   docker exec opm-runner node scripts/exports/apply-ta-batch-20260530.js

const PAIRS = [
    [883,  13230525, "ORZO Kraków"],
    [384,   6133674, "K2 Pizzeria"],
    [198,    457172, "Grimaldi's"],
    [474,   8810154, "Nolio"],
    [1211,  5506850, "Levante"],
    [190,   3741802, "Juliana's"],
    [1511, 17655046, "Ostro."],
    [430,  14970505, "Pizzeria Francesco&Salvatore Salvo"],
    [1229, 14073965, "Pizzeria Napoletana Pummarola"],
    [2781, 16897874, "1000 Gourmet"],
    [497,  10462925, "Napoli Centrale"],
    [1182,   781751, "Home Slice [North Loop]"],
    [96,   17216408, "Uno"],
    [1832,  1983535, "Al Solito Posto"],
    [2042, 12410956, "DaZero – Pizza e Territorio"],
    [496,   9592255, "Saulle Re"],
    [824,  28026454, "NEO PIZZA NAPOLETANA"],
    [523,  12227856, "Napoles"],
    [759,  24174333, "Maria Italiana"],
    [846,  26132643, "Si Nonna's BKC Jio World Plaza"],
    [510,  10643234, "Napolitivo"],
    [575,  10379332, "Luigia Lausanne"],
    [1753, 27111500, "Bella Napoli"],
    [682,  25134888, "Cimone"],
    [2268, 17778771, "Grano"],
    [2716,   793024, "Birraria La Corte"],
    [360,   2666426, "400 Gradi"],
    [2792,  7176550, "Michelangelo Bobb"],
    [358,   2071639, "La Terrazza"],
    [725,  13394013, "Manufaktura Pizzy"],
    [609,  23710015, "Amalfi Pizza"],
    [1677, 15009822, "I Borboni Pizzeria"],
    [766,   1103103, "All'Elefante Ristorante e Pizzeria"],
    [1890, 20194675, "Pizzeria Carbone"],
    [2552,  4149840, "Al Borgo 1964"],
    [199,    809819, "Lucali"],
    [1615,   809819, "Lucali"],
    [676,  17409269, "Vera Napoli"],
    [49,   33109043, "StorieDiPinte"],
    [1433,  1783074, "Antica Pizzeria Ciro 1923"],
    [341,   1088206, "Sfashioncafè"],
    [563,  11587019, "Verace Lubiana"],
    [1702, 26526486, "Filo d'olio"],
    [91,   16880833, "Lievita 72"],
];

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

(async () => {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        console.error("HOSTINGER_URL or ADMIN_API_KEY unset");
        process.exit(1);
    }

    let applied = 0, failed = 0;
    for (const [placeId, locationId, name] of PAIRS) {
        const r = await fetch(`${HOSTINGER_URL}/api/admin/update-place-ta`, {
            method: "POST",
            headers: { "x-api-key": ADMIN_API_KEY, "Content-Type": "application/json" },
            body: JSON.stringify({ placeId, tripadvisorLocationId: locationId }),
        });
        if (r.ok) {
            console.log(`  #${placeId} "${name}" → ${locationId}`);
            applied++;
        } else {
            console.warn(`  #${placeId} "${name}" → HTTP ${r.status}`);
            failed++;
        }
        await new Promise((res) => setTimeout(res, 100));
    }

    console.log(`\n# DONE`);
    console.log(`  applied: ${applied}`);
    console.log(`  failed:  ${failed}`);
})().catch((e) => { console.error(e); process.exit(1); });
