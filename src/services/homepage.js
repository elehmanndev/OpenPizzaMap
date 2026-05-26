const { prisma } = require("../db");
const stockPhotos = require("./stockPhotos");

// Pick the best photo we have for a row card. heroImageUrl on the row's
// own model wins (admin override); otherwise we derive from the
// highest-rated visible Place that belongs to the row. Final fallback
// is a stamp SVG keyed by sortOrder/id so each card stays distinct.
const STAMP_FALLBACKS = [
  "/public/img/stamps/colosseum.svg",
  "/public/img/stamps/sagrada-familia.svg",
  "/public/img/stamps/duomo-di-milano.svg",
  "/public/img/stamps/giralda.svg",
  "/public/img/stamps/pisa.svg",
  "/public/img/stamps/florence.svg",
  "/public/img/stamps/aqueduct.svg",
  "/public/img/stamps/mole-antonelliana.svg",
  "/public/img/stamps/royal-palace.svg",
  "/public/img/stamps/belem-tower.svg",
  "/public/img/stamps/alhambra-granada.svg",
  "/public/img/stamps/parthenon.svg",
  "/public/img/stamps/gondola.svg",
  "/public/img/stamps/temple.svg",
];

function stampFor(seed) {
  const i = Math.abs(Number(seed) || 0) % STAMP_FALLBACKS.length;
  return STAMP_FALLBACKS[i];
}

async function getCityCards(limit = 4) {
  // Top cities by visible-place count. Per-IP geo ranking was
  // prototyped on 2026-05-26 but dropped — it broke edge cacheability
  // on the public homepage and depended on a City.lat/lng backfill
  // that hasn't shipped (0/44 populated). Revisit when that backfill
  // lands and a Vary-by-region cache strategy is in place.
  const cities = await prisma.city.findMany({
    where: { isVisible: true },
    select: {
      id: true,
      name: true,
      slug: true,
      countryCode: true,
      heroImageUrl: true,
      _count: { select: { places: { where: { isVisible: true } } } },
    },
  });
  const ranked = cities
    .filter((c) => c._count.places > 0)
    .sort((a, b) => b._count.places - a._count.places)
    .slice(0, limit);

  // Image priority: admin-set heroImageUrl → curated stock photo
  // (replaced with Adobe Stock later, see src/services/stockPhotos.js) →
  // stamp SVG as ultimate fallback if the stock URL fails to load.
  return ranked.map((c) => ({
    title: c.name,
    subtitle: c.countryCode,
    href: `/country/${c.countryCode.toLowerCase()}/city/${c.slug}`,
    image: c.heroImageUrl || stockPhotos.getCityPhoto(c.slug),
    fallback: stampFor(c.id),
    placeCount: c._count.places,
  }));
}

async function getStyleCards() {
  const styles = await prisma.style.findMany({
    where: { isVisible: true },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: {
      id: true,
      name: true,
      shortLabel: true,
      slug: true,
      heroImageUrl: true,
    },
  });

  return styles.map((s) => ({
    title: s.shortLabel || s.name,
    subtitle: null,
    href: `/styles/${s.slug}`,
    image: s.heroImageUrl || stockPhotos.getStylePhoto(s.slug),
    fallback: stampFor(s.id + 7),
  }));
}

async function getCounters() {
  const [places, countries, cities] = await Promise.all([
    prisma.place.count({ where: { isVisible: true } }),
    prisma.country.count({ where: { isVisible: true } }),
    prisma.city.count({ where: { isVisible: true } }),
  ]);
  return { places, countries, cities };
}

// Featured Places carousel — the curated row up top. Returns 4 places
// per tab. v1 only "top-rated" and "newly-added" are real; the rest
// (most-reviewed, editors-picks) reuse top-rated until we wire them up.
async function getFeaturedPlaces(tab = "top-rated", take = 8) {
  const baseWhere = { isVisible: true, heroImageUrl: { not: null } };
  let orderBy;
  if (tab === "newly-added") {
    orderBy = [{ createdAt: "desc" }];
  } else if (tab === "most-reviewed") {
    orderBy = [{ googleReviewCount: "desc" }, { opmRating: "desc" }];
  } else {
    orderBy = [{ opmRating: "desc" }, { id: "asc" }];
  }
  const rows = await prisma.place.findMany({
    where: baseWhere,
    orderBy,
    take,
    select: {
      id: true,
      name: true,
      slug: true,
      addressLine: true,
      city: true,
      country: true,
      priceLevel: true,
      heroImageUrl: true,
      opmRating: true,
      googleReviewCount: true,
      styles: {
        take: 1,
        orderBy: { style: { sortOrder: "asc" } },
        select: { style: { select: { shortLabel: true, name: true } } },
      },
    },
  });
  return rows.map((p) => {
    const styleLabel = p.styles[0]
      ? (p.styles[0].style.shortLabel || p.styles[0].style.name)
      : "Pizzeria";
    return {
      id: p.id,
      title: p.name,
      categoryLabel: styleLabel,
      address: `${p.addressLine}, ${p.city}, ${p.country}`,
      href: p.slug ? `/place/${p.slug}` : `/place/${p.id}`,
      image: p.heroImageUrl,
      fallback: stampFor(p.id),
      rating: p.opmRating ? Number(p.opmRating).toFixed(1) : null,
      reviewCount: p.googleReviewCount || null,
      priceLevel: p.priceLevel || null,
    };
  });
}

// Hero collage — 3 random pizza photos picked from the 30-photo pool
// in stockPhotos.js. Re-rolls on every page load, so refreshing the
// homepage rotates the imagery. Placeholder URLs today; replace with
// Adobe Stock in stockPhotos.js when ready (no change needed here).
function getHeroCollage() {
  const photos = stockPhotos.getHeroPizzaPhotos(3);
  return photos.map((url, i) => ({
    image: url,
    fallback: stampFor(i * 5 + 3),
    caption: null,
  }));
}

// Blog row — stub data while the Blog schema isn't built yet. Posts
// link nowhere (href="#") and are labeled "Coming soon" so users
// understand the row is a placeholder. See project_wishlist for the
// real-blog requirements.
function getBlogStubs() {
  return [
    {
      title: "The Neapolitan rules: what makes a real pizza Napoletana",
      excerpt: "Wood-fired ovens, 60-90 second cook times, and why San Marzano matters.",
      image: "/public/img/stamps/colosseum.svg",
      fallback: "/public/img/stamps/colosseum.svg",
      meta: "Coming soon · 5 min read",
      href: "#",
    },
    {
      title: "Detroit vs Chicago: deep-dish isn't a single thing",
      excerpt: "Two cities, two pans, two very different ideas about what 'thick' means.",
      image: "/public/img/stamps/statue-of-liberty.svg",
      fallback: "/public/img/stamps/statue-of-liberty.svg",
      meta: "Coming soon · 6 min read",
      href: "#",
    },
    {
      title: "A pizza pilgrimage through Italy in 10 days",
      excerpt: "From Naples to Turin: where to eat, where to skip, and why timing matters.",
      image: "/public/img/stamps/duomo-di-milano.svg",
      fallback: "/public/img/stamps/duomo-di-milano.svg",
      meta: "Coming soon · 8 min read",
      href: "#",
    },
  ];
}

// Footer landing-page links. Multi-column footer like the Amimir.com
// reference — gives crawlers + casual visitors a path into the deeper
// city/country/style landing pages without forcing them through the
// map or search.
async function getFooterLinks() {
  const [cities, countries, styles] = await Promise.all([
    // Top 12 cities by visible-place count
    prisma.city.findMany({
      where: { isVisible: true },
      select: {
        name: true,
        slug: true,
        countryCode: true,
        _count: { select: { places: { where: { isVisible: true } } } },
      },
    }),
    // Top 8 countries by visible-place count. Country doesn't track a
    // place relation, so count via Place.country (the denormalized
    // string column) and join names via the Country table.
    prisma.country.findMany({
      where: { isVisible: true },
      select: { code: true, name: true, slug: true },
    }),
    prisma.style.findMany({
      where: { isVisible: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
      select: { name: true, shortLabel: true, slug: true },
    }),
  ]);

  // Per-country place counts (visible only) — single grouped query so
  // we can rank Country rows even though Place→Country isn't a Prisma
  // relation.
  const countryCounts = await prisma.place.groupBy({
    by: ["country"],
    where: { isVisible: true },
    _count: { _all: true },
  });
  const countByName = new Map(countryCounts.map((g) => [g.country, g._count._all]));

  // Possessive form for country labels — handles "Italy's" / "United
  // States'" / "Switzerland's". Names already ending in "s" take a
  // bare apostrophe, the rest get "'s".
  const possessive = (name) =>
    /s$/i.test(name) ? `${name}'` : `${name}'s`;

  return {
    cities: cities
      .filter((c) => c._count.places > 0)
      .sort((a, b) => b._count.places - a._count.places)
      .slice(0, 12)
      .map((c) => ({
        label: `Pizzerias in ${c.name}`,
        href: `/country/${c.countryCode.toLowerCase()}/city/${c.slug}`,
        count: c._count.places,
      })),
    countries: countries
      .map((c) => {
        const name = c.name || c.code;
        return {
          label: `${possessive(name)} top pizzerias`,
          href: `/country/${c.code.toLowerCase()}`,
          count: countByName.get(c.name || "") || 0,
        };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    styles: styles.map((s) => ({
      label: `Best ${s.shortLabel || s.name} pizzerias`,
      href: `/style/${s.slug}`,
    })),
    // "Most popular / Best rated" — forward-looking links to the map
    // with sort hints. The map page doesn't honor these query params
    // yet; wiring them up is a separate task. Links are still useful
    // for SEO (clear intent) and let visitors browse curated cuts.
    curated: [
      { label: "Top rated pizzerias", href: "/map?sort=rating" },
      { label: "Most reviewed", href: "/map?sort=reviews" },
      { label: "Recently added", href: "/map?sort=new" },
      { label: "Featured this week", href: "/home-preview?tab=top-rated#featured" },
    ],
  };
}

module.exports = {
  getCityCards,
  getStyleCards,
  getCounters,
  getFeaturedPlaces,
  getHeroCollage,
  getBlogStubs,
  getFooterLinks,
};
