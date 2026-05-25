#!/usr/bin/env node
// Cleanup pass for the score=1 weak FB cohort using Apify's official
// facebook-pages-scraper actor. Sibling to cleanup-weak-socials-via-apify.js
// (the IG variant) — same scoring philosophy, different actor + richer data
// signals (FB exposes a `categories` field like "Pizza place" that's a
// stronger pizza-context signal than text parsing the bio).
//
// Pricing on Apify free tier: $0.012/page (4.6× the IG actor). For the
// full ~950 FB weak cohort that would be $11.40, well over budget. So
// this script defaults to a PRIORITY-FIRST mode: sorts the cohort by
// googleReviewCount DESC and processes the top N (default 150).
// Most-visible venues get cleaned first; the long tail waits for either
// next month's credit or the in-house cleanup script.
//
// Usage:
//   APIFY_TOKEN=apify_api_xxx node scripts/admin/cleanup-weak-socials-via-apify-fb.js          # dry-run cost estimate (top 150)
//   APIFY_TOKEN=apify_api_xxx node scripts/admin/cleanup-weak-socials-via-apify-fb.js --apply  # write
//   ... --limit=50                                                                              # process fewer
//   ... --token=apify_api_xxx                                                                  # token via CLI
//
// CSV output: data/cleanup-weak-socials-via-apify-fb-YYYY-MM-DD.csv

const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/bootstrap');
const { jaroWinkler, normalizeName, sleep } = require('../lib/utils');

const ACTOR_ID = 'apify~facebook-pages-scraper';
const COST_PER_PAGE_USD = 0.012; // FREE-tier rate
const DEFAULT_LIMIT = 150;       // ~$1.80 — fits remaining $1.89 of credit
const BATCH_SIZE = 50;           // pages per actor run

const PIZZA_CONTEXT_RE = /pizza|pizzeria|napoletan|forno|focaccia|wood.?fired|pizzaiolo|pizzaiola/i;
// FB page categories that are positive pizza-context signals
const PIZZA_CATEGORY_RE = /pizza\s*place|pizzeria|italian\s*restaurant|pizza\s*restaurant|pizza\s*delivery|pizza\s*takeaway/i;

const EXPANDED_BLOCKLIST = new Set([
    'meta', 'squarespace', 'wix', 'shopify', 'instagram', 'facebook', 'fb',
    'share', 'sharer', 'login', 'help', 'about', 'developer', 'developers',
    'en', 'fr', 'it', 'es', 'de', 'pt', 'nl', 'ru', 'ja', 'zh',
    'pizza', 'cafe', 'restaurant', 'food', 'eats', 'home',
]);

function handleFromUrl(url) {
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean);
        // Handle the legacy /pages/Name-12345 form first
        if (seg[0]?.toLowerCase() === 'pages' && seg.length >= 3) return seg[seg.length - 1].toLowerCase();
        return seg[0]?.toLowerCase() || null;
    } catch { return null; }
}

const HIT_LINE_RE = /^  \[(\d+)\]\s+(.+?)\s+—\s+(.+)$/;
const URL_PART_RE = /(IG|FB)=(\S+)\s+via\s+(\w+)(?:\s+\(score=(\d+)(?:\s+(weak))?\))?/g;

function parseWeakFbHits(logPath) {
    const text = fs.readFileSync(logPath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
        const m = line.match(HIT_LINE_RE);
        if (!m) continue;
        const placeId = parseInt(m[1], 10);
        const name = m[2];
        const tail = m[3];
        URL_PART_RE.lastIndex = 0;
        let pm;
        while ((pm = URL_PART_RE.exec(tail)) !== null) {
            const platform = pm[1].toLowerCase();
            const url = pm[2];
            const score = pm[4] ? parseInt(pm[4], 10) : null;
            const isWeak = pm[5] === 'weak';
            if (platform === 'fb' && score === 1 && isWeak) {
                out.push({ placeId, name, platform, url });
            }
        }
    }
    return out;
}

// Score a single Apify FB page object against the DB row.
function scoreFbPage(page, place, handle) {
    if (!page || page.error) {
        return { decision: 'unknown', score: null, signals: { error: page?.error || 'no-data' }, reason: 'apify-no-data' };
    }

    const signals = {
        pageName: (page.title || page.pageName || page.name)?.slice(0, 80),
        followers: page.followers ?? page.fanCount ?? page.likesCount,
        categories: page.categories?.slice(0, 3),
    };
    let score = 0;

    const pageName = ((page.title || page.pageName || page.name) || '').toLowerCase();
    const address = (page.address || page.fullAddress || '').toLowerCase();
    const website = (page.website || page.websites?.[0] || '').toLowerCase();
    const categoriesText = (page.categories || []).join(' ').toLowerCase();
    const allText = `${pageName} ${address} ${categoriesText} ${page.about || ''} ${page.intro || ''}`.toLowerCase();

    // Name token in page name
    const nameTokens = normalizeName(place.name || '').split(/\s+/).filter(t => t.length >= 4);
    const pageNameNorm = normalizeName(pageName);
    if (nameTokens.length && nameTokens.some(t => pageNameNorm.includes(t))) {
        score++;
        signals.name = true;
    }

    // City in address
    if (place.city && place.city.length >= 4 && address.includes(place.city.toLowerCase())) {
        score++;
        signals.city = true;
    }

    // Website domain — FB exposes the page's `website` field directly.
    // Exact host match is a very strong signal (venue actively links its own site).
    if (place.websiteUrl && website) {
        try {
            const ourHost = new URL(place.websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
            const theirHost = new URL(website).hostname.replace(/^www\./, '').toLowerCase();
            if (ourHost === theirHost) {
                score += 2;
                signals.domain = ourHost;
            }
        } catch { /* invalid URL — skip */ }
    }

    // Phone match
    if (place.phone) {
        const digits = place.phone.replace(/\D/g, '');
        if (digits.length >= 7) {
            const pagePhone = (page.phone || '').replace(/\D/g, '');
            const tail = digits.slice(-7);
            if (pagePhone.includes(tail) || allText.replace(/\D/g, '').includes(tail)) {
                score++;
                signals.phone = true;
            }
        }
    }

    // CONCEPT 1: pizza-context (categories or text) + expanded blocklist + handle match
    if (EXPANDED_BLOCKLIST.has(handle)) {
        score -= 3;
        signals.blocklistHit = handle;
        return { decision: 'null', score, signals, reason: 'expanded-blocklist' };
    }
    // FB's `categories` field is the strongest pizza-context signal — direct
    // taxonomy match like "Pizza place" or "Italian restaurant"
    if (PIZZA_CATEGORY_RE.test(categoriesText)) {
        score++;
        signals.pizzaCategory = true;
    } else if (PIZZA_CONTEXT_RE.test(allText)) {
        // Fall back to text match in about/intro/name
        score++;
        signals.pizzaContext = true;
    }
    const handleStripped = handle.replace(/[._-]/g, '');
    if (nameTokens.length && nameTokens.some(t => handleStripped.includes(t))) {
        score++;
        signals.handleMatch = true;
    }

    // Decision after Concept 1
    if (score >= 2) return { decision: 'keep', score, signals, reason: 'concept1-pass' };
    if (score <= 0) return { decision: 'null', score, signals, reason: 'concept1-fail' };

    // CONCEPT 2: Jaro-Winkler + followers/likes — for score=1 borderline
    if (pageName) {
        const jw = jaroWinkler(normalizeName(place.name || ''), normalizeName(pageName));
        signals.jaroWinkler = Math.round(jw * 100) / 100;
        if (jw >= 0.7) { score++; signals.jwMatch = true; }
    }
    const followers = page.followers ?? page.fanCount ?? page.likesCount;
    if (followers != null) {
        if (followers >= 30) { score++; signals.followersOk = true; }
        else if (followers === 0) { score--; signals.zeroFollowers = true; }
    }

    if (score >= 2) return { decision: 'keep', score, signals, reason: 'concept2-pass' };
    if (score <= 0) return { decision: 'null', score, signals, reason: 'concept2-fail' };
    return { decision: 'borderline', score, signals, reason: 'still-score-1' };
}

async function callApifyBatch(urls, token) {
    const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrls: urls.map(u => ({ url: u })) }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Apify ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
}

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function writeCsv(csvPath, rows) {
    fs.mkdirSync(path.dirname(csvPath) || '.', { recursive: true });
    const header = 'placeId,name,handle,decision,score,reason,signals\n';
    const lines = rows.map(r =>
        [r.placeId, r.name, r.handle, r.decision, r.score, r.reason, JSON.stringify(r.signals || {})]
            .map(csvEscape).join(',')
    );
    fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
}

function parseArgs(argv) {
    const out = { apply: false, log: '/tmp/socials-all.log', limit: DEFAULT_LIMIT, csv: null, token: null };
    for (const a of argv) {
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (eq('log')) out.log = eq('log');
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
        else if (eq('csv')) out.csv = eq('csv');
        else if (eq('token')) out.token = eq('token');
    }
    if (!out.token) out.token = process.env.APIFY_TOKEN;
    return out;
}

async function run({ apply = false, log = '/tmp/socials-all.log', limit = DEFAULT_LIMIT, csv = null, token = null } = {}) {
    if (!token) {
        console.error('ERROR: Apify API token required. Pass --token=apify_api_xxx or set APIFY_TOKEN env.');
        process.exit(1);
    }
    if (!csv) {
        const stamp = new Date().toISOString().slice(0, 10);
        csv = `data/cleanup-weak-socials-via-apify-fb-${stamp}.csv`;
    }
    if (!fs.existsSync(log)) {
        console.error(`[apify-fb-cleanup] log file not found: ${log}`);
        process.exit(1);
    }

    let cohort = parseWeakFbHits(log);
    console.log(`[apify-fb-cleanup] parsed ${cohort.length} score=1 weak FB entries from ${log}`);
    if (!cohort.length) { console.log('[apify-fb-cleanup] nothing to do.'); return { ok: true, total: 0 }; }

    // Hydrate place data + sort by impact (review count DESC) before applying limit
    const placeIds = [...new Set(cohort.map(c => c.placeId))];
    const places = await prisma.place.findMany({
        where: { id: { in: placeIds } },
        select: {
            id: true, name: true, city: true, country: true, phone: true,
            websiteUrl: true, facebookUrl: true,
            googleReviewCount: true, tripadvisorReviewCount: true,
        },
    });
    const placeById = new Map(places.map(p => [p.id, p]));

    // URL-still-matches filter
    const needsWork = cohort.filter(hit => {
        const p = placeById.get(hit.placeId);
        return p && p.facebookUrl === hit.url;
    });
    const alreadyDone = cohort.length - needsWork.length;

    // PRIORITY SORT: highest review count first (most visible venues get cleaned first)
    needsWork.sort((a, b) => {
        const pa = placeById.get(a.placeId);
        const pb = placeById.get(b.placeId);
        const ra = (pa?.googleReviewCount || 0) + (pa?.tripadvisorReviewCount || 0);
        const rb = (pb?.googleReviewCount || 0) + (pb?.tripadvisorReviewCount || 0);
        return rb - ra;
    });
    cohort = needsWork;
    if (limit) cohort = cohort.slice(0, limit);

    const estCost = (cohort.length * COST_PER_PAGE_USD).toFixed(2);
    console.log(`[apify-fb-cleanup] ${cohort.length} top FB to verify (${alreadyDone} already done, sorted by review count) — est cost $${estCost}`);
    if (!apply) {
        console.log(`[apify-fb-cleanup] DRY RUN — re-run with --apply to actually send to Apify.`);
        return { ok: true, total: cohort.length, estCost, dryRun: true };
    }
    if (!cohort.length) return { ok: true, total: 0 };

    // Build url → cohort-entry map
    const cohortByUrl = new Map();
    for (const hit of cohort) cohortByUrl.set(hit.url, hit);
    const urls = [...cohortByUrl.keys()];

    const results = [];
    const stats = { keep: 0, null: 0, unknown: 0, borderline: 0, errors: 0 };
    for (let i = 0; i < urls.length; i += BATCH_SIZE) {
        const batch = urls.slice(i, i + BATCH_SIZE);
        console.log(`[apify-fb-cleanup] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(urls.length / BATCH_SIZE)}: ${batch.length} pages`);
        let pages;
        try { pages = await callApifyBatch(batch, token); }
        catch (e) {
            console.error(`[apify-fb-cleanup] batch failed: ${e.message}`);
            for (const url of batch) {
                const hit = cohortByUrl.get(url);
                results.push({ placeId: hit.placeId, name: hit.name, handle: handleFromUrl(url), decision: 'unknown', score: null, reason: 'batch-error', signals: { error: e.message.slice(0, 120) } });
                stats.unknown++;
            }
            continue;
        }

        // Index results by URL. Actor may normalize or strip trailing slash;
        // try multiple key forms.
        const pageByUrl = new Map();
        for (const p of pages) {
            const keys = [p.pageUrl, p.url, p.facebookUrl, p.pageUrl?.replace(/\/$/, ''), p.url?.replace(/\/$/, '')].filter(Boolean);
            for (const k of keys) pageByUrl.set(k.toLowerCase(), p);
        }

        for (const url of batch) {
            const hit = cohortByUrl.get(url);
            const place = placeById.get(hit.placeId);
            const handle = handleFromUrl(url);
            // Match by URL (multiple normalizations) then fall back to handle search
            let page = pageByUrl.get(url.toLowerCase()) || pageByUrl.get(url.replace(/\/$/, '').toLowerCase());
            if (!page && handle) {
                page = pages.find(p => {
                    const ph = handleFromUrl(p.pageUrl || p.url || p.facebookUrl || '');
                    return ph === handle;
                });
            }
            const r = scoreFbPage(page, place, handle);

            const sig = Object.entries(r.signals || {})
                .filter(([k, v]) => v && k !== 'pageName' && k !== 'categories')
                .map(([k, v]) => typeof v === 'boolean' ? k : `${k}=${v}`)
                .join(',');
            console.log(`  [${hit.placeId}] ${hit.name} fb/${handle || '?'} → ${r.decision} (score=${r.score} ${sig})`);

            results.push({ placeId: hit.placeId, name: hit.name, handle: handle || url, ...r });
            stats[r.decision]++;

            if (r.decision === 'null') {
                try {
                    await prisma.place.update({ where: { id: hit.placeId }, data: { facebookUrl: null } });
                } catch (e) {
                    console.warn(`    update failed: ${e.message.slice(0, 80)}`);
                }
            }
        }
    }

    writeCsv(csv, results);
    console.log('');
    console.log(`[apify-fb-cleanup] done. ${cohort.length} processed`);
    console.log(`  keep:        ${stats.keep}`);
    console.log(`  null:        ${stats.null} (applied)`);
    console.log(`  borderline:  ${stats.borderline}`);
    console.log(`  unknown:     ${stats.unknown}`);
    console.log(`  est cost:    $${estCost}`);
    console.log(`  CSV:         ${csv}`);
    return { ok: true, ...stats, total: cohort.length, estCost, csvPath: csv };
}

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch(e => { console.error(e); process.exit(1); });
}
