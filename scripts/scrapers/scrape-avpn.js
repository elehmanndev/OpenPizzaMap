#!/usr/bin/env node
// Scrape AVPN (Associazione Verace Pizza Napoletana) certified pizzerias.
// Listing: https://www.pizzanapoletana.org/it/associati  (~860 server-rendered rows)
// Per-place detail page contains street address, phone, website, hero image,
// and a Google Maps embed iframe whose URL has lat/lng inline (2d<lng>!3d<lat>).
// Output: avpn-scrape.json at repo root, consumed by scripts/import-places.js.

const fs = require('fs');
const path = require('path');
const { PATHS } = require('../lib/bootstrap');

const OUT = path.join(PATHS.scrapes, 'avpn-scrape.json');
const LISTING_URL = 'https://www.pizzanapoletana.org/it/associati';
const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';

const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  if (i === -1) return null;
  const n = parseInt(args[i + 1], 10);
  return Number.isFinite(n) ? n : null;
})();
const CONCURRENCY = 4;
const DELAY_MS = 250;

// ---- HTML helpers ----
function decodeEntities(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&agrave;/g, 'à').replace(/&egrave;/g, 'è').replace(/&igrave;/g, 'ì')
    .replace(/&ograve;/g, 'ò').replace(/&ugrave;/g, 'ù')
    .replace(/&eacute;/g, 'é').replace(/&aacute;/g, 'á').replace(/&iacute;/g, 'í')
    .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ').replace(/&ccedil;/g, 'ç')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]+>/g, ''));
}

function collapseWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

async function fetchHtml(url, attempt = 1) {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } catch (e) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return fetchHtml(url, attempt + 1);
    }
    throw e;
  }
}

// ---- listing parser ----
// Each data row looks like:
//   <tr>
//     <td>2</td>
//     <td><a href="https://www.pizzanapoletana.org/it/associati/113-...slug... " class="text-danger"><strong>Name</strong></a></td>
//     <td>City</td><td>Province</td><td>Region</td><td>Country</td><td>Continent</td>
//   </tr>
function parseListing(html) {
  const rows = [];
  const trRe = /<tr>\s*<td>\s*(\d+)\s*<\/td>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const memberNumber = parseInt(m[1], 10);
    const detailUrl = m[2].trim();
    const name = collapseWs(stripTags(m[3]));
    const city = collapseWs(stripTags(m[4]));
    const province = collapseWs(stripTags(m[5]));
    const region = collapseWs(stripTags(m[6]));
    const country = collapseWs(stripTags(m[7]));
    const continent = collapseWs(stripTags(m[8]));
    // Slug from URL: /associati/<id>-<slug>
    const slugMatch = detailUrl.match(/\/associati\/(\d+)-([^/?# ]+)/);
    const detailId = slugMatch ? slugMatch[1] : String(memberNumber);
    const slug = slugMatch ? slugMatch[2] : '';
    rows.push({ memberNumber, detailId, slug, detailUrl, name, city, province, region, country, continent });
  }
  return rows;
}

// ---- detail parser ----
function parseDetail(html) {
  const out = {
    addressLine: null, postalCode: null, cityFull: null, regionFull: null, countryFull: null,
    phone: null, fax: null, email: null, website: null,
    heroImageUrl: null, lat: null, lng: null,
    memberSince: null,
  };

  // Address block: <p>\tStreet, N,\n<...> postal city region / country<br>
  // Robust approach: capture the <p> right after <h4>Contatti</h4> + <hr>.
  const contattiMatch = html.match(/<h4>\s*Contatti[\s\S]*?<\/h4>\s*<hr[^>]*>\s*<p>([\s\S]*?)<\/p>/i);
  if (contattiMatch) {
    const block = stripTags(contattiMatch[1]).replace(/\s+/g, ' ').trim();
    // Block looks like: "Piazza Carità, 2, 80134 Napoli Campania / Italia"
    // Split at " / " to separate country.
    const parts = block.split('/').map(s => s.trim()).filter(Boolean);
    out.countryFull = parts.length > 1 ? parts[parts.length - 1] : null;
    const left = parts[0] || block;
    // Pull a postal code (first 5-digit run) and split there.
    const pcMatch = left.match(/\b(\d{4,6})\b/);
    if (pcMatch) {
      out.postalCode = pcMatch[1];
      out.addressLine = collapseWs(left.slice(0, pcMatch.index).replace(/[,\s]+$/, ''));
      // Tail after postal: "Napoli Campania" → city, region (heuristic: last token = region)
      const tail = collapseWs(left.slice(pcMatch.index + pcMatch[1].length));
      const tailTokens = tail.split(/\s+/).filter(Boolean);
      if (tailTokens.length >= 2) {
        out.regionFull = tailTokens[tailTokens.length - 1];
        out.cityFull = tailTokens.slice(0, -1).join(' ');
      } else if (tailTokens.length === 1) {
        out.cityFull = tailTokens[0];
      }
    } else {
      out.addressLine = left;
    }
  }

  // Phone / fax / website
  const phoneMatch = html.match(/Tel:\s*([+0-9 .\-/()]+)/i);
  if (phoneMatch) out.phone = collapseWs(phoneMatch[1]).replace(/\s+/g, '');
  const faxMatch = html.match(/Fax:\s*([+0-9 .\-/()]+)/i);
  if (faxMatch) out.fax = collapseWs(faxMatch[1]).replace(/\s+/g, '');
  const webMatch = html.match(/<a\s+href="(https?:\/\/[^"]+)"[^>]*target="_blank"[^>]*>\s*www\./i);
  if (webMatch) out.website = webMatch[1];

  // Hero image: first /public/assoc/ image
  const heroMatch = html.match(/<img[^>]+src="(https:\/\/www\.pizzanapoletana\.org\/public\/assoc\/[^"]+)"/i);
  if (heroMatch) out.heroImageUrl = heroMatch[1];

  // Coords from Google Maps embed iframe: !2d<lng>!3d<lat>
  const embedMatch = html.match(/google\.com\/maps\/embed\?[^"]*?!2d(-?\d+\.\d+)!3d(-?\d+\.\d+)/);
  if (embedMatch) {
    out.lng = parseFloat(embedMatch[1]);
    out.lat = parseFloat(embedMatch[2]);
  }

  // Member since: "Associato dal 28/09/1984"
  const sinceMatch = html.match(/Associato\s+dal\s*<\/?[^>]*>?\s*([0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4})/i);
  if (sinceMatch) out.memberSince = sinceMatch[1];

  return out;
}

// ---- runner ----
async function pmap(items, n, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: String(e.message || e) };
      }
      done++;
      if (done % 25 === 0 || done === items.length) {
        process.stdout.write(`\r[detail] ${done}/${items.length}   `);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }
  await Promise.all(Array.from({ length: n }, worker));
  process.stdout.write('\n');
  return results;
}

(async () => {
  console.log(`[listing] fetching ${LISTING_URL}`);
  const listingHtml = await fetchHtml(LISTING_URL);
  const rows = parseListing(listingHtml);
  console.log(`[listing] parsed ${rows.length} rows`);
  if (rows.length === 0) { console.error('No rows parsed — bailing.'); process.exit(1); }

  let work = rows;
  if (LIMIT) work = work.slice(0, LIMIT);

  console.log(`[detail] fetching ${work.length} detail pages (concurrency=${CONCURRENCY}, delay=${DELAY_MS}ms)`);
  const details = await pmap(work, CONCURRENCY, async (row) => {
    const html = await fetchHtml(row.detailUrl);
    return parseDetail(html);
  });

  const places = work.map((row, i) => ({
    ...row,
    name: decodeEntities(row.name),
    city: decodeEntities(row.city),
    province: decodeEntities(row.province),
    region: decodeEntities(row.region),
    country: decodeEntities(row.country),
    detail: details[i] && !details[i].__error ? {
      ...details[i],
      addressLine: details[i].addressLine ? decodeEntities(details[i].addressLine) : null,
      cityFull: details[i].cityFull ? decodeEntities(details[i].cityFull) : null,
    } : null,
    detailError: details[i] && details[i].__error ? details[i].__error : null,
  }));

  const withCoords = places.filter(p => p.detail && p.detail.lat != null && p.detail.lng != null).length;
  const withAddress = places.filter(p => p.detail && p.detail.addressLine).length;
  const failed = places.filter(p => p.detailError).length;

  fs.writeFileSync(OUT, JSON.stringify({ scrapedAt: new Date().toISOString(), source: 'avpn', count: places.length, places }, null, 2));
  console.log(`[done] wrote ${places.length} → ${path.relative(ROOT, OUT)}`);
  console.log(`[stats] with-coords=${withCoords} with-address=${withAddress} fetch-failed=${failed}`);
})().catch(e => { console.error(e); process.exit(1); });
