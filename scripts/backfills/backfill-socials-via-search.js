#!/usr/bin/env node
// Fill Place.instagramUrl / Place.facebookUrl by querying DuckDuckGo for
// "{name} {city} instagram" and "{name} {city} facebook". Better hit rate
// than scraping each restaurant's website (most Wix/Squarespace sites use
// SVG icon fonts, not <a href> links — extractor can't see them).
//
// Tradeoff vs. the website-scraper backfill:
//   + Works regardless of how the venue's own site renders socials
//   + Finds profiles for venues with no website at all
//   - Risk of false positives for chain names (e.g. multiple "Joe's Pizza")
//     — mitigated by requiring city in the query + filtering to handles
//     that share at least one 4+ char token with the venue name
//
// Usage:
//   node scripts/backfills/backfill-socials-via-search.js                       # dry run
//   node scripts/backfills/backfill-socials-via-search.js --apply
//   node scripts/backfills/backfill-socials-via-search.js --apply --limit=50
//   node scripts/backfills/backfill-socials-via-search.js --apply --ids=1,2,3
//
// Rate-limit: 2.5s between queries (DDG tolerates this comfortably; faster
// will get rate-capped within 50-100 queries).

const { prisma } = require('../lib/bootstrap');
const { ddgSearch, normalizeName, sleep } = require('../lib/utils');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
const QUERY_DELAY_MS = 2500;

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

async function findSocialViaDDG(platform, name, city) {
    const query = `${name} ${city || ''} ${platform}`.trim();
    let results;
    try {
        results = await ddgSearch(query, { userAgent: UA });
    } catch (e) {
        return { error: e.message.slice(0, 60) };
    }
    const norm = platform === 'instagram' ? normalizeInstagram : normalizeFacebook;
    const hostPattern = platform === 'instagram'
        ? /(^|\.)instagram\.com$/i
        : /(^|\.)(facebook|fb)\.com$/i;

    for (const url of results) {
        let u;
        try { u = new URL(url); } catch { continue; }
        if (!hostPattern.test(u.hostname)) continue;
        const normalized = norm(url);
        if (!normalized) continue;
        const handleOnly = normalized.split('/').pop();
        if (!handleMatchesName(handleOnly, name)) continue;
        return { url: normalized, handle: handleOnly };
    }
    return null;
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

    let igFound = 0, fbFound = 0, igFilled = 0, fbFilled = 0, errors = 0;

    for (const p of places) {
        const needIg = !p.instagramUrl;
        const needFb = !p.facebookUrl;
        if (!needIg && !needFb) continue;

        let ig = null, fb = null;
        if (needIg) {
            const r = await findSocialViaDDG('instagram', p.name, p.city);
            if (r && r.error) errors++;
            else if (r && r.url) { ig = r.url; igFound++; }
            await sleep(QUERY_DELAY_MS);
        }
        if (needFb) {
            const r = await findSocialViaDDG('facebook', p.name, p.city);
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
