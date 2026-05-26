// Stock photo pools for the public homepage.
//
// PLACEHOLDERS ONLY. Eric will replace each URL with the corresponding
// licensed Adobe Stock asset when those are ready. The shape of this
// file (named arrays + lookup maps) is the contract — keep it the same
// so the homepage service doesn't need to change at swap time.
//
// Today these point at picsum.photos with stable seeds. picsum returns
// random photographic content (landscapes, objects, people) at any
// dimension — clearly not pizza, intentionally obvious as placeholder,
// but populates the layout with real-feeling imagery so we can judge
// composition + grid before the final assets land.
//
// Swap procedure:
//   1. Replace each URL on the right side of `=` with the Adobe Stock
//      asset URL (or local /uploads/stock/... after download).
//   2. Keep the keys in CITY_PHOTO_BY_SLUG / STYLE_PHOTO_BY_SLUG; the
//      homepage looks up by slug. Missing keys fall through to the
//      generic picsum seed automatically.
//   3. No other file needs to change.

const PICSUM = (seed, size = 600) =>
  `https://picsum.photos/seed/${encodeURIComponent(seed)}/${size}/${size}`;

// 30 hero pizza photos — shown in the right-side hero collage. Three
// random picks per page load so refreshing the homepage rotates them.
const HERO_PIZZA_PHOTOS = Array.from({ length: 30 }, (_, i) =>
  PICSUM(`opm-hero-pizza-${i + 1}`)
);

// City photos — keyed by City.slug. Used for the "Discover the best
// pizzerias in your city" row. Missing keys fall back to a generic
// per-city seed so coverage is never blank.
const CITY_PHOTO_BY_SLUG = {
  naples: PICSUM("opm-city-naples"),
  rome: PICSUM("opm-city-rome"),
  milan: PICSUM("opm-city-milan"),
  turin: PICSUM("opm-city-turin"),
  florence: PICSUM("opm-city-florence"),
  bologna: PICSUM("opm-city-bologna"),
  verona: PICSUM("opm-city-verona"),
  palermo: PICSUM("opm-city-palermo"),
  catania: PICSUM("opm-city-catania"),
  genoa: PICSUM("opm-city-genoa"),
  barcelona: PICSUM("opm-city-barcelona"),
  madrid: PICSUM("opm-city-madrid"),
  paris: PICSUM("opm-city-paris"),
  london: PICSUM("opm-city-london"),
  "new-york-city": PICSUM("opm-city-nyc"),
  brooklyn: PICSUM("opm-city-brooklyn"),
  chicago: PICSUM("opm-city-chicago"),
  "los-angeles": PICSUM("opm-city-la"),
  lisbon: PICSUM("opm-city-lisbon"),
  berlin: PICSUM("opm-city-berlin"),
};

// Style photos — keyed by Style.slug. Used for the "Browse by style"
// row. Each pizza style gets a distinct shot.
const STYLE_PHOTO_BY_SLUG = {
  neapolitan: PICSUM("opm-style-neapolitan"),
  "italian-style": PICSUM("opm-style-italian"),
  romana: PICSUM("opm-style-romana"),
  "al-taglio": PICSUM("opm-style-al-taglio"),
  pinsa: PICSUM("opm-style-pinsa"),
  "pizza-fritta": PICSUM("opm-style-fritta"),
  ny: PICSUM("opm-style-ny"),
  "new-haven": PICSUM("opm-style-new-haven"),
  detroit: PICSUM("opm-style-detroit"),
  chicago: PICSUM("opm-style-chicago"),
  sicilian: PICSUM("opm-style-sicilian"),
  apulian: PICSUM("opm-style-apulian"),
  padellino: PICSUM("opm-style-padellino"),
  "focaccia-recco": PICSUM("opm-style-focaccia-recco"),
};

// Pick `n` distinct random elements from an array (Fisher-Yates partial
// shuffle). Used to rotate hero photos.
function pickRandom(arr, n) {
  const copy = arr.slice();
  const out = [];
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = i + Math.floor(Math.random() * (copy.length - i));
    [copy[i], copy[j]] = [copy[j], copy[i]];
    out.push(copy[i]);
  }
  return out;
}

function getHeroPizzaPhotos(n = 3) {
  return pickRandom(HERO_PIZZA_PHOTOS, n);
}

function getCityPhoto(slug) {
  return CITY_PHOTO_BY_SLUG[slug] || PICSUM(`opm-city-${slug || "default"}`);
}

function getStylePhoto(slug) {
  return STYLE_PHOTO_BY_SLUG[slug] || PICSUM(`opm-style-${slug || "default"}`);
}

module.exports = {
  HERO_PIZZA_PHOTOS,
  CITY_PHOTO_BY_SLUG,
  STYLE_PHOTO_BY_SLUG,
  getHeroPizzaPhotos,
  getCityPhoto,
  getStylePhoto,
};
