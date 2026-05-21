#!/usr/bin/env node
// Scrape gamberorosso.it — `/cerca/` search index, filtered to pizza categories.
//
// Source URL (Eric-supplied 2026-05-21):
//   https://www.gamberorosso.it/cerca/?type=locali
//     &categoria_locali=pizza-a-taglio,pizza-a-taglio-rosticcerie-take-away,pizzeria
//     &sort=relevance
//
// This is Gambero Rosso's full Italian search index for pizza-categorised
// venues — ~1,008 entries as of recon. Broader than the curated
// `Pizzerie d'Italia 2026` guide (~255–800), so coverage includes both
// awarded (Spicchi) and non-awarded pizzerias, plus pizza-a-taglio.
//
// Pipeline:
//   1. Playwright load → wait through the Cloudflare interstitial.
//   2. Click "Carica altri" (load-more) until the button vanishes or the
//      tile count stops growing. Voxel paginates 12 at a time.
//   3. Extract each `.ts-preview` tile via DOM:
//        detailUrl, slug, category (pizzeria | pizza-a-taglio | …),
//        name, description (teaser), city, province, spicchiTier (1/2/3).
//      Dedupe by detailUrl.
//   4. DB existence check (norm(name) within Italy) → mark `in_db`. Skip
//      the Google call for in-DB rows: the importer's fill-only dedupe
//      inherits new fields without needing fresh coords.
//   5. For everything else: GoogleApiProvider.findPlace(name, city, 'Italy')
//      → lat/lng + formattedAddress + phone. Google Photos are NOT taken
//      into the JSON (24h URL expiry); the enrichment cron picks them up
//      later from the same 90-day EnrichmentCache row.
//   6. Write data/scrapes/gambero-rosso-scrape.json.
//
// Output is consumed by import-places.js via shape='gamberoRosso'.
//
// Runtime budget: ~3 min pagination + ~13 min Google enrichment (1008 × 0.8s
// polite, less in_db skips). The GoogleApiProvider 90-day cache makes
// re-runs almost free.

const fs = require('fs');
const path = require('path');
const { prisma, ROOT, PATHS } = require('../lib/bootstrap');
const { decodeEntities } = require('../lib/utils');
const { getProvider } = require(path.join(ROOT, 'src', 'services', 'enrichment', 'providers'));

// CloakBrowser is required: Cloudflare's Voxel-AJAX gate on gamberorosso.it
// returns 403 to plain Playwright even with stealth flags + UA spoofing
// (verified 2026-05-21 across multiple approaches). CloakBrowser's
// source-patched Chromium is the only free option we found that gets a
// 200 on the load-more AJAX. ~535MB binary cached at ~/.cloakbrowser/ on
// first run; subsequent runs reuse it.
//
// ESM-only package, so we dynamic-import it from this CommonJS file. No
// fallback to vanilla Playwright — without CloakBrowser we get only ~13
// tiles (the SSR first page) instead of 1000+.
async function loadCloakBrowser() {
    const cb = await import('cloakbrowser');
    return cb.launch;
}

const OUT_JSON = path.join(PATHS.scrapes, 'gambero-rosso-scrape.json');
const SEARCH_URL = 'https://www.gamberorosso.it/cerca/?type=locali&categoria_locali=pizza-a-taglio,pizza-a-taglio-rosticcerie-take-away,pizzeria&sort=relevance';
const GOOGLE_DELAY_MS = 800;

const LIMIT = (() => {
    const i = process.argv.indexOf('--limit');
    if (i === -1) return null;
    const n = parseInt(process.argv[i + 1], 10);
    return Number.isFinite(n) ? n : null;
})();
const MAX_PAGES = (() => {
    const i = process.argv.indexOf('--max-pages');
    if (i === -1) return 200; // safe cap; 1008/12 ≈ 84 clicks
    const n = parseInt(process.argv[i + 1], 10);
    return Number.isFinite(n) ? n : 200;
})();
const SKIP_GOOGLE = process.argv.includes('--no-google');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function norm(s) {
    return String(s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

// Click "Carica altri" until either the button disappears (last page),
// the tile count stops growing for 3 attempts (stall), or we hit MAX_PAGES.
async function loadAll(page, { maxClicks }) {
    let lastCount = 0;
    let stall = 0;
    for (let i = 0; i < maxClicks; i++) {
        const currentCount = await page.evaluate(
            () => document.querySelectorAll('.ts-preview[data-post-id]').length,
        );
        if (currentCount > lastCount) {
            stall = 0;
            lastCount = currentCount;
        } else if (i > 0) {
            stall++;
            if (stall >= 3) break;
        }
        if ((i % 5) === 0 || stall > 0) {
            console.log(`[gr] click ${i}: tiles=${currentCount} stall=${stall}`);
        }
        // Find the visible load-more button and click it. Use evaluate to
        // bypass element-pointer interception by sticky widgets.
        const clicked = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.ts-load-more, a.ts-load-more')]
                .find((el) => el.offsetParent !== null);
            if (!btn) return false;
            btn.scrollIntoView({ block: 'center' });
            btn.click();
            return true;
        });
        if (!clicked) {
            console.log(`[gr] no more load-more button visible at click ${i}`);
            break;
        }
        // Wait for AJAX response to render new tiles. Voxel typically takes
        // ~700ms; pad to 1500ms for slow renders.
        await page.waitForTimeout(1500);
    }
    const finalCount = await page.evaluate(
        () => document.querySelectorAll('.ts-preview[data-post-id]').length,
    );
    console.log(`[gr] pagination done: ${finalCount} tiles`);
    return finalCount;
}

async function extractTiles(page) {
    return page.evaluate(() => {
        const previews = document.querySelectorAll('.ts-preview[data-post-id]');
        return [...previews].map((el) => {
            const link = el.querySelector('a[href*="/luoghi/locali/"]');
            const detailUrl = link ? link.getAttribute('href') : null;
            // Slug + category from URL: .../luoghi/locali/{category}/{slug}
            let slug = null, category = null;
            if (detailUrl) {
                const m = detailUrl.match(/\/luoghi\/locali\/([^/]+)\/([^/?#]+)/);
                if (m) { category = m[1]; slug = m[2]; }
            }
            // Spicchi tier — SVG inside `.punteggio` has a <title> like "pizzeria-2".
            // pizza-a-taglio uses a different icon (pala, rotelle); ignore non-pizzeria tiers.
            const tierTitle = el.querySelector('.punteggio svg title')?.textContent?.trim() || '';
            const tierMatch = tierTitle.match(/(\d+)/);
            const spicchiTier = tierMatch ? parseInt(tierMatch[1], 10) : null;

            // The wrapping <a> contains all the content widgets in this fixed
            // order inside its second child container:
            //   text-editor[0] = name
            //   text-editor[1] = description teaser (trailing "Login" for anon)
            //   heading        = category label (e.g. "Pizzeria")
            //   text-editor[2] = location "a {City} ({PV})"
            const wrapAnchor = el.querySelector('a.elementor-element[href*="/luoghi/locali/"]');
            const root = wrapAnchor || el;
            const textWidgets = [...root.querySelectorAll('.elementor-widget-text-editor')]
                .map((w) => (w.textContent || '').trim());

            const name = textWidgets[0] || null;
            let description = textWidgets[1] || null;
            if (description) {
                // Strip the trailing "Login" sentinel and the ellipsis Gambero
                // Rosso uses to fade the locked content.
                description = description.replace(/\s*Login\s*$/i, '').replace(/[……]+$/, '').trim();
            }
            const locText = textWidgets[2] || null;
            let city = null, province = null;
            if (locText) {
                // "a Desenzano del Garda (BS)" → city = "Desenzano del Garda", province = "BS"
                const lm = locText.match(/^\s*(?:a\s+)?(.+?)\s*\(([A-Z]{2})\)\s*$/);
                if (lm) { city = lm[1].trim(); province = lm[2]; }
            }
            return {
                postId: el.getAttribute('data-post-id'),
                detailUrl, slug, category,
                name, description, city, province, spicchiTier,
            };
        });
    });
}

async function main() {
    console.log('[gr] launch CloakBrowser');
    const launch = await loadCloakBrowser();
    const browser = await launch();
    const page = await browser.newPage();

    console.log(`[gr] goto ${SEARCH_URL}`);
    await page.goto(SEARCH_URL, { waitUntil: 'networkidle', timeout: 60000 });
    // Cloudflare clearance happens on the initial nav under CloakBrowser, but
    // give Voxel's JS time to bind the load-more handler before we click.
    await page.waitForTimeout(5000);

    if (LIMIT) {
        // For a quick smoke run we don't need full pagination — just one
        // click cycle so we have ~24 tiles to work with.
        await loadAll(page, { maxClicks: 3 });
    } else {
        await loadAll(page, { maxClicks: MAX_PAGES });
    }

    let venues = await extractTiles(page);
    await browser.close();

    // Dedupe by detailUrl (a tile can render twice during AJAX refresh).
    const byUrl = new Map();
    for (const v of venues) {
        if (!v.detailUrl) continue;
        if (!byUrl.has(v.detailUrl)) byUrl.set(v.detailUrl, v);
    }
    venues = [...byUrl.values()];
    console.log(`[gr] ${venues.length} unique tiles after dedupe`);

    if (LIMIT) {
        venues = venues.slice(0, LIMIT);
        console.log(`[gr] --limit ${LIMIT} applied`);
    }

    // ---- DB existence check ----
    const existing = await prisma.place.findMany({
        where: { country: 'Italy', status: 'active' },
        select: { id: true, name: true, city: true },
    });
    const existingByName = new Map();
    for (const r of existing) {
        const k = norm(r.name);
        if (!existingByName.has(k)) existingByName.set(k, r);
    }
    for (const v of venues) {
        const ln = norm(v.name);
        let hit = existingByName.get(ln);
        if (!hit) {
            // Chain disambiguation: DB row "Pepe in Grani" vs scrape with city suffix.
            for (const [dn, row] of existingByName) {
                if (dn.length >= 6 && (ln === dn || ln.startsWith(dn + ' '))) { hit = row; break; }
            }
        }
        v.in_db = !!hit;
        v.in_db_match = hit ? { id: hit.id, name: hit.name, city: hit.city } : null;
    }

    const inDbCount = venues.filter((v) => v.in_db).length;
    // Google-enrich EVERY parseable venue — including in_db ones. This costs
    // ~200 extra calls for the existing-DB overlap (cached after first run,
    // so re-runs are free) but ensures the importer attaches a PlaceSource
    // tag for "this venue is in Gambero Rosso" on already-imported rows.
    // Without it, lat/lng=null would cause the importer to skip them
    // entirely (see line ~778 of import-places.js — `if (p.lat == null) continue`).
    const needsGoogle = venues.filter((v) => v.name && v.city);
    const unparseable = venues.filter((v) => !v.name || !v.city);
    console.log(`[gr] in_db=${inDbCount}  needGoogle=${needsGoogle.length}  unparseable=${unparseable.length}`);

    // ---- Google Places enrichment ----
    // Writes a checkpoint JSON every 100 venues so a process abort doesn't
    // lose progress. The GoogleApiProvider's DB cache makes re-runs of
    // already-enriched venues effectively free.
    function writeCheckpoint() {
        const partialPasses = venues.filter((v) => v.in_db || (v.lat != null && v.lng != null)).length;
        fs.writeFileSync(OUT_JSON, JSON.stringify({
            scrapedAt: new Date().toISOString(),
            source: 'gamberorosso',
            sourceUrl: SEARCH_URL,
            count: venues.length,
            passes: partialPasses,
            inDb: inDbCount,
            partial: true,
            places: venues,
        }, null, 2));
    }
    if (!SKIP_GOOGLE && needsGoogle.length) {
        if (!process.env.GOOGLE_MAPS_API_KEY) {
            console.warn('[gr] GOOGLE_MAPS_API_KEY not set — skipping Google enrichment');
        } else {
            const provider = getProvider({ prisma, override: 'google_api' });
            for (let i = 0; i < needsGoogle.length; i++) {
                const v = needsGoogle[i];
                try {
                    const r = await provider.findPlace(v.name, v.city, 'Italy');
                    if (r) {
                        v.lat = r.lat;
                        v.lng = r.lng;
                        v.formattedAddress = r.formattedAddress || null;
                        v.phone = r.phone || null;
                        v.websiteUrl = r.websiteUrl || null;
                        v.googlePlaceId = r.googlePlaceId || null;
                        v.googleMapsUrl = r.googleMapsUrl || null;
                    } else {
                        v.lat = null; v.lng = null;
                    }
                } catch (e) {
                    console.warn(`[gr] google fail ${v.name}: ${e.message}`);
                    v.lat = null; v.lng = null;
                    v.google_error = e.message;
                }
                if ((i + 1) % 25 === 0 || i + 1 === needsGoogle.length) {
                    console.log(`[gr] google ${i + 1}/${needsGoogle.length}`);
                }
                if ((i + 1) % 100 === 0) {
                    writeCheckpoint();
                    console.log(`[gr] checkpoint saved @ ${i + 1}/${needsGoogle.length}`);
                }
                await sleep(GOOGLE_DELAY_MS);
            }
            await provider.close();
        }
    }

    await prisma.$disconnect();

    const passes = venues.filter((v) => v.in_db || (v.lat != null && v.lng != null)).length;
    fs.writeFileSync(OUT_JSON, JSON.stringify({
        scrapedAt: new Date().toISOString(),
        source: 'gamberorosso',
        sourceUrl: SEARCH_URL,
        count: venues.length,
        passes,
        inDb: inDbCount,
        places: venues,
    }, null, 2));
    console.log(`[done] tiles=${venues.length} pass=${passes} in_db=${inDbCount}`);
    console.log(`[done] → ${path.relative(ROOT, OUT_JSON)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
