#!/usr/bin/env node
// Resolve googlePlaceId for the no-Google long-tail by scraping Google Maps
// directly. The runner's standard `resolve` phase calls the Places API via
// findPlace(name, city, country) — that signature has already failed for
// the 73 rows targeted here. Maps frontend search is more forgiving: it
// accepts richer queries (full street address + country) and ranks by
// geographic proximity, so it sometimes hits venues the API misses.
//
// Pipeline per row:
//   1. Build query: "<name>, <addressLine>" — full address-aware
//   2. Navigate https://www.google.com/maps/search/?api=1&query=<encoded>
//   3. Let Maps JS settle (~4s). If query matched a single venue, Maps
//      redirects to a place detail page; if multiple/no match it shows
//      a results list (we treat that as a miss for now).
//   4. Extract the placeId by scanning rendered HTML for the standard
//      ChIJ[20-30 base64-url chars] pattern. Page references it many
//      times in embedded JSON; most-frequent wins.
//   5. Verify via the same multi-signal scorer as backfill-socials-multi-
//      source.js — name in og:title (+1), city in page (+1), website host
//      in page (+1), phone digits (+1). Score 0 rejects.
//
// On verified hit: write googlePlaceId + bump enrichmentVersion to
// PIPELINE_VERSION (1) so the row joins the normal queue for photos /
// opmRating / gallery scrape on subsequent runner ticks.
//
// Surfaces MISSED list at end with [hide-candidate] flag where applicable
// — rows where Maps showed no result are likely junk imports or closed.
//
// Usage:
//   node scripts/backfills/backfill-placeid-via-maps.js                  # dry run
//   node scripts/backfills/backfill-placeid-via-maps.js --apply
//   node scripts/backfills/backfill-placeid-via-maps.js --apply --ids=280,312
//   node scripts/backfills/backfill-placeid-via-maps.js --apply --limit=10

const { prisma } = require('../lib/bootstrap');
const { normalizeName, sleep } = require('../lib/utils');

const BROWSER_TIMEOUT_MS = 30000;
const MAPS_SETTLE_MS = 4000;        // Maps JS is heavier than knowledge panel
const VERIFY_SETTLE_MS = 2500;
const POLITE_DELAY_MS = 1500;       // between venues — Maps rate-limit cushion
const MAX_HTML_BYTES = 2_000_000;

// Standard Google placeId: starts with ChIJ (most common) or GhIJ / similar
// prefix, followed by 20–30 base64-url-safe characters. Hex-like FIDs
// (0x[hex]:0x[hex]) are intentionally NOT matched — those need conversion
// to be useful in our pipeline.
const PLACE_ID_RE = /\b(ChIJ[A-Za-z0-9_-]{20,30})\b/g;

const OG_META_RE = /<meta\s+[^>]*property\s*=\s*["']og:([a-z_]+)["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
function extractOgTags(html) {
    const out = {};
    let m;
    OG_META_RE.lastIndex = 0;
    while ((m = OG_META_RE.exec(html)) !== null) out[m[1]] = decodeHtml(m[2]);
    return out;
}
function decodeHtml(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
}

async function makeBrowser() {
    let browser, page, unavailable = null, consentDismissed = false;
    return {
        async getPage() {
            if (unavailable) throw new Error(unavailable);
            if (!browser) {
                let cb;
                try { cb = await import('cloakbrowser'); }
                catch (e) {
                    unavailable = `cloakbrowser not installed — ${e.message}`;
                    throw new Error(unavailable);
                }
                browser = await cb.launch();
                page = await browser.newPage();
            }
            return page;
        },
        async dismissConsentOnce() {
            if (consentDismissed || !page) return;
            consentDismissed = true;
            for (const sel of [
                'button[aria-label*="Accept"]', 'button[aria-label*="Acepto"]',
                'button[aria-label*="Aceptar"]', 'button[aria-label*="Accetta"]',
                'button[aria-label*="Accepter"]', 'button[aria-label*="Akzeptieren"]',
                'form[action*="consent"] button', 'button:has-text("Accept all")',
            ]) {
                const btn = await page.$(sel).catch(() => null);
                if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1000).catch(() => {}); return; }
            }
        },
        async close() { if (browser) await browser.close().catch(() => {}); browser = null; page = null; },
    };
}

async function fetchPage(browser, url, settleMs) {
    try {
        const p = await browser.getPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await browser.dismissConsentOnce();
        await p.waitForTimeout(settleMs).catch(() => {});
        const html = await p.content();
        const finalUrl = p.url();
        return { ok: true, html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html, finalUrl };
    } catch (e) {
        return { ok: false, error: e.name || 'browser-error' };
    }
}

// Pull every placeId from the rendered Maps page. The primary venue is
// referenced many times in embedded JSON; most-frequent wins. Returns null
// if Maps showed a results list (no single primary) or no place at all.
function extractPlaceId(html, finalUrl) {
    const counts = new Map();
    let m;
    PLACE_ID_RE.lastIndex = 0;
    while ((m = PLACE_ID_RE.exec(html)) !== null) {
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    if (!counts.size) return null;

    // Heuristic: if Maps redirected to a single place, the top placeId
    // appears >= 5× (typical place page has dozens of references). If it
    // shows a results list, top placeId appears 1-3× and there are many
    // distinct placeIds with similar counts.
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const [topId, topN] = sorted[0];
    const distinct = sorted.length;

    // Detect the multi-result case: many distinct placeIds, low top count.
    // The threshold is empirical — calibrate after first runs if needed.
    const isSingleVenue = topN >= 5 || (distinct <= 3 && topN >= 2);
    if (!isSingleVenue) return { placeId: topId, confidence: 'low', distinct, topN };

    return { placeId: topId, confidence: 'high', distinct, topN };
}

// Multi-signal verification — open the place_id URL, score against DB.
// Mirrors the verifier in backfill-socials-multi-source.js but applied
// to a Maps place page instead of an IG/FB profile.
async function verifyPlaceId(browser, placeId, place) {
    const verifyUrl = `https://www.google.com/maps/place/?q=place_id:${placeId}`;
    const res = await fetchPage(browser, verifyUrl, VERIFY_SETTLE_MS);
    if (!res.ok) return { ok: false, score: 0, signals: { error: res.error } };

    const og = extractOgTags(res.html);
    const title = (og.title || '').toLowerCase();
    const desc = (og.description || '').toLowerCase();
    const htmlLower = res.html.toLowerCase();
    const signals = { ogTitle: og.title?.slice(0, 80) };
    let score = 0;

    // Name in og:title
    const nameTokens = normalizeName(place.name || '').split(/\s+/).filter(t => t.length >= 4);
    if (nameTokens.length) {
        const titleNorm = normalizeName(title);
        if (nameTokens.some(t => titleNorm.includes(t))) { score++; signals.nameMatch = true; }
    }

    // City in page
    if (place.city && place.city.length >= 4) {
        const cityLower = place.city.toLowerCase();
        if (htmlLower.includes(cityLower) || desc.includes(cityLower)) {
            score++; signals.cityMatch = true;
        }
    }

    // Address line — chunk through it and look for any 6+ char token in the page
    if (place.addressLine) {
        const addrTokens = place.addressLine.toLowerCase().split(/[\s,]+/).filter(t => t.length >= 6);
        if (addrTokens.some(t => htmlLower.includes(t))) {
            score++; signals.addressMatch = true;
        }
    }

    // Country — weak but useful for chain disambiguation
    if (place.country && htmlLower.includes(place.country.toLowerCase())) {
        score++; signals.countryMatch = true;
    }

    return { ok: true, score, signals };
}

async function resolveOne(browser, place) {
    const q = [place.name, place.addressLine].filter(Boolean).join(', ');
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
    const res = await fetchPage(browser, url, MAPS_SETTLE_MS);
    if (!res.ok) return { error: res.error };

    const extracted = extractPlaceId(res.html, res.finalUrl);
    if (!extracted) return { missing: true };

    const verify = await verifyPlaceId(browser, extracted.placeId, place);
    return {
        placeId: extracted.placeId,
        confidence: extracted.confidence,
        topN: extracted.topN,
        distinct: extracted.distinct,
        verify,
    };
}

function parseArgs(argv) {
    const out = { apply: false, ids: null, limit: null };
    for (const a of argv) {
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
    }
    return out;
}

const PIPELINE_VERSION = 1;

async function run({ apply = false, ids = null, limit = null } = {}) {
    const where = ids
        ? { id: { in: ids } }
        : { isVisible: true, googlePlaceId: null };
    const all = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, addressLine: true, city: true, country: true,
            websiteUrl: true, phone: true, lat: true, lng: true,
        },
        orderBy: { id: 'asc' },
    });
    const places = limit ? all.slice(0, limit) : all;
    console.log(`[maps-placeid] ${places.length} candidates (apply=${apply})`);

    const browser = await makeBrowser();
    const stats = { hit: 0, hitWeak: 0, rejected: 0, miss: 0, errors: 0, filled: 0 };
    const missList = [];   // [{id, name, city, country, reason}]
    const weakList = [];   // [{id, name, placeId, score, signals}]

    for (const p of places) {
        let r;
        try { r = await resolveOne(browser, p); }
        catch (e) {
            stats.errors++;
            console.log(`  [${p.id}] ${p.name} — error: ${e.message.slice(0, 80)}`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }

        if (r.error) {
            stats.errors++;
            console.log(`  [${p.id}] ${p.name} — fetch error: ${r.error}`);
            await sleep(POLITE_DELAY_MS); continue;
        }

        if (r.missing) {
            stats.miss++;
            missList.push({ id: p.id, name: p.name, city: p.city, country: p.country, reason: 'no-placeid-in-results' });
            console.log(`  [${p.id}] ${p.name} — Maps returned no placeId (results list or no match)`);
            await sleep(POLITE_DELAY_MS); continue;
        }

        const v = r.verify || {};
        if (v.score <= 0) {
            stats.rejected++;
            missList.push({ id: p.id, name: p.name, city: p.city, country: p.country, reason: `verify-rejected (got: ${v.signals?.ogTitle || 'no title'})` });
            console.log(`  [${p.id}] ${p.name} — rejected ${r.placeId} score=${v.score} title="${v.signals?.ogTitle || ''}"`);
            await sleep(POLITE_DELAY_MS); continue;
        }

        const signalsList = Object.entries(v.signals || {})
            .filter(([k, val]) => val && k !== 'ogTitle')
            .map(([k]) => k.replace('Match', ''))
            .join('+');
        console.log(`  [${p.id}] ${p.name} — ${r.placeId} confidence=${r.confidence} score=${v.score} (${signalsList})`);

        if (v.score === 1) {
            stats.hitWeak++;
            weakList.push({ id: p.id, name: p.name, placeId: r.placeId, score: v.score, signals: signalsList });
        } else {
            stats.hit++;
        }

        if (apply) {
            try {
                await prisma.place.update({
                    where: { id: p.id },
                    data: {
                        googlePlaceId: r.placeId,
                        googlePlaceUrl: `https://www.google.com/maps/place/?q=place_id:${r.placeId}`,
                        enrichmentVersion: PIPELINE_VERSION,
                        enrichedAt: new Date(),
                    },
                });
                stats.filled++;
            } catch (e) {
                console.warn(`    update failed (${e.code || 'unknown'}): ${e.message.slice(0, 80)}`);
                if (e.code === 'P2002') {
                    // Unique constraint — another row already owns this placeId.
                    // That's a dup of an existing row we already enriched.
                    console.warn(`    → DUP-CONFLICT: placeId already exists on another row`);
                }
            }
        }

        await sleep(POLITE_DELAY_MS);
    }

    await browser.close();

    console.log('');
    console.log(`[maps-placeid] done. total=${places.length} hit=${stats.hit} weak=${stats.hitWeak} rejected=${stats.rejected} miss=${stats.miss} errors=${stats.errors}`);
    if (apply) console.log(`[maps-placeid] applied: googlePlaceId set on ${stats.filled} rows`);
    else       console.log(`[maps-placeid] DRY RUN — re-run with --apply to write.`);

    if (missList.length) {
        console.log('');
        console.log(`[maps-placeid] === UNRESOLVED (${missList.length}) — Maps couldn't pin them ===`);
        for (const m of missList) {
            console.log(`  #${m.id} ${m.name} — ${m.city}, ${m.country} [${m.reason}]`);
        }
        console.log(`  → likely candidates for hide-places.js or manual patch-place.js`);
    }
    if (weakList.length) {
        console.log('');
        console.log(`[maps-placeid] === WEAK (${weakList.length}) — score=1, eyeball before trusting ===`);
        for (const w of weakList) {
            console.log(`  #${w.id} ${w.name} — placeId=${w.placeId} (matched: ${w.signals})`);
        }
    }

    return { ok: true, ...stats, total: places.length, missList, weakList };
}

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}
