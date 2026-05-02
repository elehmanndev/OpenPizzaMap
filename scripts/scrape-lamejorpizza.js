#!/usr/bin/env node
// Scrape lamejorpizza.es — Primer Campeonato de Pizzas de España 2025.
//
// Pipeline:
//   1. Fetch home → 141 anchor URLs of the form
//      /es/participante/{id}/{venue-slug}[/{pizza-slug}]
//   2. Fetch each detail page (static HTML) → name, address parts,
//      lat/lng (from `mapInitPosition` JS literal), phone, hero image.
//   3. Render /es/ranking.php with Playwright (the award winners are
//      JS-loaded) → set of award-tier venue names.
//   4. Mark every scraped venue against (a) award list, (b) existing
//      DB rows (name+city), (c) "needs Google" otherwise.
//   5. For (c): Playwright + Google Maps → rating + review count.
//   6. Apply quality gate (any one passes):
//        - award_tier
//        - in_db (silent skip — importer dedupe handles)
//        - rating ≥ RATING_MIN AND reviews ≥ REVIEWS_MIN
//      Anything that fails: marked quality_pass=false with a reason.
//   7. Write lamejorpizza-scrape.json (all 141, tagged) + the skipped
//      list as a markdown file under notes/sessions/.
//
// Output is consumed by import-places.js via shape='lamejorpizza'
// (the importer filters on quality_pass === true).
//
// Total runtime is dominated by step 5 — ~5 s/venue × ~120 lookups,
// so plan ~10–15 min. Safe to re-run; detail-page fetches use a
// per-id cache (lamejorpizza-detail-cache.json) so re-runs only redo
// the Google calls for new/missing venues.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env.local') });
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { PrismaClient } = require('@prisma/client');

const ROOT = path.resolve(__dirname, '..');
const OUT_JSON = path.join(ROOT, 'lamejorpizza-scrape.json');
const OUT_SKIP = path.join(ROOT, 'notes', 'sessions', '2026-05-02-lamejorpizza-skipped.md');
const DETAIL_CACHE = path.join(ROOT, 'lamejorpizza-detail-cache.json');

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const FETCH_DELAY_MS = 600;          // home/detail static fetches
const GOOGLE_DELAY_MS = 800;         // between Google searches
const RATING_MIN = 4.3;
const REVIEWS_MIN = 100;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decodeEntities(s) {
    if (typeof s !== 'string') return s;
    return s
        .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&aacute;/g, 'á').replace(/&eacute;/g, 'é').replace(/&iacute;/g, 'í')
        .replace(/&oacute;/g, 'ó').replace(/&uacute;/g, 'ú').replace(/&ntilde;/g, 'ñ')
        .replace(/&Aacute;/g, 'Á').replace(/&Eacute;/g, 'É').replace(/&Iacute;/g, 'Í')
        .replace(/&Oacute;/g, 'Ó').replace(/&Uacute;/g, 'Ú').replace(/&Ntilde;/g, 'Ñ')
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

function norm(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

async function fetchHtml(url, attempt = 1) {
    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': UA,
                'Accept': 'text/html',
                'Referer': 'https://lamejorpizza.es/es/',
            },
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        return await res.text();
    } catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); return fetchHtml(url, attempt + 1); }
        throw e;
    }
}

function parseHomeUrls(html) {
    const re = /href="participante\/(\d+)\/([a-z0-9_-]+)(\/[a-z0-9_-]+)?"/gi;
    const seen = new Map();
    let m;
    while ((m = re.exec(html)) !== null) {
        const id = parseInt(m[1], 10);
        if (!seen.has(id)) {
            seen.set(id, {
                id,
                venueSlug: m[2],
                pizzaSlug: m[3] ? m[3].slice(1) : null,
            });
        }
    }
    return [...seen.values()];
}

function parseDetail(html, id) {
    const nameMatch = html.match(/restaurante-nombre">\s*([^<]+)/);
    const name = nameMatch ? decodeEntities(nameMatch[1]).trim() : null;

    const latMatch = html.match(/lat\s*:\s*(-?\d+\.\d+)/);
    const lngMatch = html.match(/lng\s*:\s*(-?\d+\.\d+)/);
    const lat = latMatch ? parseFloat(latMatch[1]) : null;
    const lng = lngMatch ? parseFloat(lngMatch[1]) : null;

    // Each `restaurante-dato-item-texto` div is one of: address, phone, email,
    // hours, etc. Order is not guaranteed; the address block is the first one
    // that has the <br>-separated 3-line shape.
    const blocks = [...html.matchAll(/restaurante-dato-item-texto"?>([\s\S]*?)<\/div>/gi)]
        .map((m) => m[1]);

    let street = null, city = null, postalCode = null, province = null, community = null;
    for (const b of blocks) {
        const lines = b
            .split(/<br\s*\/?>/i)
            .map((s) => decodeEntities(s.replace(/<[^>]+>/g, '').trim()))
            .filter(Boolean);
        // Line 2 of the address block looks like "City, 12345" — that's the
        // signature we use to identify it. Phone blocks have a single line.
        if (lines.length >= 2) {
            const m2 = lines[1].match(/^(.+?),\s*(\d{4,5})\s*$/);
            if (m2) {
                street = lines[0];
                city = m2[1].trim();
                postalCode = m2[2];
                if (lines[2]) {
                    const m3 = lines[2].match(/^(.+?)\s*\(([^)]+)\)\s*$/);
                    if (m3) { province = m3[1].trim(); community = m3[2].trim(); }
                    else province = lines[2];
                }
                break;
            }
        }
    }

    // Phone — first block whose plain text is mostly digits (8+).
    let phone = null;
    for (const b of blocks) {
        const t = decodeEntities(b.replace(/<[^>]+>/g, '').trim());
        if (/^[+\d][\d\s().-]{7,}$/.test(t)) { phone = t.replace(/\s+/g, ''); break; }
    }

    const heroMatch = html.match(/<img[^>]+src="(https:\/\/lamejorpizza\.es\/[^"]+)"[^>]*class="card-img-top"/i)
        || html.match(/<img[^>]+src="(https:\/\/lamejorpizza\.es\/html5Upload\/[^"]+)"/i);
    const heroImageUrl = heroMatch ? heroMatch[1] : null;

    return { id, name, street, city, postalCode, province, community, lat, lng, phone, heroImageUrl };
}

// Render ranking.php in Playwright and harvest every visible pizzeria name.
// Categories are JS-loaded so a plain curl returns only the wrapper.
async function fetchAwards(page) {
    await page.goto('https://lamejorpizza.es/es/ranking.php', {
        waitUntil: 'networkidle',
        timeout: 30000,
    });
    // Extra settle time — the ranking widgets stagger their loads.
    await page.waitForTimeout(3000);
    const html = await page.content();
    const names = new Set();
    const patterns = [
        /producto-item-nombre-restaurante">([^<]+)/g,
        /restaurante-nombre">\s*([^<]+)/g,
        /class="[^"]*nombre[^"]*">([^<]+)/g,
    ];
    for (const re of patterns) {
        let m;
        while ((m = re.exec(html)) !== null) {
            const n = decodeEntities(m[1]).trim();
            if (n && n.length >= 2) names.add(n);
        }
    }
    return names;
}

// Get a venue's Google rating + review count by searching Google Maps and
// reading the place panel. Returns { rating: number|null, reviews: number|null }.
async function googleRating(page, name, locationHint) {
    const q = `${name} ${locationHint || ''} pizza`.replace(/\s+/g, ' ').trim();
    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(q)}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    // Consent dismissal (covers ES/EN/DE locales).
    for (const sel of [
        'button[aria-label*="Accept"]',
        'button[aria-label*="Acepto"]',
        'form[action*="consent"] button',
    ]) {
        const b = await page.$(sel).catch(() => null);
        if (b) { await b.click().catch(() => {}); await sleep(400); break; }
    }
    await Promise.race([
        page.waitForSelector('div[role="img"][aria-label*="stars"]', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('a.hfpxzc', { timeout: 8000 }).catch(() => null),
        page.waitForSelector('button[data-item-id="address"]', { timeout: 8000 }).catch(() => null),
    ]);
    // If Google returned a list, click the first hit so the place panel opens.
    const first = await page.$('a.hfpxzc');
    if (first) {
        await first.click().catch(() => {});
        await page.waitForTimeout(1500);
    }

    let rating = null, reviews = null;

    // Rating — `<div role="img" aria-label="4.7 stars">` (en) or
    // `aria-label="4,7 estrellas"` (es). Be tolerant.
    const ratingNodes = await page.$$('div[role="img"][aria-label]');
    for (const node of ratingNodes) {
        const aria = await node.getAttribute('aria-label');
        if (!aria) continue;
        const m = aria.match(/^([\d.,]+)\s*(stars?|estrellas?)/i);
        if (m) { rating = parseFloat(m[1].replace(',', '.')); break; }
    }

    // Reviews — `<button aria-label="1.234 reviews">` etc., or text "(1,234)"
    // beside the rating in the place header. Try several patterns.
    const html = await page.content();
    const revPatterns = [
        /aria-label="([\d.,]+)\s*(reviews?|opiniones|valoraciones)/i,
        /aria-label="([\d.,]+)\s*(rese[ñn]as)/i,
        />\s*\(\s*([\d.,]+)\s*\)\s*<\/[a-z]+>[\s\S]{0,200}?(reviews?|opiniones|valoraciones|rese[ñn]as)/i,
    ];
    for (const re of revPatterns) {
        const m = html.match(re);
        if (m) {
            const raw = m[1].replace(/[.,\s]/g, '');
            const n = parseInt(raw, 10);
            if (Number.isFinite(n)) { reviews = n; break; }
        }
    }

    return { rating, reviews };
}

function loadJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return fallback; }
}

async function main() {
    console.log('[lmp] fetch home');
    const homeHtml = await fetchHtml('https://lamejorpizza.es/es/');
    const refs = parseHomeUrls(homeHtml);
    console.log(`[lmp] ${refs.length} venue URLs`);

    // Detail-page cache so re-runs are cheap.
    const cache = loadJson(DETAIL_CACHE, {});

    const venues = [];
    for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const url = `https://lamejorpizza.es/es/participante/${ref.id}/${ref.venueSlug}/${ref.pizzaSlug || ''}`.replace(/\/$/, '/');
        let v = cache[String(ref.id)];
        if (!v || !v.name) {
            const html = await fetchHtml(url);
            v = parseDetail(html, ref.id);
            v.detailUrl = url;
            v.signaturePizzaSlug = ref.pizzaSlug || null;
            cache[String(ref.id)] = v;
            fs.writeFileSync(DETAIL_CACHE, JSON.stringify(cache, null, 2));
            await sleep(FETCH_DELAY_MS);
        }
        venues.push(v);
        if ((i + 1) % 25 === 0) console.log(`[lmp] detail ${i + 1}/${refs.length}`);
    }
    console.log(`[lmp] ${venues.length} detail pages parsed`);

    // ----- browser for awards + Google -----
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    await context.addCookies([
        { name: 'CONSENT', value: 'YES+cb', domain: '.google.com', path: '/' },
        { name: 'SOCS', value: 'CAESHAgBEhJnd3NfMjAyMzA3MDQtMF9SQzIaAmVuIAEaBgiAqIaqBg', domain: '.google.com', path: '/' },
    ]);
    const page = await context.newPage();
    await page.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'image' || t === 'media' || t === 'font') return route.abort();
        return route.continue();
    });

    console.log('[lmp] fetch ranking.php (Playwright render)');
    let awardNames = new Set();
    try {
        awardNames = await fetchAwards(page);
        console.log(`[lmp] ${awardNames.size} unique award-tier names`);
    } catch (e) {
        console.warn(`[lmp] awards fetch failed: ${e.message} — proceeding with empty award set`);
    }

    // Mark award-tier (normalised name match against the harvested set).
    const awardNorms = new Set([...awardNames].map(norm));
    for (const v of venues) {
        v.award_tier = !!(v.name && awardNorms.has(norm(v.name)));
    }

    // ----- DB existence check -----
    const prisma = new PrismaClient();
    const existing = await prisma.place.findMany({
        where: { country: 'Spain', status: 'active' },
        select: { id: true, name: true, city: true },
    });
    const existingByName = new Map();
    for (const r of existing) {
        const k = norm(r.name);
        if (!existingByName.has(k)) existingByName.set(k, r);
    }
    for (const v of venues) {
        // Exact name match within Spain, OR LMP name starts with DB name + space
        // (chain disambiguation: DB "Infraganti" vs LMP "Infraganti Pizza Bar Alicante").
        const ln = norm(v.name);
        let hit = existingByName.get(ln);
        if (!hit) {
            for (const [dn, row] of existingByName) {
                if (dn.length >= 6 && (ln === dn || ln.startsWith(dn + ' '))) { hit = row; break; }
            }
        }
        v.in_db = !!hit;
        v.in_db_match = hit ? { id: hit.id, name: hit.name, city: hit.city } : null;
    }

    const awardCount = venues.filter((v) => v.award_tier).length;
    const inDbCount = venues.filter((v) => v.in_db && !v.award_tier).length;
    const needGoogle = venues.filter((v) => !v.award_tier && !v.in_db);
    console.log(`[lmp] award=${awardCount}  in_db=${inDbCount}  needGoogle=${needGoogle.length}`);

    // ----- Google rating gate -----
    for (let i = 0; i < needGoogle.length; i++) {
        const v = needGoogle[i];
        const hint = [v.city, v.province, 'Spain'].filter(Boolean).slice(0, 2).join(' ');
        try {
            const { rating, reviews } = await googleRating(page, v.name, hint);
            v.googleRating = rating;
            v.googleReviewCount = reviews;
            console.log(`[lmp] g ${i + 1}/${needGoogle.length}  ${v.name} (${v.city || '?'})  ${rating ?? 'n/a'}★  ${reviews ?? 'n/a'} reviews`);
        } catch (e) {
            v.googleRating = null;
            v.googleReviewCount = null;
            console.warn(`[lmp] g ${i + 1}/${needGoogle.length}  ${v.name} FAIL: ${e.message}`);
        }
        await sleep(GOOGLE_DELAY_MS);
    }

    // ----- apply gate -----
    for (const v of venues) {
        if (v.award_tier) {
            v.quality_pass = true; v.quality_reason = 'award';
        } else if (v.in_db) {
            v.quality_pass = false; v.quality_reason = `already-in-db (id=${v.in_db_match.id} ${v.in_db_match.name})`;
        } else if (v.googleRating != null && v.googleReviewCount != null
                   && v.googleRating >= RATING_MIN && v.googleReviewCount >= REVIEWS_MIN) {
            v.quality_pass = true;
            v.quality_reason = `${v.googleRating}★ × ${v.googleReviewCount} reviews`;
        } else {
            v.quality_pass = false;
            if (v.googleRating == null && v.googleReviewCount == null) v.quality_reason = 'no Google data';
            else if (v.googleRating != null && v.googleRating < RATING_MIN) v.quality_reason = `${v.googleRating}★ < ${RATING_MIN}`;
            else if (v.googleReviewCount != null && v.googleReviewCount < REVIEWS_MIN) v.quality_reason = `${v.googleReviewCount} reviews < ${REVIEWS_MIN}`;
            else v.quality_reason = 'gate fail';
        }
    }

    await browser.close();
    await prisma.$disconnect();

    fs.writeFileSync(OUT_JSON, JSON.stringify({
        scrapedAt: new Date().toISOString(),
        source: 'lamejorpizza',
        ratingThreshold: RATING_MIN,
        reviewsThreshold: REVIEWS_MIN,
        count: venues.length,
        passes: venues.filter((v) => v.quality_pass).length,
        skipped: venues.filter((v) => !v.quality_pass).length,
        places: venues,
    }, null, 2));

    // ----- skipped report -----
    const skipped = venues.filter((v) => !v.quality_pass);
    const lines = [];
    lines.push('# 2026-05-02 — lamejorpizza.es scrape: skipped venues');
    lines.push('');
    lines.push(`Scraped ${venues.length} venues from lamejorpizza.es. Quality gate (any of: award-tier, ≥${RATING_MIN}★ × ≥${REVIEWS_MIN} reviews on Google, already in DB) passed by ${venues.length - skipped.length}; ${skipped.length} did not.`);
    lines.push('');
    lines.push('Already-in-DB rows are skipped silently (the importer dedupe handles them). Rating-gate failures and "no Google data" rows are listed below for review.');
    lines.push('');
    const reasons = new Map();
    for (const v of skipped) reasons.set(v.quality_reason.split(' (')[0].split('★')[0], (reasons.get(v.quality_reason.split(' (')[0].split('★')[0]) || 0) + 1);
    lines.push('## Skip reason summary');
    lines.push('');
    for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) lines.push(`- **${n}** — ${r}`);
    lines.push('');
    const ratingFails = skipped.filter((v) => /^\d/.test(v.quality_reason));
    const noData = skipped.filter((v) => v.quality_reason === 'no Google data');
    const inDb = skipped.filter((v) => v.quality_reason.startsWith('already-in-db'));
    lines.push('## Rating-gate failures');
    lines.push('');
    lines.push('| LMP id | name | city | rating | reviews | reason |');
    lines.push('|---:|---|---|---:|---:|---|');
    for (const v of ratingFails.sort((a, b) => (b.googleRating || 0) - (a.googleRating || 0))) {
        lines.push(`| ${v.id} | ${(v.name || '').replace(/\|/g, '\\|')} | ${v.city || ''} | ${v.googleRating ?? ''} | ${v.googleReviewCount ?? ''} | ${v.quality_reason} |`);
    }
    lines.push('');
    lines.push('## No Google data found');
    lines.push('');
    lines.push('| LMP id | name | city |');
    lines.push('|---:|---|---|');
    for (const v of noData) lines.push(`| ${v.id} | ${(v.name || '').replace(/\|/g, '\\|')} | ${v.city || ''} |`);
    lines.push('');
    lines.push('## Already in DB (silent skips)');
    lines.push('');
    lines.push('| LMP id | LMP name | city | matched DB row |');
    lines.push('|---:|---|---|---|');
    for (const v of inDb) lines.push(`| ${v.id} | ${(v.name || '').replace(/\|/g, '\\|')} | ${v.city || ''} | id=${v.in_db_match.id} ${v.in_db_match.name} |`);
    lines.push('');
    fs.mkdirSync(path.dirname(OUT_SKIP), { recursive: true });
    fs.writeFileSync(OUT_SKIP, lines.join('\n'));

    console.log(`[done] passed=${venues.length - skipped.length} skipped=${skipped.length}`);
    console.log(`[done] JSON   → ${path.relative(ROOT, OUT_JSON)}`);
    console.log(`[done] skips  → ${path.relative(ROOT, OUT_SKIP)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
