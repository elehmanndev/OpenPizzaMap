// Stock photo pools for the public homepage.
//
// Backed by licensed Adobe Stock assets under /public/img/stock/.
// All files are 1200x1200 JPEG, mozjpeg-encoded, EXIF stripped — see
// scripts/deploy/optimize-stock-photos.js for the optimization pipeline.
//
// To add or replace a photo:
//   1. Drop the new file into the matching subfolder under
//      public/img/stock/{hero,cities,styles}/ using the exact filename
//      that appears in the constants below.
//   2. Run `npm run optimize:stock` to resize + recompress.
//   3. If adding a new slug (new city or style), add an entry to the
//      corresponding lookup map below.

const HERO_ROOT = "/public/img/stock/hero";
const CITY_ROOT = "/public/img/stock/cities";
const STYLE_ROOT = "/public/img/stock/styles";

// 38 hero pizza photos — shown in the right-side hero collage. Three
// random picks per page load so refreshing the homepage rotates them.
const HERO_PIZZA_PHOTOS = Array.from({ length: 38 }, (_, i) =>
  `${HERO_ROOT}/pizza-${i + 1}.jpg`
);

// City photos — keyed by City.slug. Used for the "Discover the best
// pizzerias in your city" row. Missing keys fall back to a generic
// per-city seed so coverage is never blank.
const CITY_PHOTO_BY_SLUG = {
  naples:           `${CITY_ROOT}/naples.jpg`,
  rome:             `${CITY_ROOT}/rome.jpg`,
  milan:            `${CITY_ROOT}/milan.jpg`,
  turin:            `${CITY_ROOT}/turin.jpg`,
  florence:         `${CITY_ROOT}/florence.jpg`,
  bologna:          `${CITY_ROOT}/bologna.jpg`,
  verona:           `${CITY_ROOT}/verona.jpg`,
  palermo:          `${CITY_ROOT}/palermo.jpg`,
  catania:          `${CITY_ROOT}/catania.jpg`,
  genoa:            `${CITY_ROOT}/genoa.jpg`,
  barcelona:        `${CITY_ROOT}/barcelona.jpg`,
  madrid:           `${CITY_ROOT}/madrid.jpg`,
  paris:            `${CITY_ROOT}/paris.jpg`,
  london:           `${CITY_ROOT}/london.jpg`,
  "new-york-city":  `${CITY_ROOT}/new-york-city.jpg`,
  brooklyn:         `${CITY_ROOT}/brooklyn.jpg`,
  chicago:          `${CITY_ROOT}/chicago.jpg`,
  "los-angeles":    `${CITY_ROOT}/los-angeles.jpg`,
  lisbon:           `${CITY_ROOT}/lisbon.jpg`,
  berlin:           `${CITY_ROOT}/berlin.jpg`,
};

// Style photos — keyed by Style.slug. Used for the "Browse by style"
// row. Each pizza style gets a distinct shot.
const STYLE_PHOTO_BY_SLUG = {
  neapolitan:       `${STYLE_ROOT}/neapolitan.jpg`,
  "italian-style":  `${STYLE_ROOT}/italian-style.jpg`,
  romana:           `${STYLE_ROOT}/romana.jpg`,
  "al-taglio":      `${STYLE_ROOT}/al-taglio.jpg`,
  pinsa:            `${STYLE_ROOT}/pinsa.jpg`,
  "pizza-fritta":   `${STYLE_ROOT}/pizza-fritta.jpg`,
  ny:               `${STYLE_ROOT}/ny.jpg`,
  "new-haven":      `${STYLE_ROOT}/new-haven.jpg`,
  detroit:          `${STYLE_ROOT}/detroit.jpg`,
  chicago:          `${STYLE_ROOT}/chicago.jpg`,
  sicilian:         `${STYLE_ROOT}/sicilian.jpg`,
  apulian:          `${STYLE_ROOT}/apulian.jpg`,
  padellino:        `${STYLE_ROOT}/padellino.jpg`,
  "focaccia-recco": `${STYLE_ROOT}/focaccia-recco.jpg`,
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

// Picsum fallback for slugs we don't have a curated photo for yet —
// keeps the homepage from rendering a broken image when a new city
// or style is added before the asset is sourced.
const PICSUM_FALLBACK = (seed) =>
  `https://picsum.photos/seed/${encodeURIComponent(seed)}/600/600`;

function getCityPhoto(slug) {
  return CITY_PHOTO_BY_SLUG[slug] || PICSUM_FALLBACK(`opm-city-${slug || "default"}`);
}

function getStylePhoto(slug) {
  return STYLE_PHOTO_BY_SLUG[slug] || PICSUM_FALLBACK(`opm-style-${slug || "default"}`);
}

module.exports = {
  HERO_PIZZA_PHOTOS,
  CITY_PHOTO_BY_SLUG,
  STYLE_PHOTO_BY_SLUG,
  getHeroPizzaPhotos,
  getCityPhoto,
  getStylePhoto,
};
