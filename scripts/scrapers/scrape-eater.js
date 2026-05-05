#!/usr/bin/env node
// Scrape Eater "best pizza" city map pages.
// Eater (Vox Media) ships full venue data in <script id="__NEXT_DATA__">,
// reachable at props.pageProps.hydration.responses[*].data.node.mapPoints.
// Each entry has name, address, location.{latitude,longitude}, phone, url,
// description blurb, and image URL — no geocoding needed.
//
// We use a project-identifying UA. Eater's robots.txt blocks specific AI
// crawlers (ClaudeBot, GPTBot, anthropic-ai) but lets generic agents read
// /maps/. We respect the spirit by going slow (2s delay) and only pulling
// city-list pages we'd otherwise read by hand.

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../lib/bootstrap');

const OUT = path.join(PATHS.scrapes, 'eater-scrape.json');
const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const DELAY_MS = 2000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// City pages found from eater.com/pizza topic page on 2026-04-26.
// Each page has a city-specific style hint we tag onto venues.
const CITY_PAGES = [
  { url: 'https://chicago.eater.com/maps/best-chicago-pizza-restaurants',                            cityHint: 'Chicago',             style: null },
  { url: 'https://chicago.eater.com/maps/best-chicago-thin-crust-pizza-restaurants-tavern-style',    cityHint: 'Chicago',             style: 'chicago' },
  { url: 'https://chicago.eater.com/maps/best-deep-dish-pizza-restaurants-chicago',                  cityHint: 'Chicago',             style: 'chicago' },
  { url: 'https://chicago.eater.com/maps/best-detroit-pizza-chicago-squares',                        cityHint: 'Chicago',             style: 'detroit' },
  { url: 'https://detroit.eater.com/maps/detroit-style-square-pizza-best-restaurants',               cityHint: 'Detroit',             style: 'detroit' },
  { url: 'https://la.eater.com/maps/best-pizza-restaurants-los-angeles-map-guide',                   cityHint: 'Los Angeles',         style: null },
  { url: 'https://miami.eater.com/maps/miami-best-pizza-guide-map',                                  cityHint: 'Miami',               style: null },
  { url: 'https://pdx.eater.com/maps/portland-oregon-best-pizza-pizzerias',                          cityHint: 'Portland',            style: null },
  { url: 'https://phoenix.eater.com/maps/best-pizza-restaurants-slices-phoenix-arizona',             cityHint: 'Phoenix',             style: null },
  { url: 'https://twincities.eater.com/maps/best-pizza-minneapolis-st-paul-twin-cities',             cityHint: 'Minneapolis',         style: null },
  { url: 'https://austin.eater.com/maps/best-pizza-austin-pizzerias-restaurants',                    cityHint: 'Austin',              style: null },
  { url: 'https://dallas.eater.com/maps/best-pizza-places-dallas-restaurants',                       cityHint: 'Dallas',              style: null },
  { url: 'https://london.eater.com/maps/best-pizza-london',                                          cityHint: 'London',              style: null },
];

async function fetchHtml(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3) { await sleep(2000 * attempt); return fetchHtml(url, attempt + 1); }
    throw e;
  }
}

function findMapPoints(obj) {
  // Walk the __NEXT_DATA__ tree until we hit an array whose elements have
  // both `name` and `location.latitude`. Eater nests these under
  // hydration.responses[N].data.node.mapPoints, but the index N varies.
  if (Array.isArray(obj)) {
    if (obj.length && obj[0] && typeof obj[0] === 'object'
        && obj[0].name && obj[0].location && typeof obj[0].location.latitude === 'number') {
      return obj;
    }
    for (const x of obj) {
      const r = findMapPoints(x);
      if (r) return r;
    }
  } else if (obj && typeof obj === 'object') {
    for (const k of Object.keys(obj)) {
      const r = findMapPoints(obj[k]);
      if (r) return r;
    }
  }
  return null;
}

function extractImage(ledeMedia) {
  if (!ledeMedia || typeof ledeMedia !== 'object') return null;
  // Vox Chorus LedeMediaImageType shape:
  //   ledeMedia.image.thumbnails.{horizontal|square|vertical}.url
  // The horizontal crop is the most useful for a card hero image.
  if (ledeMedia.__typename === 'LedeMediaImageType' && ledeMedia.image) {
    const t = ledeMedia.image.thumbnails;
    if (t) {
      if (t.horizontal && t.horizontal.url) return t.horizontal.url;
      if (t.square && t.square.url) return t.square.url;
      if (t.vertical && t.vertical.url) return t.vertical.url;
    }
    if (ledeMedia.image.url) return ledeMedia.image.url;
  }
  // Embed types (Instagram, YouTube) have no static image we can pull —
  // they require the third-party SDK to render. Skip.
  if (ledeMedia.__typename === 'LedeMediaEmbedType') return null;
  // Fallback: try the obvious flat shapes in case Vox added another type.
  if (typeof ledeMedia.url === 'string') return ledeMedia.url;
  if (ledeMedia.image && typeof ledeMedia.image.url === 'string') return ledeMedia.image.url;
  if (ledeMedia.asset && typeof ledeMedia.asset.url === 'string') return ledeMedia.asset.url;
  return null;
}

function blurbFromDescription(description) {
  if (!Array.isArray(description) || description.length === 0) return null;
  const first = description.find(d => d && typeof d.plaintext === 'string');
  return first ? first.plaintext.trim() : null;
}

(async () => {
  const all = [];
  let okPages = 0, failPages = 0;
  for (const cfg of CITY_PAGES) {
    try {
      console.log(`[fetch] ${cfg.url}`);
      const html = await fetchHtml(cfg.url);
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
      if (!m) { console.warn('  no __NEXT_DATA__'); failPages++; await sleep(DELAY_MS); continue; }
      const data = JSON.parse(m[1]);
      const points = findMapPoints(data);
      if (!points) { console.warn('  no mapPoints'); failPages++; await sleep(DELAY_MS); continue; }
      console.log(`  ${points.length} venues`);
      okPages++;
      for (let i = 0; i < points.length; i++) {
        const p = points[i];
        all.push({
          source_url: cfg.url,
          city_hint: cfg.cityHint,
          style_hint: cfg.style,
          rank: i + 1,
          name: p.name || null,
          address: p.address || null,
          phone: p.phone || null,
          website: p.url || null,
          lat: p.location && typeof p.location.latitude === 'number' ? p.location.latitude : null,
          lng: p.location && typeof p.location.longitude === 'number' ? p.location.longitude : null,
          venue_slug: p.venue && p.venue.slug || null,
          venue_title: p.venue && p.venue.title || null,
          blurb: blurbFromDescription(p.description),
          image: extractImage(p.ledeMedia),
        });
      }
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
      failPages++;
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    scrapedAt: new Date().toISOString(),
    source: 'eater',
    pages: CITY_PAGES.length,
    pagesOk: okPages,
    pagesFailed: failPages,
    count: all.length,
    places: all,
  }, null, 2));
  const withCoords = all.filter(p => p.lat != null).length;
  console.log(`[done] ${all.length} venues across ${okPages}/${CITY_PAGES.length} pages → ${path.relative(ROOT, OUT)}`);
  console.log(`[stats] with-coords=${withCoords}`);
})().catch(e => { console.error(e); process.exit(1); });
