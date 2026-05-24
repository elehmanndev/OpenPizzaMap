#!/usr/bin/env node
// Fill Place.instagramUrl / Place.facebookUrl by querying Google
// (`site:instagram.com X city` / `site:facebook.com X city`) through
// CloakBrowser so we get past Google's bot detection. Better index
// coverage than DDG for small/local restaurants (DDG returned 0 hits
// on a 20-row sample, Google has the profiles).
//
// Tradeoff vs. the website-scraper backfill:
//   + Works regardless of how the venue's own site renders socials
//   + Finds profiles for venues with no website at all
//   + Uses Google's index (best coverage of small businesses)
//   - Risk of false positives for chain names (e.g. multiple "Joe's Pizza")
//     — mitigated by requiring city in the query + preferring handles
//     that share at least one 4+ char token with the venue name
//   - Slow: ~4s per query (browser nav + JS settle), so ~8s per place
//
// Usage:
//   node scripts/backfills/backfill-socials-via-search.js                       # dry run
//   node scripts/backfills/backfill-socials-via-search.js --apply
//   node scripts/backfills/backfill-socials-via-search.js --apply --limit=50
//   node scripts/backfills/backfill-socials-via-search.js --apply --ids=1,2,3
//
// Requires `cloakbrowser` package — install once with:
//   docker exec opm-runner npm install --no-save cloakbrowser

const { prisma } = require('../lib/bootstrap');
const { normalizeName, sleep } = require('../lib/utils');

const QUERY_DELAY_MS = 1500;
const BROWSER_TIMEOUT_MS = 30000;
const JS_SETTLE_MS = 1500;

// Same blocklists the website-scraper uses — keeps us from grabbing
// /p/ post URLs or /sharer.php links as if they were profiles.
const IG_PATH_BLOCKLIST = new Set([
    'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'about',
    'developer', 'directory', 'legal', 'privacy', 'terms', 'share',
    'stories', 'web',
]);
const FB_PATH_BLOCKLIST = new Set([
    'sharer', 'sharer.php', 'dialog', 'plugins', 'tr', 'tr.php',
    'login', 'login.php', 'recover', 'help', 'policies', 'privacy',
    'about', 'careers', 'business', 'pages', 'groups', 'events',
    'watch', 'gaming', 'marketplace', 'fundraisers', 'reel',
    'photo.php', 'permalink.php',
]);

function normalizeInstagram(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (!/(^|\.)instagram\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const handle = seg[0].toLowerCase();
    if (IG_PATH_BLOCKLIST.has(handle)) return null;
    if (!/^[a-z0-9_.]{1,30}$/i.test(handle)) return null;
    return `https://instagram.com/${handle}`;
}

function normalizeFacebook(href) {
    let u;
    try { u = new URL(href); } catch { return null; }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname) && !/(^|\.)fb\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const handle = seg[0].toLowerCase();
    if (FB_PATH_BLOCKLIST.has(handle)) return null;
    if (!/^[a-z0-9._-]{2,80}$/i.test(handle)) return null;
    return `https://facebook.com/${handle}`;
}

// Loose name-overlap check — at least one 4+ char token in the venue name
// must appear in the social handle. Stops "Joe's Pizza" matching
// /restaurants.world or other generic accounts.
function handleMatchesName(handle, name) {
    if (!handle || !name) return false;
    const tokens = normalizeName(name).split(/\s+/).filter((t) => t.length >= 4);
    if (!tokens.length) return true; // very short venue name — can't safely check
    const lower = handle.toLowerCase();
    return tokens.some((t) => lower.includes(t));
}

// Lazy-load CloakBrowser. The 535MB binary boots in 3-8s, so we want to
// reuse the same browser+page across every search in the run.
async function makeBrowser() {
    let browser, page, unavailable = null;
    let consentDismissed = false;
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
        async dismissConsentOnce() {
            // Google's EU consent screen pops on first navigation. Click
            // "Accept all" (or any localised variant) so subsequent queries
            // don't get blocked behind it.
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

async function findSocialViaGoogle(browser, platform, name, city) {
    const domain = platform === 'instagram' ? 'instagram.com' : 'facebook.com';
    const query = `site:${domain} ${name} ${city || ''}`.trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}&hl=en`;

    let html;
    try {
        const page = await browser.getPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await browser.dismissConsentOnce();
        await page.waitForTimeout(JS_SETTLE_MS).catch(() => {});
        html = await page.content();
    } catch (e) {
        return { error: `browser-${e.name || 'error'}` };
    }

    const norm = platform === 'instagram' ? normalizeInstagram : normalizeFacebook;
    // Pull every social URL out of the rendered SERP. Google occasionally
    // wraps result links in /url?q=... — strip those, plus the direct
    // anchors most cards now use.
    const candidates = [];
    const seen = new Set();
    const URL_RE = /\bhttps?:\/\/(?:www\.|m\.|business\.|l\.)?(?:instagram|facebook|fb)\.com\/[^\s"'<>)]+/gi;
    let m;
    while ((m = URL_RE.exec(html)) !== null) {
        // Strip trailing punctuation that the regex sometimes greedily catches.
        const cleaned = m[0].replace(/[.,);\]]+$/, '');
        if (seen.has(cleaned)) continue;
        seen.add(cleaned);
        const normalized = norm(cleaned);
        if (!normalized) continue;
        const handleOnly = normalized.split('/').pop();
        candidates.push({ url: normalized, handle: handleOnly });
    }
    if (!candidates.length) return null;

    // Prefer name-token overlap. Fall back to the first hit — site:
    // restricted the domain already, so the first result is usually right.
    const matched = candidates.find((c) => handleMatchesName(c.handle, name));
    return matched || candidates[0];
}

function parseArgs(argv) {
    const out = { apply: false, ids: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (a === '--ids') out.ids = argv[++i].split(',').map(Number).filter(Boolean);
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
    }
    return out;
}

async function run({ apply = false, ids = null, limit = null } = {}) {
    let where;
    if (ids) where = { id: { in: ids } };
    else {
        where = {
            isVisible: true,
            OR: [{ instagramUrl: null }, { facebookUrl: null }],
        };
    }
    const all = await prisma.place.findMany({
        where,
        select: { id: true, name: true, city: true, instagramUrl: true, facebookUrl: true },
        orderBy: [{ id: 'asc' }],
    });
    const places = limit ? all.slice(0, limit) : all;
    console.log(`[search-socials] ${places.length} candidates (apply=${apply})`);

    const browser = await makeBrowser();
    let igFound = 0, fbFound = 0, igFilled = 0, fbFilled = 0, errors = 0;

    for (const p of places) {
        const needIg = !p.instagramUrl;
        const needFb = !p.facebookUrl;
        if (!needIg && !needFb) continue;

        let ig = null, fb = null;
        if (needIg) {
            const r = await findSocialViaGoogle(browser, 'instagram', p.name, p.city);
            if (r && r.error) errors++;
            else if (r && r.url) { ig = r.url; igFound++; }
            await sleep(QUERY_DELAY_MS);
        }
        if (needFb) {
            const r = await findSocialViaGoogle(browser, 'facebook', p.name, p.city);
            if (r && r.error) errors++;
            else if (r && r.url) { fb = r.url; fbFound++; }
            await sleep(QUERY_DELAY_MS);
        }

        if (!ig && !fb) {
            console.log(`  [${p.id}] ${p.name} — no match`);
            continue;
        }
        const bits = [ig ? `IG=${ig}` : null, fb ? `FB=${fb}` : null].filter(Boolean).join(' ');
        console.log(`  [${p.id}] ${p.name} — ${bits}`);

        if (apply) {
            const patch = {};
            if (ig && !p.instagramUrl) { patch.instagramUrl = ig; igFilled++; }
            if (fb && !p.facebookUrl) { patch.facebookUrl = fb; fbFilled++; }
            if (Object.keys(patch).length) {
                await prisma.place.update({ where: { id: p.id }, data: patch }).catch((e) => {
                    console.warn(`    update failed: ${e.message.slice(0, 80)}`);
                });
            }
        }
    }

    await browser.close();

    console.log('');
    console.log(`[search-socials] done. ig=${igFound} fb=${fbFound} errors=${errors}`);
    if (apply) console.log(`[search-socials] applied: instagramUrl=${igFilled} facebookUrl=${fbFilled}`);
    else       console.log(`[search-socials] DRY RUN — re-run with --apply to write.`);

    return { ok: true, igFound, fbFound, igFilled, fbFilled, errors, total: places.length };
}

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}
