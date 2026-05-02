#!/usr/bin/env node
// Scrape 50 Top Pizza ranking pages (Italy + Europe + others).
// Each ranking is a single static HTML page with N venue cards. Per card:
//   <a href="/referenza/<slug>/" id="scheda">
//     <img src="<hero>" />
//     <div class="testo-card">
//       <h2 class="posizione...">1°</h2>
//       <h3 class="titolo...">Name</h3>
//       <span class="descrizione...">City<br/>Region</span>
//     </div>
//   </a>
//
// No address / phone / coords on either ranking or /referenza/ pages — we
// hand off to Nominatim via the importer's geocode path.
//
// Output: 50toppizza-scrape.json at repo root.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '50toppizza-scrape.json');
const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const DELAY_MS = 1500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Ranking pages — Italy/Europe focus. Country is the geographic scope of the
// list, NOT the per-venue country (Europe 2024 has venues from many countries
// — those need to be inferred from the city/region or geocoded out).
//
// Both standard ranking pages and the article-format "Excellent Pizzerias"
// list use the same `<a id="scheda" href="…/referenza/…">` card markup.
// Difference: ranked cards have descLine1=city + descLine2=region|country
// (br-separated); Excellent cards have descLine1="city, country" on a single
// line (no rank, no descLine2). The parser detects the comma form and splits.
const RANKINGS = [
  // Most recent Italia ranking served by the homepage
  { url: 'https://www.50toppizza.it/50-top-pizza-italia-2024/', scope: 'italy',  defaultCountry: 'Italy',  year: 2024, listName: 'Italia 2024' },
  { url: 'https://www.50toppizza.it/50-top-italia-2023',         scope: 'italy',  defaultCountry: 'Italy',  year: 2023, listName: 'Italia 2023' },
  { url: 'https://www.50toppizza.it/50-top-europe-2025/',        scope: 'europe', defaultCountry: null,     year: 2025, listName: 'Europe 2025' },
  { url: 'https://www.50toppizza.it/50-top-pizza-europa-2025-excellent-pizzerias/', scope: 'europe', defaultCountry: null, year: 2025, listName: 'Europe 2025 Excellent Pizzerias' },
  { url: 'https://www.50toppizza.it/50-top-europe-2024/',        scope: 'europe', defaultCountry: null,     year: 2024, listName: 'Europe 2024' },
  { url: 'https://www.50toppizza.it/50-top-europa-2023/',        scope: 'europe', defaultCountry: null,     year: 2023, listName: 'Europe 2023' },
  { url: 'https://www.50toppizza.it/italian-special-awards-2023/', scope: 'italy',  defaultCountry: 'Italy',  year: 2023, listName: 'Italian Special Awards 2023' },
  { url: 'https://www.50toppizza.it/european-special-awards-2023/', scope: 'europe', defaultCountry: null,    year: 2023, listName: 'European Special Awards 2023' },
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

function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&agrave;/g, 'à').replace(/&egrave;/g, 'è').replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò').replace(/&ugrave;/g, 'ù')
    .replace(/&eacute;/g, 'é').replace(/&aacute;/g, 'á').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ').replace(/&ccedil;/g, 'ç')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function parseRanking(html) {
  // Each card is an <a id="scheda" href="/referenza/<slug>/" ...>...<h3>name</h3>...<span>city<br/>region</span>...</a>
  // Some Europe pages drop the second span line (region missing); some have country instead of region in the tail.
  const out = [];
  const cardRe = /<a [^>]*href="(https?:\/\/www\.50toppizza\.it\/referenza\/[^"]+)"[^>]*id="scheda"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = cardRe.exec(html)) !== null) {
    const detailUrl = m[1];
    const inner = m[2];
    const imgMatch = inner.match(/<img[^>]+src="([^"]+)"/i);
    const posMatch = inner.match(/<h2[^>]*posizione[^>]*>([\s\S]*?)<\/h2>/i);
    const nameMatch = inner.match(/<h3[^>]*titolo[^>]*>([\s\S]*?)<\/h3>/i);
    const descMatch = inner.match(/<span[^>]*descrizione[^>]*>([\s\S]*?)<\/span>/i);
    if (!nameMatch) continue;
    const name = decodeEntities(nameMatch[1].replace(/<[^>]+>/g, '').trim());
    const posRaw = posMatch ? decodeEntities(posMatch[1].replace(/<[^>]+>/g, '').trim()) : '';
    // posizione is "1°", "2°", "47°" — sometimes "n.c." or text. Parse the first integer if present.
    const rankNum = (posRaw.match(/(\d+)/) || [])[1];
    // descrizione has city + <br/> + region OR city + <br/> + country
    let descLines = [];
    if (descMatch) {
      descLines = descMatch[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .split('\n')
        .map(s => decodeEntities(s.replace(/<[^>]+>/g, '').trim()))
        .filter(Boolean);
    }
    let descLine1 = descLines[0] || null;
    let descLine2 = descLines[1] || null;
    // "Excellent Pizzerias" pages use a single comma-separated line:
    // "Tirana, Albania" instead of "Tirana<br>Albania". Split so the
    // downstream importer's normalize50TopPizza can read country from
    // descLine2 like the ranked-page case.
    if (descLine1 && !descLine2 && descLine1.includes(',')) {
      const parts = descLine1.split(',').map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        descLine1 = parts[0];
        descLine2 = parts.slice(1).join(', ');
      }
    }
    out.push({
      detailUrl,
      name,
      rank: rankNum ? parseInt(rankNum, 10) : null,
      rankRaw: posRaw || null,
      descLine1,
      descLine2,
      heroImageUrl: imgMatch ? imgMatch[1] : null,
    });
  }
  return out;
}

(async () => {
  const all = [];
  let okPages = 0, failPages = 0;
  for (const cfg of RANKINGS) {
    try {
      console.log(`[fetch] ${cfg.listName} ← ${cfg.url}`);
      const html = await fetchHtml(cfg.url);
      const cards = parseRanking(html);
      console.log(`  ${cards.length} cards parsed`);
      okPages++;
      for (const c of cards) {
        all.push({
          source_url: cfg.url,
          list_name: cfg.listName,
          list_scope: cfg.scope,
          list_year: cfg.year,
          default_country: cfg.defaultCountry,
          ...c,
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
    source: '50toppizza',
    pages: RANKINGS.length,
    pagesOk: okPages,
    pagesFailed: failPages,
    count: all.length,
    places: all,
  }, null, 2));
  console.log(`[done] ${all.length} venues across ${okPages}/${RANKINGS.length} pages → ${path.relative(ROOT, OUT)}`);
})().catch(e => { console.error(e); process.exit(1); });
