#!/usr/bin/env node
// Fill Place.instagramUrl / Place.facebookUrl by fetching each place's homepage
// and harvesting social anchors. Pizzerias almost always link IG/FB in the
// header or footer, so a single HTML fetch per place is usually enough.
//
// Usage:
//   node scripts/backfills/backfill-socials-from-website.js                # dry-run
//   node scripts/backfills/backfill-socials-from-website.js --apply        # write
//   node scripts/backfills/backfill-socials-from-website.js --limit=50
//   node scripts/backfills/backfill-socials-from-website.js --ids=1,2,3
//
// Queue: visible places with a websiteUrl AND (instagramUrl null OR
// facebookUrl null). Aggregator-host websites (rare — the import policy
// rejects them, but legacy rows may have them) are skipped.
//
// Fill-only-if-null on each field — never overwrites a value already in the
// DB (matches the project's dedup/merge policy).

const { prisma } = require('../lib/bootstrap');
const { fetchWithTimeout, sleep, AGGREGATOR_HOSTS } = require('../lib/utils');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const IDS = (() => {
    const a = args.find((x) => x.startsWith('--ids='));
    return a ? a.slice(6).split(',').map((s) => parseInt(s, 10)).filter(Boolean) : null;
})();
const LIMIT = (() => {
    const a = args.find((x) => x.startsWith('--limit='));
    return a ? parseInt(a.slice(8), 10) : null;
})();

const UA = 'OpenPizzaMap-socials-backfill/0.1 (eric@openpizzamap.com)';
const POLITE_DELAY_MS = 800;
const FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 1_500_000;   // 1.5MB cap — restaurant homepages are typically <500KB

// Instagram URL path segments that aren't a profile handle.
const IG_PATH_BLOCKLIST = new Set([
    'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'about',
    'developer', 'directory', 'legal', 'privacy', 'terms', 'share',
    'stories', 'web',
]);

// Facebook URL path segments that aren't a page.
const FB_PATH_BLOCKLIST = new Set([
    'sharer', 'sharer.php', 'dialog', 'plugins', 'tr', 'tr.php',
    'login', 'login.php', 'recover', 'help', 'policies', 'privacy',
    'about', 'careers', 'business', 'pages', 'groups', 'events',
    'watch', 'gaming', 'marketplace', 'fundraisers', 'reel',
    'photo.php', 'permalink.php',
]);

// Match href= or src= in <a>, <link>, <meta>. Greedy enough to catch most
// HTML, simple enough that we don't need a DOM parser.
const HREF_RE = /(?:href|content)\s*=\s*["']([^"']+)["']/gi;

function extractInstagram(html) {
    const candidates = [];
    let m;
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(html)) !== null) {
        const raw = m[1];
        if (!/instagram\.com/i.test(raw)) continue;
        const url = normalizeInstagram(raw);
        if (url) candidates.push(url);
    }
    if (!candidates.length) return null;
    // Most pages link the same handle 3-4 times (header + footer + meta).
    // Pick the most frequent — that's almost always the venue's own profile,
    // not a one-off "follow us on @somecollab" link.
    return mostFrequent(candidates);
}

function extractFacebook(html) {
    const candidates = [];
    let m;
    HREF_RE.lastIndex = 0;
    while ((m = HREF_RE.exec(html)) !== null) {
        const raw = m[1];
        if (!/facebook\.com/i.test(raw)) continue;
        const url = normalizeFacebook(raw);
        if (url) candidates.push(url);
    }
    if (!candidates.length) return null;
    return mostFrequent(candidates);
}

function normalizeInstagram(href) {
    let u;
    try { u = new URL(href, 'https://example.com'); } catch { return null; }
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
    try { u = new URL(href, 'https://example.com'); } catch { return null; }
    if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;
    const seg = u.pathname.split('/').filter(Boolean);
    if (!seg.length) return null;
    const first = seg[0].toLowerCase();
    if (FB_PATH_BLOCKLIST.has(first)) return null;
    // Some pages live under /pages/<Name>/<id>; treat as a valid page.
    if (first === 'pages' && seg.length >= 3 && /^\d+$/.test(seg[seg.length - 1])) {
        return `https://facebook.com/${seg[1]}-${seg[seg.length - 1]}`.toLowerCase();
    }
    // Reject query-only profile URLs (e.g. profile.php?id=123); they're real
    // but rarer for businesses and harder to canonicalize cleanly.
    if (first === 'profile.php') return null;
    if (!/^[a-z0-9._-]{1,64}$/i.test(first)) return null;
    return `https://facebook.com/${first}`;
}

function mostFrequent(arr) {
    const counts = new Map();
    for (const v of arr) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null, bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
}

async function fetchHomepage(url) {
    let r;
    try {
        r = await fetchWithTimeout(url, {
            accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
            userAgent: UA,
            headers: { 'Accept-Language': 'en;q=0.9, *;q=0.5' },
        }, FETCH_TIMEOUT_MS);
    } catch (e) {
        return { ok: false, error: e.code || e.name || 'fetch-error' };
    }
    if (!r.ok) return { ok: false, error: `http-${r.status}` };
    const ctype = r.headers.get('content-type') || '';
    if (!/html/i.test(ctype) && !/xml/i.test(ctype)) {
        return { ok: false, error: `non-html (${ctype})` };
    }
    // Read up to MAX_HTML_BYTES — anything past that is rarely useful and
    // bloats memory on the few sites that serve massive single-page apps.
    const buf = await r.arrayBuffer();
    const slice = buf.byteLength > MAX_HTML_BYTES ? buf.slice(0, MAX_HTML_BYTES) : buf;
    return { ok: true, html: Buffer.from(slice).toString('utf8') };
}

(async () => {
    let where;
    if (IDS) where = { id: { in: IDS } };
    else {
        where = {
            isVisible: true,
            websiteUrl: { not: null },
            OR: [{ instagramUrl: null }, { facebookUrl: null }],
        };
    }

    const all = await prisma.place.findMany({
        where,
        select: { id: true, name: true, city: true, websiteUrl: true, instagramUrl: true, facebookUrl: true },
        orderBy: [{ id: 'asc' }],
    });
    const places = LIMIT ? all.slice(0, LIMIT) : all;
    console.log(`[socials] ${places.length} candidates (apply=${APPLY})`);

    let fetched = 0, igFound = 0, fbFound = 0, igFilled = 0, fbFilled = 0;
    let skippedAgg = 0, fetchErr = 0;

    for (const p of places) {
        let url = p.websiteUrl;
        if (!url) continue;
        // Defensive: import policy already excludes aggregators, but legacy
        // rows may have slipped through. We can't harvest a meaningful FB/IG
        // from a TripAdvisor URL.
        if (AGGREGATOR_HOSTS.test(url)) { skippedAgg++; continue; }
        if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

        const res = await fetchHomepage(url);
        fetched++;
        if (!res.ok) {
            fetchErr++;
            console.log(`  [${p.id}] ${p.name} — fetch ${res.error}`);
            await sleep(POLITE_DELAY_MS);
            continue;
        }

        const ig = p.instagramUrl ? null : extractInstagram(res.html);
        const fb = p.facebookUrl ? null : extractFacebook(res.html);

        const patch = {};
        if (ig && !p.instagramUrl) { patch.instagramUrl = ig; igFound++; }
        if (fb && !p.facebookUrl)  { patch.facebookUrl  = fb; fbFound++; }

        if (Object.keys(patch).length) {
            const parts = [];
            if (patch.instagramUrl) parts.push(`IG=${patch.instagramUrl}`);
            if (patch.facebookUrl)  parts.push(`FB=${patch.facebookUrl}`);
            console.log(`  [${p.id}] ${p.name} — ${parts.join(' ')}`);
            if (APPLY) {
                await prisma.place.update({ where: { id: p.id }, data: patch });
                if (patch.instagramUrl) igFilled++;
                if (patch.facebookUrl)  fbFilled++;
            }
        }

        await sleep(POLITE_DELAY_MS);
    }

    console.log('');
    console.log(`[socials] done. fetched=${fetched} ig=${igFound} fb=${fbFound} skipped-agg=${skippedAgg} fetch-err=${fetchErr}`);
    if (APPLY) console.log(`[socials] applied: instagramUrl=${igFilled} facebookUrl=${fbFilled}`);
    else       console.log(`[socials] DRY RUN — re-run with --apply to write.`);

    await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
