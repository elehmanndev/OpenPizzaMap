// Seed SEO content for /country/IT: an internally-linked intro and 10 FAQs.
//
// Why: country pages exist but have no copy yet, so they offer nothing for
// search engines or first-time visitors beyond a list of cities. This adds
// a single, hand-written intro and 10 evergreen FAQs for Italy — links
// inline route patterns that already exist in pages.js, no new endpoints.
//
// Idempotent: country.introHtml is overwritten on re-run (one canonical
// version), but FAQs are upserted by (scope, countryCode, question) so
// running twice does not duplicate rows.

const { prisma } = require("../lib/bootstrap");

const CODE = "IT";

// Style + city slug links must match prisma data — verified 2026-05-12:
// IT cities: bari, bologna, catania, florence, genoa, lecce, milan, naples,
// palermo, rome, turin, verona. Visible styles include: neapolitan, romana,
// sicilian, al-taglio, padellino, pinsa, focaccia-recco, pizza-fritta,
// apulian, italian-style.
const INTRO_HTML = `
<p>Pizza was invented in Italy, and each region developed its own version. OpenPizzaMap lists pizzerias across 12 Italian cities with a combined score from Google, TripAdvisor, and Yelp.</p>
<p><strong>Neapolitan pizza</strong> from <a href="/country/IT/city/naples">Naples</a> is the most internationally recognised style. The dough is highly hydrated, proofed for at least 24 hours, and baked in a wood-fired oven at around 450 °C for 60 to 90 seconds. UNESCO lists the technique as intangible cultural heritage. The Centro Storico, Decumani, and Quartieri Spagnoli districts have the highest density of historic pizzerias.</p>
<p><a href="/country/IT/city/rome">Rome</a> has two main pizza styles. <strong>Pizza tonda romana</strong> is thin and crisp, baked directly on a stone. <strong><a href="/style/al-taglio">Pizza al taglio</a></strong> is rectangular, baked in long pans, and sold by weight at bakeries across the city. <a href="/country/IT/city/turin">Turin</a> is the home of <a href="/style/padellino">pizza al padellino</a>, a small single-serving deep-pan pizza. <a href="/country/IT/city/genoa">Genoa</a> is known for <a href="/style/focaccia-recco">focaccia di Recco</a>, a cheese-filled flatbread with PGI protection.</p>
<p>In the south, <a href="/country/IT/city/bari">Bari</a> and <a href="/country/IT/city/lecce">Lecce</a> run an <a href="/style/apulian">Apulian</a> style with a sturdier dough. <a href="/country/IT/city/palermo">Palermo</a> and <a href="/country/IT/city/catania">Catania</a> make <strong>Sicilian sfincione</strong>, a thick spongy focaccia topped with tomato, onions, anchovies, oregano, and breadcrumbs.</p>
<p><a href="/country/IT/city/milan">Milan</a>, <a href="/country/IT/city/florence">Florence</a>, <a href="/country/IT/city/bologna">Bologna</a>, and <a href="/country/IT/city/verona">Verona</a> have a growing modern pizza scene, with new wood-fired and contemporary rooms opening every year. Use the <a href="/map">map</a> to filter by city, style, or rating and find a top-rated pizzeria nearby.</p>
`.trim();

const FAQS = [
    {
        question: "What is the most famous style of pizza in Italy?",
        answerHtml: `<p><strong><a href="/style/neapolitan">Neapolitan pizza</a></strong> from <a href="/country/IT/city/naples">Naples</a> is the most internationally recognised. It uses 00 flour, San Marzano tomatoes, fresh mozzarella, and a 60 to 90 second bake in a wood-fired oven at around 450 °C. UNESCO protects the technique as intangible cultural heritage.</p>`,
    },
    {
        question: "How is Roman pizza different from Neapolitan pizza?",
        answerHtml: `<p><strong><a href="/style/romana">Roman-style round pizza</a></strong> (pizza tonda romana) is thin and crisp, baked on a stone. <strong>Neapolitan</strong> dough is hydrated higher and proofs longer, producing a soft and puffy cornicione. Rome also has <a href="/style/al-taglio">pizza al taglio</a>, which is rectangular, baked in a pan, and sold by weight.</p>`,
    },
    {
        question: "What is pizza al taglio?",
        answerHtml: `<p><strong><a href="/style/al-taglio">Pizza al taglio</a></strong> means "pizza by the cut". It is baked in long rectangular trays, sliced to order, and sold by weight. It is common across <a href="/country/IT/city/rome">Rome</a> and ranges from a simple Margherita to elaborate topping combinations. Most Romans eat it as street food.</p>`,
    },
    {
        question: "Where can I find the best pizza in Naples?",
        answerHtml: `<p>Naples has the highest concentration of historic and high-rated pizzerias in Italy. The best results come from old-town areas such as Centro Storico, Decumani, Forcella, and the Quartieri Spagnoli. See the current top-rated places, sorted by combined Google, TripAdvisor, and Yelp score, on the <a href="/country/IT/city/naples">Naples city page</a>.</p>`,
    },
    {
        question: "What is pizza fritta?",
        answerHtml: `<p><strong><a href="/style/pizza-fritta">Pizza fritta</a></strong> is a Neapolitan fried pizza. It is a folded pocket of dough filled with ricotta, smoked provola, cicoli (pork cracklings), and tomato, then deep-fried until golden. It is older than wood-fired pizza in Naples and is still sold as street food today.</p>`,
    },
    {
        question: "What is focaccia di Recco?",
        answerHtml: `<p><strong><a href="/style/focaccia-recco">Focaccia di Recco</a></strong> is a Ligurian specialty from the town of Recco near <a href="/country/IT/city/genoa">Genoa</a>. Two paper-thin sheets of unleavened dough are filled with fresh crescenza cheese and baked at high heat until blistered. It carries PGI protection.</p>`,
    },
    {
        question: "Is Sicilian pizza the same as the American version?",
        answerHtml: `<p>No. Authentic <strong><a href="/style/sicilian">Sicilian pizza</a></strong> (sfincione) from <a href="/country/IT/city/palermo">Palermo</a> is a thick spongy focaccia topped with tomato, onion, anchovies, oregano, and breadcrumbs. It usually has no mozzarella. The Sicilian-American version sold in New York came from the same square-pan tradition but added cheese and heavier toppings.</p>`,
    },
    {
        question: "What is pizza al padellino?",
        answerHtml: `<p><strong><a href="/style/padellino">Pizza al padellino</a></strong> (small pan pizza) is a <a href="/country/IT/city/turin">Turin</a> specialty. It is baked in a small oiled steel pan and produces a crisp golden base with a slightly chewy crumb. Each pizza is about 20 cm wide and served whole as a single portion.</p>`,
    },
    {
        question: "How much does a pizza cost in Italy?",
        answerHtml: `<p>A classic Margherita at a neighbourhood pizzeria costs €5 to €9 in most Italian cities. Premium and gourmet pizzerias in <a href="/country/IT/city/milan">Milan</a>, <a href="/country/IT/city/florence">Florence</a>, or <a href="/country/IT/city/rome">Rome</a> can run €12 to €18. Pizza al taglio is sold by weight, usually €15 to €22 per kilogram.</p>`,
    },
    {
        question: "Do Italians eat pizza with their hands or with cutlery?",
        answerHtml: `<p>Both, depending on the style. A Neapolitan pizza is soft in the centre, so locals usually start with a knife and fork, then fold the slices and finish by hand (the "a libretto" method). Roman tonda and pizza al taglio are eaten directly with the hands.</p>`,
    },
];

async function main() {
    // Intro
    await prisma.country.update({
        where: { code: CODE },
        data: { introHtml: INTRO_HTML, isVisible: true },
    });
    console.log(`+ intro updated for ${CODE}`);

    // FAQs — upsert by (scope, countryCode, question). No composite unique
    // exists in the schema, so we look up first and update/create explicitly.
    let created = 0;
    let updated = 0;
    for (let i = 0; i < FAQS.length; i++) {
        const f = FAQS[i];
        const existing = await prisma.faq.findFirst({
            where: { scope: "country", countryCode: CODE, question: f.question },
            select: { id: true },
        });
        if (existing) {
            await prisma.faq.update({
                where: { id: existing.id },
                data: { answerHtml: f.answerHtml, sortOrder: i, isVisible: true },
            });
            updated++;
        } else {
            await prisma.faq.create({
                data: {
                    scope: "country",
                    countryCode: CODE,
                    question: f.question,
                    answerHtml: f.answerHtml,
                    sortOrder: i,
                    isVisible: true,
                },
            });
            created++;
        }
    }
    console.log(`+ FAQs: ${created} created, ${updated} updated (total ${FAQS.length})`);
}

main()
    .catch((err) => { console.error(err); process.exit(1); })
    .finally(() => prisma.$disconnect());
