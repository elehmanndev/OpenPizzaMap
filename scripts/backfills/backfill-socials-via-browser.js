#!/usr/bin/env node
// Fill Place.instagramUrl / Place.facebookUrl by opening each place's website
// in CloakBrowser, waiting for JS render to settle, then sweeping the DOM
// for instagram.com / facebook.com URLs.
//
// This is what `compass/crawler-google-places` does for its `scrapeContacts`
// add-on (verified 30% hit rate on a 10-place sample, 2026-05-24). The edge
// over our older [from-website] backfill is *always* using a browser, not
// just on native-fetch failure — modern restaurant sites (Squarespace, Wix,
// Square, business.site, React) lazy-load social icons in JS after
// domcontentloaded, so a native fetch returns 200 with an empty footer.
//
// Tradeoffs vs the older backfills:
//   + JS-rendered DOM → catches lazy-loaded footers (compass's edge)
//   + Tries contact subpages when homepage misses
//   + Token-overlap filter rejects sponsor / association pages
//     (Squarespace defaults, AVPN.JAPAN, payment processor links, etc.)
//   - Slower: ~5-8s per place (browser nav + JS settle)
//   - Requires websiteUrl; no-website rows still need [via-search]
//
// Usage:
//   node scripts/backfills/backfill-socials-via-browser.js                     # dry run
//   node scripts/backfills/backfill-socials-via-browser.js --apply
//   node scripts/backfills/backfill-socials-via-browser.js --apply --limit=50
//   node scripts/backfills/backfill-socials-via-browser.js --apply --country=Italy
//   node scripts/backfills/backfill-socials-via-browser.js --apply --ids=1,2,3
//
// Requires `cloakbrowser` installed in opm-runner (see [[reference_cloakbrowser]]).

const { prisma } = require('../lib/bootstrap');
const { normalizeName, sleep, AGGREGATOR_HOSTS } = require('../lib/utils');

const BROWSER_TIMEOUT_MS = 30000;
const JS_SETTLE_MS = 2500;        // matches the from-website browser-fallback
const POLITE_DELAY_MS = 800;
const MAX_HTML_BYTES = 1_500_000;

// Subpaths to try if the homepage yields no socials. Footers usually carry
// them, but a dedicated contact page is the most reliable place. Stop on
// first hit. Order = English first then most-common Romance variants since
// Italy + Spain are our priority geos.
const CONTACT_SUBPATHS = ['/contact', '/contact-us', '/contatti', '/contacto', '/about', '/chi-siamo', '/quienes-somos'];

// Path segments that are never a venue's own profile.
const IG_PATH_BLOCKLIST = new Set([
    'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'about',
    'developer', 'directory', 'legal', 'privacy', 'terms', 'share',
    'stories', 'web', 'squarespace',
]);
const FB_PATH_BLOCKLIST = new Set([
    'sharer', 'sharer.php', 'dialog', 'plugins', 'tr', 'tr.php',
    'login', 'login.php', 'recover', 'help', 'policies', 'privacy',
    'about', 'careers', 'business', 'pages', 'groups', 'events',
    'watch', 'gaming', 'marketplace', 'fundraisers', 'reel',
    'photo.php', 'permalink.php', 'squarespace',
]);

function normalizeInstagram(href) {
    let u;
    try { u = new URL(href, 'https://example.com'); } catch { return null; }
    if (!/(^|\.)instagram\.com$/i.test(u.hostname) && !/(^|\.)instagr\.am$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const handle = seg[0].toLowerCase();
    if (IG_PATH_BLOCKLIST.has(handle)) return null;
    if (!/^[a-z0-9_.]{1,30}$/i.test(handle)) return null;
    return `https://instagram.com/${handle}`;
}

function normalizeFacebook(href) {
    let u;
    try { u = new URL(href, 'https://example.com'); } catch { return null; }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname) && !/(^|\.)fb\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const first = seg[0].toLowerCase();
    if (FB_PATH_BLOCKLIST.has(first)) return null;
    if (first === 'pages' && seg.length >= 3 && /^\d+$/.test(seg[seg.length - 1])) {
        return `https://facebook.com/${seg[1]}-${seg[seg.length - 1]}`.toLowerCase();
    }
    if (first === 'profile.php') return null;
    if (!/^[a-z0-9._-]{1,64}$/i.test(first)) return null;
    return `https://facebook.com/${first}`;
}

// Two-direction token check used to weed out sponsor / association pages
// (AVPN.JAPAN, verapizzanapoletana, association-style links in restaurant
// footers). Compass returned these as raw matches on our 10-row test.
//
// Accept if the social handle shares any 4+ char alphanumeric token with
// EITHER the venue name OR the website domain. Either signal is enough —
// some pizzeria names are too short or generic (e.g. "Lucali") and we'd
// reject their real handle if we only checked the name.
function handleMatches(handle, name, websiteUrl) {
    if (!handle) return false;
    const lower = handle.toLowerCase().replace(/[._-]/g, '');
    const nameTokens = normalizeName(name || '').split(/\s+/).filter(t => t.length >= 4);
    let domainTokens = [];
    try {
        const host = new URL(websiteUrl).hostname.replace(/^www\./, '');
        domainTokens = host.split('.')[0].split(/[-_]/).filter(t => t.length >= 4);
    } catch { /* ignore */ }
    const all = [...nameTokens, ...domainTokens];
    if (!all.length) return true; // can't safely check — accept
    return all.some(t => lower.includes(t.toLowerCase()));
}

// Pulls every IG / FB URL out of an HTML chunk. Same approach as compass:
// indiscriminate regex sweep across the whole DOM (anchors + text), then
// normalize + dedupe.
function extractCandidates(html) {
    const URL_RE = /\bhttps?:\/\/(?:www\.|m\.|business\.|l\.|web\.)?(?:instagram|instagr\.am|facebook|fb)\.com\/[^\s"'<>)]+/gi;
    const seen = new Set();
    const igs = [];
    const fbs = [];
    let m;
    while ((m = URL_RE.exec(html)) !== null) {
        const cleaned = m[0].replace(/[.,);\]]+$/, '');
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        const ig = normalizeInstagram(cleaned);
        if (ig) { igs.push(ig); continue; }
        const fb = normalizeFacebook(cleaned);
        if (fb) fbs.push(fb);
    }
    return { igs, fbs };
}

// Pick the most-frequent handle from candidates (matches the
// from-website heuristic — venues link their handle 3-4× in header +
// footer + meta tags, vs one-off collaborator mentions). Then apply
// the token-match filter as a final sanity check.
function pickBest(candidates, name, websiteUrl) {
    if (!candidates.length) return null;
    const counts = new Map();
    for (const v of candidates) counts.set(v, (counts.get(v) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // Try matched candidates in frequency order first; if none match,
    // fall back to the most-frequent candidate. That fallback is the
    // right call for venues with very short / generic names where the
    // token check is too strict (Lucali, etc.).
    for (const [url] of sorted) {
        const handle = url.split('/').pop();
        if (handleMatches(handle, name, websiteUrl)) return { url, matched: true };
    }
    return { url: sorted[0][0], matched: false };
}

// Bonus: harvest mailto: emails. We don't have a Place.email column yet,
// but logging means we'll know what's available if/when we add one.
function extractEmails(html) {
    const out = new Set();
    const MAILTO_RE = /mailto:([^"'<>?\s]+)/gi;
    let m;
    while ((m = MAILTO_RE.exec(html)) !== null) {
        const e = m[1].trim().toLowerCase();
        if (/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(e)) out.add(e);
    }
    return [...out];
}

async function makeBrowser() {
    let browser, page, unavailable = null;
    return {
        async getPage() {
            if (unavailable) throw new Error(unavailable);
            if (!browser) {
                let cb;
                try { cb = await import('cloakbrowser'); }
                catch (e) {
                    unavailable = `cloakbrowser not installed (docker exec opm-runner npm install --no-save cloakbrowser) — ${e.message}`;
                    throw new Error(unavailable);
                }
                browser = await cb.launch();
                page = await browser.newPage();
            }
            return page;
        },
        async close() {
            if (browser) await browser.close().catch(() => {});
            browser = null; page = null;
        },
    };
}

async function fetchViaBrowser(browser, url) {
    try {
        const p = await browser.getPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await p.waitForTimeout(JS_SETTLE_MS).catch(() => {});
        const html = await p.content();
        return { ok: true, html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html };
    } catch (e) {
        return { ok: false, error: e.name || 'browser-error' };
    }
}

// Builds the candidate URL list: homepage first, then up to N contact
// subpaths derived from the website's origin. Tries them in order and
// short-circuits the moment we have both IG and FB filled (or both
// fields needed are already covered).
function buildUrlsToTry(websiteUrl) {
    const urls = [websiteUrl];
    let origin;
    try { origin = new URL(websiteUrl).origin; } catch { return urls; }
    for (const sub of CONTACT_SUBPATHS) urls.push(origin + sub);
    return urls;
}

async function harvest(browser, place) {
    const urls = buildUrlsToTry(place.websiteUrl);
    let bestIg = null, bestFb = null;
    const emailsFound = new Set();
    let lastError = null;
    let pagesTried = 0;

    for (const url of urls) {
        // Short-circuit: if we already have both fields, stop crawling
        // subpaths. Saves ~5s per page * 7 subpaths in the happy path.
        const needIg = !place.instagramUrl && !bestIg;
        const needFb = !place.facebookUrl && !bestFb;
        if (!needIg && !needFb) break;

        const res = await fetchViaBrowser(browser, url);
        pagesTried++;
        if (!res.ok) { lastError = res.error; continue; }

        const { igs, fbs } = extractCandidates(res.html);
        for (const e of extractEmails(res.html)) emailsFound.add(e);

        if (needIg && igs.length) {
            const pick = pickBest(igs, place.name, place.websiteUrl);
            if (pick) bestIg = pick;
        }
        if (needFb && fbs.length) {
            const pick = pickBest(fbs, place.name, place.websiteUrl);
            if (pick) bestFb = pick;
        }
    }

    return {
        ig: bestIg,
        fb: bestFb,
        emails: [...emailsFound],
        pagesTried,
        lastError,
    };
}

function parseArgs(argv) {
    const out = { apply: false, ids: null, limit: null, country: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
        else if (eq('country')) out.country = eq('country');
    }
    return out;
}

async function run({ apply = false, ids = null, limit = null, country = null } = {}) {
    let where;
    if (ids) where = { id: { in: ids } };
    else {
        where = {
            isVisible: true,
            websiteUrl: { not: null },
            OR: [{ instagramUrl: null }, { facebookUrl: null }],
        };
        if (country) where.country = country;
    }
    const all = await prisma.place.findMany({
        where,
        select: { id: true, name: true, city: true, country: true, websiteUrl: true, instagramUrl: true, facebookUrl: true },
        orderBy: [{ id: 'asc' }],
    });
    const places = limit ? all.slice(0, limit) : all;
    console.log(`[browser-socials] ${places.length} candidates (apply=${apply}${country ? ` country=${country}` : ''})`);

    const browser = await makeBrowser();
    let igFound = 0, fbFound = 0, igFilled = 0, fbFilled = 0;
    let skipAgg = 0, errors = 0;
    const emailLog = []; // [{id, name, emails:[]}] — we don't store yet

    for (const p of places) {
        let url = p.websiteUrl;
        if (!url) continue;
        if (AGGREGATOR_HOSTS.test(url)) { skipAgg++; continue; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
        const place = { ...p, websiteUrl: url };

        let result;
        try { result = await harvest(browser, place); }
        catch (e) { errors++; console.log(`  [${p.id}] ${p.name} — harvest error: ${e.message.slice(0, 80)}`); await sleep(POLITE_DELAY_MS); continue; }

        if (result.emails.length) emailLog.push({ id: p.id, name: p.name, emails: result.emails });

        if (!result.ig && !result.fb) {
            console.log(`  [${p.id}] ${p.name} — no socials after ${result.pagesTried} page(s)${result.lastError ? ` (${result.lastError})` : ''}`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }

        const bits = [];
        const patch = {};
        if (result.ig && !p.instagramUrl) {
            patch.instagramUrl = result.ig.url;
            igFound++;
            bits.push(`IG=${result.ig.url}${result.ig.matched ? '' : ' (no-name-match)'}`);
        }
        if (result.fb && !p.facebookUrl) {
            patch.facebookUrl = result.fb.url;
            fbFound++;
            bits.push(`FB=${result.fb.url}${result.fb.matched ? '' : ' (no-name-match)'}`);
        }
        console.log(`  [${p.id}] ${p.name} — ${bits.join(' ')}`);

        if (apply && Object.keys(patch).length) {
            await prisma.place.update({ where: { id: p.id }, data: patch }).catch((e) => {
                console.warn(`    update failed: ${e.message.slice(0, 80)}`);
            });
            if (patch.instagramUrl) igFilled++;
            if (patch.facebookUrl) fbFilled++;
        }

        await sleep(POLITE_DELAY_MS);
    }

    await browser.close();

    console.log('');
    console.log(`[browser-socials] done. total=${places.length} ig=${igFound} fb=${fbFound} skipAgg=${skipAgg} errors=${errors}`);
    if (emailLog.length) console.log(`[browser-socials] emails harvested for ${emailLog.length} venues (not stored — no Place.email column yet)`);
    if (apply) console.log(`[browser-socials] applied: instagramUrl=${igFilled} facebookUrl=${fbFilled}`);
    else       console.log(`[browser-socials] DRY RUN — re-run with --apply to write.`);

    return { ok: true, igFound, fbFound, igFilled, fbFilled, skipAgg, errors, emailLog, total: places.length };
}

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}
