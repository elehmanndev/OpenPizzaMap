// Seed SEO content for /country/IT/city/milan: a city intro and 10 FAQs.
//
// Same idempotent pattern as seed-italy-content.js. Intro is written for
// /country/IT/city/milan, FAQs are scope=city / cityId=<milan>. No specific
// place names are mentioned (the city has too many openings/closings to keep
// a hand-written list current — those references belong in the ranked card
// section, which is regenerated from the DB on every request).

const { prisma } = require("../lib/bootstrap");

const CITY_SLUG = "milan";
const COUNTRY = "IT";

const INTRO_HTML = `
<p><a href="/country/IT/city/milan">Milan</a> is the second largest city in <a href="/country/IT">Italy</a> and a relatively young pizza town. The Neapolitan tradition only arrived in Milan after the second world war, brought by southern migrants who moved north for work. For decades the result was solid neighbourhood pizza, nothing more.</p>
<p>That changed in the 2010s. Milan became the centre of Italy's <strong>gourmet pizza</strong> movement, the place where the rules of dough, fermentation, and toppings were rewritten. Long fermentations, single-origin flours, and high-hydration doughs all became normal here years before the rest of Italy caught up.</p>
<p>The city now serves more pizza styles than any other in Italy. Classic <strong><a href="/style/neapolitan">Neapolitan</a></strong> is everywhere. So is <strong>contemporary</strong> pizza, a Milan-led style with a taller, airier crust and seasonal toppings. <a href="/country/IT/city/turin">Turin's</a> <a href="/style/padellino">pizza al padellino</a>, <a href="/country/IT/city/rome">Roman</a> <a href="/style/al-taglio">pizza al taglio</a> by the slice, and <strong>pinsa</strong> from Lazio all have established outposts.</p>
<p>The densest pizza neighbourhoods are <strong>Brera</strong>, <strong>Navigli</strong>, <strong>Porta Romana</strong>, <strong>Isola</strong>, and <strong>Porta Venezia</strong>. Tourist streets near the Duomo have famous-name branches but locals tend to walk a tram stop or two for better dough.</p>
<p>Most contemporary pizzerias take bookings for dinner and you should use them. Walk-in waits of 45 to 60 minutes are common on a Friday or Saturday night across the central districts.</p>
`.trim();

const FAQS = [
    {
        question: "When did pizza arrive in Milan?",
        answerHtml: `<p>The first <strong>Neapolitan pizzerias</strong> opened in Milan in the late 1940s and 1950s, run by families who migrated north from <a href="/country/IT/city/naples">Naples</a> looking for industrial work. Pizza was treated as a southern Italian curiosity for years before it became part of Milan's everyday food culture.</p>`,
    },
    {
        question: "Where is the best neighbourhood for pizza in Milan?",
        answerHtml: `<p>The highest density of well-regarded pizzerias is in <strong>Brera</strong>, <strong>Navigli</strong>, <strong>Porta Romana</strong>, <strong>Isola</strong>, and <strong>Porta Venezia</strong>. The area immediately around the Duomo and Galleria has famous-name outposts but is generally more expensive and more touristed than the surrounding districts.</p>`,
    },
    {
        question: "What pizza styles can I find in Milan?",
        answerHtml: `<p>More than any other Italian city. <a href="/style/neapolitan">Neapolitan</a> is the most common. The local speciality is <strong>contemporary pizza</strong>, a high-hydration evolution of Neapolitan that Milan pioneered in the 2010s. You will also find <a href="/style/padellino">pizza al padellino</a> from <a href="/country/IT/city/turin">Turin</a>, Roman <a href="/style/al-taglio">pizza al taglio</a> sold by weight, and <strong>pinsa</strong> from Lazio.</p>`,
    },
    {
        question: "What is contemporary pizza?",
        answerHtml: `<p><strong>Contemporary pizza</strong> ("pizza contemporanea") is a style developed in Milan and northern Italy in the 2010s. The dough is hydrated to around 75 to 80 percent, fermented for 48 to 72 hours, and baked to a taller and lighter cornicione than classic <a href="/style/neapolitan">Neapolitan</a>. Toppings lean seasonal and ingredient-driven, often added after the bake.</p>`,
    },
    {
        question: "How much does a pizza cost in Milan?",
        answerHtml: `<p>Expect €8 to €12 for a classic Margherita at a neighbourhood pizzeria, €13 to €20 at a contemporary or gourmet pizzeria, and €4 to €8 per portion of <a href="/style/al-taglio">pizza al taglio</a> sold by weight. Milan is more expensive than southern Italian cities for the same style of pizza.</p>`,
    },
    {
        question: "Do I need to book a pizzeria in Milan?",
        answerHtml: `<p>Yes, for dinner at the better contemporary and gourmet places. Friday and Saturday nights routinely have 45 to 60 minute walk-in waits across <strong>Brera</strong>, <strong>Navigli</strong>, and <strong>Porta Romana</strong>. Lunch and weekday evenings are usually fine without a reservation.</p>`,
    },
    {
        question: "Where can I get pizza near the Duomo?",
        answerHtml: `<p>The streets around the Duomo and the Galleria Vittorio Emanuele have several famous-name pizzerias, including Milan branches of historic <a href="/country/IT/city/naples">Naples</a> houses. They are convenient but among the most expensive in the city. For better value, walk ten minutes to <strong>Brera</strong> to the north or <strong>Porta Romana</strong> to the south.</p>`,
    },
    {
        question: "Where can I find gluten-free pizza in Milan?",
        answerHtml: `<p>Most contemporary pizzerias offer a <strong>gluten-free</strong> base on request, usually with a small surcharge. A growing number of dedicated gluten-free pizzerias also operate in <strong>Porta Venezia</strong> and <strong>Navigli</strong>. Check the venue page on OpenPizzaMap for current dietary options.</p>`,
    },
    {
        question: "What is pizza al taglio and where do I find it in Milan?",
        answerHtml: `<p><a href="/style/al-taglio">Pizza al taglio</a> ("by the cut") is rectangular pizza baked in long pans, sliced to order, and sold by weight. It originated in <a href="/country/IT/city/rome">Rome</a> but is now common across Milan, especially in <strong>Brera</strong>, <strong>Porta Romana</strong>, and the area around <strong>Stazione Centrale</strong>. It is the standard quick lunch option.</p>`,
    },
    {
        question: "Are there late-night pizzerias in Milan?",
        answerHtml: `<p>Pizzeria kitchens in Milan generally close between 23:00 and midnight. A handful of late-night spots in <strong>Navigli</strong> and around <strong>Corso Como</strong> serve pizza until 01:00 or 02:00 on weekends, often as part of a bar or aperitivo concept. Outside of those areas, after-midnight pizza is rare.</p>`,
    },
];

async function main() {
    const city = await prisma.city.findUnique({
        where: { countryCode_slug: { countryCode: COUNTRY, slug: CITY_SLUG } },
        select: { id: true, name: true },
    });
    if (!city) {
        console.error(`City not found: ${COUNTRY}/${CITY_SLUG}`);
        process.exit(1);
    }

    await prisma.city.update({
        where: { id: city.id },
        data: { introHtml: INTRO_HTML, isVisible: true },
    });
    console.log(`+ intro updated for ${city.name}`);

    let created = 0;
    let updated = 0;
    for (let i = 0; i < FAQS.length; i++) {
        const f = FAQS[i];
        const existing = await prisma.faq.findFirst({
            where: { scope: "city", cityId: city.id, question: f.question },
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
                    scope: "city",
                    cityId: city.id,
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
