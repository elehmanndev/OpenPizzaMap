#!/usr/bin/env node
// Multi-source cascade backfill for Place.instagramUrl / Place.facebookUrl.
//
// The 2026-05-24 Apify A/B run revealed that compass/crawler-google-places —
// the gold-standard Maps scraper at $0.006/place — only reads the venue's
// own website for socials, just like our older from-website backfill. That's
// why both compass and our scraper returned zero socials for Italian
// pizzerias whose websites don't link IG/FB: the data ISN'T on those
// websites at all, regardless of how good the JS rendering is.
//
// Eric pointed out that the socials are right there on Google's knowledge
// panel (the right-side card on a plain search like "Svario Pizza Bar") AND
// on the venue's TripAdvisor page — both rich aggregator surfaces compass
// doesn't read. This script reads them.
//
// Cascade order (richest surface first, fall back on miss):
//   1. Google knowledge panel  — plain `?q=<name> <city>` (no `site:` filter).
//      Pulls IG/FB from the "Profiles" widget that Google Business Profile
//      owners fill in. Works even for venues with no website.
//   2. TripAdvisor venue page  — when we have `tripadvisorUrl`. TA's sidebar
//      lists the venue's own socials.
//   3. Venue website           — homepage + contact subpaths, same technique
//      as backfill-socials-via-browser.js. The floor; works when neither
//      Google nor TA has anything.
//
// Stops as soon as both IG and FB are filled (or the surface chain is
// exhausted). Fill-only — never overwrites existing values.
//
// Usage:
//   node scripts/backfills/backfill-socials-multi-source.js                   # dry run
//   node scripts/backfills/backfill-socials-multi-source.js --apply
//   node scripts/backfills/backfill-socials-multi-source.js --apply --limit=20 --country=Italy
//   node scripts/backfills/backfill-socials-multi-source.js --apply --ids=1,2,3
//
// Requires cloakbrowser in opm-runner (see [[reference_cloakbrowser]]).

const { prisma } = require('../lib/bootstrap');
const { normalizeName, sleep } = require('../lib/utils');

const BROWSER_TIMEOUT_MS = 30000;
const JS_SETTLE_GOOGLE_MS = 2500;   // knowledge panel renders later than the main SERP
const JS_SETTLE_TA_MS = 2000;
const JS_SETTLE_SITE_MS = 2500;
const POLITE_DELAY_MS = 1000;       // between venues — Google rate-limit cushion
const MAX_HTML_BYTES = 1_800_000;

const SITE_SUBPATHS = ['/contact', '/contact-us', '/contatti', '/contacto', '/about', '/chi-siamo', '/quienes-somos'];

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
    'photo.php', 'permalink.php', 'squarespace', 'tripadvisor',
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

// Two-direction token check — accept handle if it shares a 4+ char token
// with the venue name OR the website domain. Catches "Lucali" style short
// names (matches via domain) and rejects sponsor / certification pages
// (AVPN.JAPAN, etc.) that share no tokens with the venue.
function handleMatches(handle, name, websiteUrl) {
    if (!handle) return false;
    const lower = handle.toLowerCase().replace(/[._-]/g, '');
    const nameTokens = normalizeName(name || '').split(/\s+/).filter(t => t.length >= 4);
    let domainTokens = [];
    try {
        const host = new URL(websiteUrl).hostname.replace(/^www\./, '');
        domainTokens = host.split('.')[0].split(/[-_]/).filter(t => t.length >= 4);
    } catch { /* no website — name match only */ }
    const all = [...nameTokens, ...domainTokens];
    if (!all.length) return true; // very short / generic name — can't safely filter
    return all.some(t => lower.includes(t.toLowerCase()));
}

// Pulls every IG/FB URL out of an HTML chunk + decodes Google's /url?q=
// redirector when present (knowledge panel often wraps anchors that way).
function extractCandidates(html) {
    const seen = new Set();
    const igs = [];
    const fbs = [];

    // Direct social URLs anywhere in the HTML (anchors, data attrs, JSON-LD,
    // plain text).
    const URL_RE = /\bhttps?:\/\/(?:www\.|m\.|business\.|l\.|web\.)?(?:instagram|instagr\.am|facebook|fb)\.com\/[^\s"'<>)]+/gi;
    let m;
    while ((m = URL_RE.exec(html)) !== null) {
        addCandidate(m[0], seen, igs, fbs);
    }

    // Google's redirector — /url?q=https%3A%2F%2Finstagram.com%2F...&sa=...
    const REDIR_RE = /\/url\?(?:[^"'<>\s]*?&)?q=([^&"'<>\s]+)/gi;
    while ((m = REDIR_RE.exec(html)) !== null) {
        let decoded;
        try { decoded = decodeURIComponent(m[1]); } catch { continue; }
        if (/instagram\.com|facebook\.com|fb\.com|instagr\.am/i.test(decoded)) {
            addCandidate(decoded, seen, igs, fbs);
        }
    }

    return { igs, fbs };
}

function addCandidate(rawUrl, seen, igs, fbs) {
    const cleaned = rawUrl.replace(/[.,);\]]+$/, '');
    if (seen.has(cleaned)) return;
    seen.add(cleaned);
    const ig = normalizeInstagram(cleaned);
    if (ig) { igs.push(ig); return; }
    const fb = normalizeFacebook(cleaned);
    if (fb) fbs.push(fb);
}

// Most-frequent handle wins (venues link themselves repeatedly across
// header/footer/meta). Token-match acts as a sanity tiebreaker for ties
// and for ambiguous SERP returns. Returns { url, matched: bool } or null.
function pickBest(candidates, name, websiteUrl) {
    if (!candidates.length) return null;
    const counts = new Map();
    for (const v of candidates) counts.set(v, (counts.get(v) || 0) + 1);
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [url] of sorted) {
        const handle = url.split('/').pop();
        if (handleMatches(handle, name, websiteUrl)) return { url, matched: true };
    }
    // Token check rejected everything — fall back to highest-frequency,
    // flagged so callers can decide whether to trust it. In practice this
    // happens for very short venue names ("Lucali") where the domain check
    // would have caught it but we have no website.
    return { url: sorted[0][0], matched: false };
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
                'button[aria-label*="Accept"]',
                'button[aria-label*="Acepto"]',
                'button[aria-label*="Aceptar"]',
                'button[aria-label*="Accetta"]',
                'button[aria-label*="Accepter"]',
                'button[aria-label*="Akzeptieren"]',
                'form[action*="consent"] button',
                'button:has-text("Accept all")',
            ]) {
                const btn = await page.$(sel).catch(() => null);
                if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(1000).catch(() => {}); return; }
            }
        },
        async close() {
            if (browser) await browser.close().catch(() => {});
            browser = null; page = null;
        },
    };
}

async function fetchPage(browser, url, settleMs) {
    try {
        const p = await browser.getPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await browser.dismissConsentOnce();
        await p.waitForTimeout(settleMs).catch(() => {});
        const html = await p.content();
        return { ok: true, html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html };
    } catch (e) {
        return { ok: false, error: e.name || 'browser-error' };
    }
}

// SURFACE 1: Google knowledge panel.
async function tryGoogle(browser, place) {
    const q = `${place.name} ${place.city || ''}`.trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=en`;
    const res = await fetchPage(browser, url, JS_SETTLE_GOOGLE_MS);
    if (!res.ok) return { ig: null, fb: null, err: res.error };
    const { igs, fbs } = extractCandidates(res.html);
    return {
        ig: igs.length ? pickBest(igs, place.name, place.websiteUrl) : null,
        fb: fbs.length ? pickBest(fbs, place.name, place.websiteUrl) : null,
    };
}

// SURFACE 2: TripAdvisor venue page.
async function tryTripadvisor(browser, place) {
    if (!place.tripadvisorUrl) return { ig: null, fb: null };
    const res = await fetchPage(browser, place.tripadvisorUrl, JS_SETTLE_TA_MS);
    if (!res.ok) return { ig: null, fb: null, err: res.error };
    const { igs, fbs } = extractCandidates(res.html);
    return {
        ig: igs.length ? pickBest(igs, place.name, place.websiteUrl) : null,
        fb: fbs.length ? pickBest(fbs, place.name, place.websiteUrl) : null,
    };
}

// SURFACE 3: Venue website (homepage + contact subpaths, short-circuit on
// hit). Same shape as backfill-socials-via-browser.js — kept inline so this
// script is self-contained.
async function tryWebsite(browser, place, stillNeedIg, stillNeedFb) {
    if (!place.websiteUrl) return { ig: null, fb: null };
    let origin;
    try { origin = new URL(place.websiteUrl).origin; } catch { return { ig: null, fb: null }; }
    const urls = [place.websiteUrl, ...SITE_SUBPATHS.map(s => origin + s)];
    let bestIg = null, bestFb = null, lastErr = null;

    for (const url of urls) {
        if (!stillNeedIg(bestIg) && !stillNeedFb(bestFb)) break;
        const res = await fetchPage(browser, url, JS_SETTLE_SITE_MS);
        if (!res.ok) { lastErr = res.error; continue; }
        const { igs, fbs } = extractCandidates(res.html);
        if (stillNeedIg(bestIg) && igs.length) bestIg = pickBest(igs, place.name, place.websiteUrl);
        if (stillNeedFb(bestFb) && fbs.length) bestFb = pickBest(fbs, place.name, place.websiteUrl);
    }
    return { ig: bestIg, fb: bestFb, err: lastErr };
}

// Cascade controller. Tries each surface in order, accumulates findings,
// short-circuits as soon as both IG and FB are covered (either already in
// the DB or found by a prior surface).
async function harvest(browser, place) {
    const need = { ig: !place.instagramUrl, fb: !place.facebookUrl };
    const result = { ig: null, fb: null, source: { ig: null, fb: null }, surfacesTried: [] };

    const surfaces = [
        ['google', () => tryGoogle(browser, place)],
        ['tripadvisor', () => tryTripadvisor(browser, place)],
        ['website', () => tryWebsite(browser,
            place,
            (cur) => need.ig && !cur,
            (cur) => need.fb && !cur,
        )],
    ];

    for (const [name, fn] of surfaces) {
        const stillNeedIg = need.ig && !result.ig;
        const stillNeedFb = need.fb && !result.fb;
        if (!stillNeedIg && !stillNeedFb) break;

        result.surfacesTried.push(name);
        const r = await fn();

        if (stillNeedIg && r.ig) { result.ig = r.ig; result.source.ig = name; }
        if (stillNeedFb && r.fb) { result.fb = r.fb; result.source.fb = name; }
    }

    return result;
}

function parseArgs(argv) {
    const out = { apply: false, ids: null, limit: null, country: null };
    for (const a of argv) {
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
            OR: [{ instagramUrl: null }, { facebookUrl: null }],
        };
        if (country) where.country = country;
    }
    const all = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, city: true, country: true,
            websiteUrl: true, tripadvisorUrl: true,
            instagramUrl: true, facebookUrl: true,
        },
        orderBy: [{ id: 'asc' }],
    });
    const places = limit ? all.slice(0, limit) : all;
    console.log(`[multi] ${places.length} candidates (apply=${apply}${country ? ` country=${country}` : ''})`);

    const browser = await makeBrowser();
    const counters = {
        igByGoogle: 0, igByTa: 0, igBySite: 0,
        fbByGoogle: 0, fbByTa: 0, fbBySite: 0,
        igFilled: 0, fbFilled: 0,
        miss: 0, errors: 0,
    };

    for (const p of places) {
        let result;
        try { result = await harvest(browser, p); }
        catch (e) {
            counters.errors++;
            console.log(`  [${p.id}] ${p.name} — harvest error: ${e.message.slice(0, 80)}`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }

        if (!result.ig && !result.fb) {
            counters.miss++;
            console.log(`  [${p.id}] ${p.name} — no hit (tried ${result.surfacesTried.join('+')})`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }

        const bits = [];
        const patch = {};
        if (result.ig && !p.instagramUrl) {
            patch.instagramUrl = result.ig.url;
            bits.push(`IG=${result.ig.url} via ${result.source.ig}${result.ig.matched ? '' : ' (no-name-match)'}`);
            counters[`igBy${cap(result.source.ig)}`]++;
        }
        if (result.fb && !p.facebookUrl) {
            patch.facebookUrl = result.fb.url;
            bits.push(`FB=${result.fb.url} via ${result.source.fb}${result.fb.matched ? '' : ' (no-name-match)'}`);
            counters[`fbBy${cap(result.source.fb)}`]++;
        }
        console.log(`  [${p.id}] ${p.name} — ${bits.join(' | ')}`);

        if (apply && Object.keys(patch).length) {
            await prisma.place.update({ where: { id: p.id }, data: patch }).catch((e) => {
                console.warn(`    update failed: ${e.message.slice(0, 80)}`);
            });
            if (patch.instagramUrl) counters.igFilled++;
            if (patch.facebookUrl) counters.fbFilled++;
        }

        await sleep(POLITE_DELAY_MS);
    }

    await browser.close();

    const igTotal = counters.igByGoogle + counters.igByTa + counters.igBySite;
    const fbTotal = counters.fbByGoogle + counters.fbByTa + counters.fbBySite;
    console.log('');
    console.log(`[multi] done. total=${places.length} miss=${counters.miss} errors=${counters.errors}`);
    console.log(`[multi] IG hits: google=${counters.igByGoogle} ta=${counters.igByTa} site=${counters.igBySite} total=${igTotal}`);
    console.log(`[multi] FB hits: google=${counters.fbByGoogle} ta=${counters.fbByTa} site=${counters.fbBySite} total=${fbTotal}`);
    if (apply) console.log(`[multi] applied: instagramUrl=${counters.igFilled} facebookUrl=${counters.fbFilled}`);
    else       console.log(`[multi] DRY RUN — re-run with --apply to write.`);

    return { ok: true, ...counters, total: places.length, igTotal, fbTotal };
}

function cap(s) { return 'tripadvisor' === s ? 'Ta' : s.charAt(0).toUpperCase() + s.slice(1); }

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}
