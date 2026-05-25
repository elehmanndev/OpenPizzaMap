#!/usr/bin/env node
// Cleanup pass for the score=1 weak cohort produced by
// backfill-socials-multi-source.js. Re-verifies each weak IG/FB URL with
// two additional signals the original verifier didn't have:
//
//   Concept 1 — pizza-context + expanded blocklist
//     +1 if bio/page mentions pizza|pizzeria|napoletan|forno|focaccia|
//        wood-fired|pizzaiolo
//     −3 if handle in expanded blocklist (meta, squarespace, wix, shopify,
//        instagram, facebook, share, bare lang codes, generic singles)
//
//   Concept 2 — Jaro-Winkler title + followers (only if Concept 1 didn't
//   resolve)
//     +1 if Jaro-Winkler(og:title minus boilerplate, venue name) >= 0.7
//     +1 if followers >= 30
//     −1 if followers == 0
//
// Decision rule:
//   final score >= 2  → KEEP (legitimate, just under-verified originally)
//   blocklist −3 hit  → NULL  (clear junk)
//   final score <= 0  → NULL
//   final score == 1  → BORDERLINE (CSV-flagged for human eyeball)
//   rate-limit signature detected → UNKNOWN (do NOT null, retry later)
//
// Rate-limit handling baked in (lesson from 2026-05-24 main run):
//   - Per-row jittered delay 3-5s (up from 1s) to stay under IG threshold
//   - Detects login-wall signature: og:title === "Instagram" with empty
//     description, or FB returning empty meta — marks UNKNOWN, never NULL
//
// Usage:
//   node scripts/admin/cleanup-weak-socials.js                  # dry run
//   node scripts/admin/cleanup-weak-socials.js --apply
//   node scripts/admin/cleanup-weak-socials.js --log=/tmp/socials-all.log
//   node scripts/admin/cleanup-weak-socials.js --apply --limit=50
//   node scripts/admin/cleanup-weak-socials.js --apply --csv=/tmp/cleanup.csv
//
// To beat IG/FB rate-limiting, route each verification through Apify's
// residential proxy pool. Grab your API token from
// https://console.apify.com/settings/integrations and pass it as:
//   node scripts/admin/cleanup-weak-socials.js --proxy=apify-residential --proxy-token=apify_api_xxx --limit=20
// Costs ~$8/GB of residential bandwidth from your Apify free credit
// (~$3 for a full ~1,775-row cleanup at ~200KB per page).
//
// Output CSV columns: placeId,name,platform,url,decision,score,signals,reason
// One row per re-verified weak hit. Open in Excel/Sheets to spot-check.

const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/bootstrap');
const { jaroWinkler, normalizeName, sleep } = require('../lib/utils');

const BROWSER_TIMEOUT_MS = 30000;
const VERIFY_SETTLE_MS = 2500;
const POLITE_MIN_MS = 3000;
const POLITE_MAX_MS = 5000;
const MAX_HTML_BYTES = 1_500_000;

const PIZZA_CONTEXT_RE = /pizza|pizzeria|napoletan|forno|focaccia|wood.?fired|pizzaiolo|pizzaiola/i;

// Handles that are NEVER a legitimate venue profile (off-the-shelf template
// defaults, platform corporate accounts, language codes, single generic
// words). Same set applied to IG and FB.
const EXPANDED_BLOCKLIST = new Set([
    'meta', 'squarespace', 'wix', 'shopify', 'instagram', 'facebook', 'fb',
    'share', 'sharer', 'login', 'help', 'about', 'developer', 'developers',
    'en', 'fr', 'it', 'es', 'de', 'pt', 'nl', 'ru', 'ja', 'zh',
    'pizza', 'cafe', 'restaurant', 'food', 'eats', 'home',
]);

const OG_META_RE = /<meta\s+[^>]*property\s*=\s*["']og:([a-z_]+)["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
const OG_META_RE_ALT = /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']og:([a-z_]+)["']/gi;

function extractOgTags(html) {
    const out = {};
    let m;
    OG_META_RE.lastIndex = 0;
    while ((m = OG_META_RE.exec(html)) !== null) out[m[1]] = decodeHtml(m[2]);
    OG_META_RE_ALT.lastIndex = 0;
    while ((m = OG_META_RE_ALT.exec(html)) !== null) if (!out[m[2]]) out[m[2]] = decodeHtml(m[1]);
    return out;
}
function decodeHtml(s) {
    return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;/g, "'")
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'");
}

// CloakBrowser launcher with optional Apify residential proxy. When proxy
// is enabled, each browser request routes through a random residential IP
// from Apify's pool — defeats per-IP rate-limits (the reason IG locked us
// out after the long 2026-05-24 main run).
async function makeBrowser({ proxy = null, proxyToken = null } = {}) {
    let browser, page, unavailable = null;
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
                const launchOpts = {};
                if (proxy === 'apify-residential') {
                    const token = proxyToken || process.env.APIFY_TOKEN;
                    if (!token) {
                        throw new Error('--proxy=apify-residential requires --proxy-token=<token> or APIFY_TOKEN env var. Grab token from https://console.apify.com/settings/integrations');
                    }
                    // Apify residential pool: each request rotates to a different IP.
                    // Username format: groups-RESIDENTIAL[,session-X for sticky session]
                    // We deliberately omit session-X so every request gets a fresh IP.
                    launchOpts.proxy = {
                        server: 'http://proxy.apify.com:8000',
                        username: 'groups-RESIDENTIAL',
                        password: token,
                    };
                    console.log(`[cleanup] using Apify residential proxy`);
                }
                browser = await cb.launch(launchOpts);
                page = await browser.newPage();
            }
            return page;
        },
        async close() { if (browser) await browser.close().catch(() => {}); browser = null; page = null; },
    };
}

async function fetchPage(browser, url) {
    try {
        const p = await browser.getPage();
        await p.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
        await p.waitForTimeout(VERIFY_SETTLE_MS).catch(() => {});
        const html = await p.content();
        return { ok: true, html: html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html };
    } catch (e) {
        // Preserve as much error context as possible — name alone collapses
        // proxy/network failures to "Error" which hides the actual cause.
        const detail = (e.message || '').slice(0, 200);
        return { ok: false, error: `${e.name || 'browser-error'}: ${detail}` };
    }
}

// Detects the IG/FB rate-limit "login wall" signature. When tripped, IG
// returns a 200 with og:title === "Instagram" (bare word, no venue name)
// and either no og:description or a generic "Create an account..." stub.
// FB usually returns empty meta when serving its rate-limited variant.
function isRateLimited(platform, og, html) {
    if (platform === 'ig') {
        if (og.title === 'Instagram' || og.title === 'Login • Instagram') {
            if (!og.description || /Create an account|Log in to see|Sign up to see/i.test(og.description)) {
                return true;
            }
        }
        // Sometimes IG serves an "isn't available" page for valid handles too
        if (/Sorry, this page isn't available/i.test(html)) return true;
        return false;
    }
    if (platform === 'fb') {
        // FB blocked variant: empty meta with login redirect, OR explicit text
        if (!og.title && !og.description && /login\.php|loggedout/i.test(html)) return true;
        if (/Content (not found|isn['’]t available)/i.test(html)) return true;
        return false;
    }
    return false;
}

function nameTokensInTitle(name, title) {
    const tokens = normalizeName(name || '').split(/\s+/).filter(t => t.length >= 4);
    if (!tokens.length) return false;
    const titleNorm = normalizeName(title || '');
    return tokens.some(t => titleNorm.includes(t));
}
function pageContainsCity(html, city) {
    if (!city || city.length < 4) return false;
    return html.toLowerCase().includes(city.toLowerCase());
}
function pageContainsDomain(html, websiteUrl) {
    try {
        const host = new URL(websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
        if (host.length < 5) return false;
        return html.toLowerCase().includes(host);
    } catch { return false; }
}
function pageContainsPhone(html, phone) {
    if (!phone) return false;
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return false;
    return html.replace(/\D/g, '').includes(digits.slice(-7));
}

function stripPlatformBoilerplate(title) {
    if (!title) return '';
    return title
        .replace(/\(@[^)]+\)/g, '')
        .replace(/•\s*Instagram[^"]*$/i, '')
        .replace(/[-|]\s*(Posts|Facebook|Profile|Home)[^"]*$/i, '')
        .trim();
}

// Best-effort follower count. IG embeds it in OG meta description for many
// regions ("123 Followers, 45 Following, 89 Posts"). FB exposes it in the
// page as "people like this" / "personnes aiment ça" / variants. Returns
// null if not detectable.
function extractFollowerCount(html, platform) {
    if (platform === 'ig') {
        const patterns = [
            /(\d[\d,.]*)[KkMm]?\s+Followers/i,
            /(\d[\d,.]*)[KkMm]?\s+seguidores/i,
            /(\d[\d,.]*)[KkMm]?\s+seguaci/i,
            /(\d[\d,.]*)[KkMm]?\s+abonnés/i,
            /(\d[\d,.]*)[KkMm]?\s+Follower\b/i,
        ];
        for (const re of patterns) {
            const m = html.match(re);
            if (m) return parseFollowerNum(m[0]);
        }
    } else if (platform === 'fb') {
        const patterns = [
            /(\d[\d,.]*)[KkMm]?\s+people like this/i,
            /(\d[\d,.]*)[KkMm]?\s+followers/i,
            /(\d[\d,.]*)[KkMm]?\s+personnes aiment/i,
            /(\d[\d,.]*)[KkMm]?\s+persone seguono/i,
        ];
        for (const re of patterns) {
            const m = html.match(re);
            if (m) return parseFollowerNum(m[0]);
        }
    }
    return null;
}
function parseFollowerNum(raw) {
    const m = raw.match(/(\d[\d,.]*)([KkMm]?)/);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    const suffix = m[2].toLowerCase();
    if (suffix === 'k') n *= 1000;
    else if (suffix === 'm') n *= 1_000_000;
    return Math.round(n);
}

// Core verifier — re-checks original signals + adds Concept 1 + (if
// borderline) Concept 2. Returns { decision, score, signals, reason }.
async function reverify(browser, hit, place) {
    const res = await fetchPage(browser, hit.url);
    if (!res.ok) {
        return { decision: 'unknown', score: null, signals: { error: res.error }, reason: `fetch-error:${res.error}` };
    }

    const og = extractOgTags(res.html);

    // Rate-limit check — bail to UNKNOWN before scoring, otherwise we'd
    // false-reject a legit handle just because IG/FB blocked us today.
    if (isRateLimited(hit.platform, og, res.html)) {
        return { decision: 'unknown', score: null, signals: { ogTitle: og.title?.slice(0, 60), rateLimit: true }, reason: 'rate-limited' };
    }

    const title = (og.title || '').toLowerCase();
    const desc = (og.description || '').toLowerCase();
    const htmlLower = res.html.toLowerCase();
    const signals = { ogTitle: og.title?.slice(0, 80) };
    let score = 0;

    // Original signals (re-checked)
    if (nameTokensInTitle(place.name, title)) { score++; signals.name = true; }
    if (pageContainsCity(res.html, place.city)) { score++; signals.city = true; }
    if (pageContainsDomain(res.html, place.websiteUrl)) { score++; signals.domain = true; }
    if (pageContainsPhone(res.html, place.phone)) { score++; signals.phone = true; }

    // CONCEPT 1: pizza-context + expanded blocklist + handle-name match
    const handle = (hit.url.split('/').pop() || '').toLowerCase();
    if (EXPANDED_BLOCKLIST.has(handle)) {
        score -= 3;
        signals.blocklistHit = handle;
        return { decision: 'null', score, signals, reason: 'expanded-blocklist' };
    }
    if (PIZZA_CONTEXT_RE.test(desc) || PIZZA_CONTEXT_RE.test(title)) {
        score++;
        signals.pizzaContext = true;
    }
    // Handle-name match: venue name tokens appearing in the URL handle.
    // Catches owner-named accounts where og:title shows the owner's name but
    // the handle is the venue (e.g. Lucali #199 — og:title "Mark Iacono"
    // but handle "lucali_bk"). normalizeName strips parenthesized (@handle)
    // content so the og:title check missed it.
    const nameTokens = normalizeName(place.name || '').split(/\s+/).filter(t => t.length >= 4);
    const handleStripped = handle.replace(/[._-]/g, '');
    if (nameTokens.length && nameTokens.some(t => handleStripped.includes(t))) {
        score++;
        signals.handleMatch = true;
    }

    // Decision point after Concept 1
    if (score >= 2) return { decision: 'keep', score, signals, reason: 'concept1-pass' };
    if (score <= 0) {
        // Thin-page safety net: if the page returned with no meaningful meta
        // tags, we can't reliably score it. Treat as unknown so we retry
        // rather than null out a legitimate handle. Example caught on the
        // 2026-05-24 smoke: Lucali (#199) — real venue, spare bio, IG served
        // a stripped-down variant that didn't match our rate-limit signature
        // ("Instagram" og:title) but also had no extractable content.
        if (!og.title && !og.description) {
            return {
                decision: 'unknown',
                score: null,
                signals: { ...signals, thinPage: true },
                reason: 'thin-page (no og:title/description)',
            };
        }
        return { decision: 'null', score, signals, reason: 'concept1-fail' };
    }

    // CONCEPT 2: Jaro-Winkler + followers — only for borderline score=1
    const titleClean = stripPlatformBoilerplate(og.title || '');
    if (titleClean) {
        const jw = jaroWinkler(normalizeName(place.name || ''), normalizeName(titleClean));
        signals.jaroWinkler = Math.round(jw * 100) / 100;
        if (jw >= 0.7) { score++; signals.jwMatch = true; }
    }
    const followers = extractFollowerCount(res.html, hit.platform);
    if (followers != null) {
        signals.followers = followers;
        if (followers >= 30) { score++; signals.followersOk = true; }
        else if (followers === 0) { score--; signals.zeroFollowers = true; }
    }

    if (score >= 2) return { decision: 'keep', score, signals, reason: 'concept2-pass' };
    if (score <= 0) return { decision: 'null', score, signals, reason: 'concept2-fail' };
    return { decision: 'borderline', score, signals, reason: 'still-score-1' };
}

// Log parser — extracts weak hits from the multi-source log file. Looks
// for per-row lines with "(score=1 weak)" annotation on IG=URL or FB=URL.
const HIT_LINE_RE = /^  \[(\d+)\]\s+(.+?)\s+—\s+(.+)$/;
const URL_PART_RE = /(IG|FB)=(\S+)\s+via\s+(\w+)(?:\s+\(score=(\d+)(?:\s+(weak))?\))?/g;

function parseWeakHits(logPath) {
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
            const source = pm[3];
            const score = pm[4] ? parseInt(pm[4], 10) : null;
            const isWeak = pm[5] === 'weak';
            if (score === 1 && isWeak) {
                out.push({ placeId, name, platform, url, source });
            }
        }
    }
    return out;
}

function parseArgs(argv) {
    const out = {
        apply: false,
        log: '/tmp/socials-all.log',
        limit: null,
        csv: null,
        ids: null,
        proxy: null,
        proxyToken: null,
    };
    for (const a of argv) {
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--apply') out.apply = true;
        else if (eq('log')) out.log = eq('log');
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
        else if (eq('csv')) out.csv = eq('csv');
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (eq('proxy')) out.proxy = eq('proxy');
        else if (eq('proxy-token')) out.proxyToken = eq('proxy-token');
    }
    if (!out.csv) {
        const stamp = new Date().toISOString().slice(0, 10);
        out.csv = `data/cleanup-weak-socials-${stamp}.csv`;
    }
    return out;
}

function csvEscape(v) {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function writeCsv(csvPath, rows) {
    fs.mkdirSync(path.dirname(csvPath) || '.', { recursive: true });
    const header = 'placeId,name,platform,url,decision,score,reason,signals\n';
    const lines = rows.map(r =>
        [r.placeId, r.name, r.platform, r.url, r.decision, r.score, r.reason, JSON.stringify(r.signals || {})]
            .map(csvEscape).join(',')
    );
    fs.writeFileSync(csvPath, header + lines.join('\n') + '\n');
}

async function run({ apply = false, log = '/tmp/socials-all.log', limit = null, csv = null, ids = null, proxy = null, proxyToken = null } = {}) {
    if (!csv) {
        const stamp = new Date().toISOString().slice(0, 10);
        csv = `data/cleanup-weak-socials-${stamp}.csv`;
    }
    let cohort;
    if (ids) {
        // ID-based mode: re-verify EVERY IG/FB URL on these places, regardless
        // of original score. Useful for spot-fixing rows we noticed by hand.
        const places = await prisma.place.findMany({
            where: { id: { in: ids } },
            select: { id: true, name: true, instagramUrl: true, facebookUrl: true },
        });
        cohort = [];
        for (const p of places) {
            if (p.instagramUrl) cohort.push({ placeId: p.id, name: p.name, platform: 'ig', url: p.instagramUrl, source: 'manual' });
            if (p.facebookUrl) cohort.push({ placeId: p.id, name: p.name, platform: 'fb', url: p.facebookUrl, source: 'manual' });
        }
    } else {
        if (!fs.existsSync(log)) {
            console.error(`[cleanup] log file not found: ${log}`);
            process.exit(1);
        }
        cohort = parseWeakHits(log);
    }
    // Hydrate place data once for the full cohort (before applying --limit)
    // so we can filter out rows where the URL has already been changed since
    // the source log was written. That filter has to happen BEFORE --limit
    // is applied — otherwise chunked invocations (loop with --limit=30) keep
    // hitting the same first-30 rows, instantly skipping the already-done
    // ones, never reaching cohort row 31+.
    const fullCohortIds = [...new Set(cohort.map(c => c.placeId))];
    const allPlaces = await prisma.place.findMany({
        where: { id: { in: fullCohortIds } },
        select: {
            id: true, name: true, city: true, country: true, phone: true,
            websiteUrl: true, instagramUrl: true, facebookUrl: true,
        },
    });
    const placeById = new Map(allPlaces.map(p => [p.id, p]));

    // Filter cohort to only rows whose current URL still matches the
    // recorded weak URL. Already-nulled (or replaced) rows fall out here.
    const needsWork = cohort.filter(hit => {
        const p = placeById.get(hit.placeId);
        if (!p) return false;
        const currentUrl = hit.platform === 'ig' ? p.instagramUrl : p.facebookUrl;
        return currentUrl === hit.url;
    });
    const alreadyDone = cohort.length - needsWork.length;
    cohort = needsWork;

    if (limit) cohort = cohort.slice(0, limit);
    console.log(`[cleanup] ${cohort.length} weak hits to re-verify (apply=${apply}, ${alreadyDone} already done)`);
    if (!cohort.length) { console.log('[cleanup] nothing to do.'); return { ok: true, total: 0 }; }

    const browser = await makeBrowser({ proxy, proxyToken });
    const results = [];
    const stats = { keep: 0, null: 0, unknown: 0, borderline: 0, skipped: 0, errors: 0 };

    let i = 0;
    for (const hit of cohort) {
        i++;
        const place = placeById.get(hit.placeId);
        if (!place) {
            results.push({ ...hit, decision: 'skipped', score: null, reason: 'place-not-found', signals: {} });
            stats.skipped++;
            continue;
        }
        const currentUrl = hit.platform === 'ig' ? place.instagramUrl : place.facebookUrl;
        if (currentUrl !== hit.url) {
            // Already changed (nulled in this run, or replaced by another phase).
            results.push({ ...hit, decision: 'skipped', score: null, reason: `url-changed (now: ${currentUrl})`, signals: {} });
            stats.skipped++;
            continue;
        }

        let r;
        try { r = await reverify(browser, hit, place); }
        catch (e) {
            stats.errors++;
            const errMsg = `${e.name || 'error'}: ${(e.message || '').slice(0, 200)}`;
            console.log(`  ! [${place.id}] ${place.name} ${hit.platform.toUpperCase()} → exception: ${errMsg}`);
            results.push({ ...hit, decision: 'unknown', score: null, reason: errMsg, signals: { error: errMsg } });
            continue;
        }

        results.push({ ...hit, ...r });
        stats[r.decision]++;

        const tag = `${i}/${cohort.length}`;
        const sig = Object.entries(r.signals || {})
            .filter(([k, v]) => v && k !== 'ogTitle' && k !== 'ogDesc')
            .map(([k, v]) => typeof v === 'boolean' ? k : `${k}=${v}`)
            .join(',');
        // Show og:title separately so we can debug score=0 / null cases.
        // Truncated to 50 chars to keep the line readable.
        const titleHint = r.signals?.ogTitle ? ` ogTitle="${r.signals.ogTitle.slice(0, 50)}"` : (r.decision === 'null' || r.decision === 'unknown' ? ' ogTitle=(empty)' : '');
        console.log(`  ${tag} [${place.id}] ${place.name} ${hit.platform.toUpperCase()} → ${r.decision} (score=${r.score} ${sig})${titleHint}`);

        // Apply nulls (only — keeps and unknowns are read-only outcomes).
        if (apply && r.decision === 'null') {
            const patch = hit.platform === 'ig' ? { instagramUrl: null } : { facebookUrl: null };
            try {
                await prisma.place.update({ where: { id: place.id }, data: patch });
                // Update local cache so subsequent skip-check works
                if (hit.platform === 'ig') place.instagramUrl = null;
                else place.facebookUrl = null;
            } catch (e) {
                console.warn(`    update failed: ${e.message.slice(0, 80)}`);
            }
        }

        // Jittered polite delay — stays under IG's threshold
        const delay = POLITE_MIN_MS + Math.random() * (POLITE_MAX_MS - POLITE_MIN_MS);
        await sleep(Math.round(delay));
    }

    await browser.close();
    writeCsv(csv, results);

    console.log('');
    console.log(`[cleanup] done. ${cohort.length} processed`);
    console.log(`  keep:        ${stats.keep}`);
    console.log(`  null:        ${stats.null}${apply ? ' (applied)' : ' (DRY RUN — re-run with --apply to write)'}`);
    console.log(`  borderline:  ${stats.borderline}  ← eyeball in CSV`);
    console.log(`  unknown:     ${stats.unknown}  ← rate-limited or fetch error, retry later`);
    console.log(`  skipped:     ${stats.skipped}`);
    console.log(`  errors:      ${stats.errors}`);
    console.log(`  CSV:         ${csv}`);
    return { ok: true, ...stats, total: cohort.length, csvPath: csv };
}

module.exports = { run };

if (require.main === module) {
    run(parseArgs(process.argv.slice(2)))
        .then(() => prisma.$disconnect())
        .catch((e) => { console.error(e); process.exit(1); });
}
