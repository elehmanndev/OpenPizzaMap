#!/usr/bin/env node
// Cleanup pass for the score=1 weak IG cohort using Apify's official
// instagram-profile-scraper actor. Same scoring logic and decisions as
// cleanup-weak-socials.js, but the verification data comes from Apify's
// JSON dump instead of our CloakBrowser-fetched HTML — defeats the IG
// rate-limit that traps the in-house pass on our single Unraid IP.
//
// FB is NOT handled by this script (no equivalent free actor matches
// our budget). The in-house cleanup script handles FB once IG cools.
//
// Pricing (per Apify free tier): $0.0026/profile.
// For ~800-900 IG weak hits in our cohort: $2.10-2.34 — fits Eric's $4.
//
// Workflow:
//   1. Parse /tmp/socials-all.log for "(score=1 weak)" IG entries
//   2. Filter to rows whose IG URL still matches the recorded weak URL
//      (URL-still-matches — same logic as the in-house cleanup chunking fix)
//   3. Show cost estimate, abort if --apply was not specified
//   4. Call apify/instagram-profile-scraper with the usernames
//   5. Map each profile result back to our scoring rules (Concept 1 + 2)
//   6. Write keep/null decisions + CSV
//
// Usage:
//   APIFY_TOKEN=apify_api_xxx node scripts/admin/cleanup-weak-socials-via-apify.js          # dry-run cost estimate
//   APIFY_TOKEN=apify_api_xxx node scripts/admin/cleanup-weak-socials-via-apify.js --apply  # write
//   node scripts/admin/cleanup-weak-socials-via-apify.js --token=apify_api_xxx --limit=50 --apply
//
// CSV output: data/cleanup-weak-socials-via-apify-YYYY-MM-DD.csv

const fs = require('fs');
const path = require('path');
const { prisma } = require('../lib/bootstrap');
const { jaroWinkler, normalizeName, sleep } = require('../lib/utils');

const ACTOR_ID = 'apify~instagram-profile-scraper';
const COST_PER_PROFILE_USD = 0.0026; // FREE-tier rate, may differ on paid plans
const BATCH_SIZE = 100;              // usernames per actor run — keep under 5min sync limit

const PIZZA_CONTEXT_RE = /pizza|pizzeria|napoletan|forno|focaccia|wood.?fired|pizzaiolo|pizzaiola/i;

const EXPANDED_BLOCKLIST = new Set([
    'meta', 'squarespace', 'wix', 'shopify', 'instagram', 'facebook', 'fb',
    'share', 'sharer', 'login', 'help', 'about', 'developer', 'developers',
    'en', 'fr', 'it', 'es', 'de', 'pt', 'nl', 'ru', 'ja', 'zh',
    'pizza', 'cafe', 'restaurant', 'food', 'eats', 'home',
]);

// Pulls the username from an instagram.com/<username>(/) URL.
function handleFromUrl(url) {
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean);
        return seg[0]?.toLowerCase() || null;
    } catch { return null; }
}

// Log parser (mirrors cleanup-weak-socials.js but IG-only).
const HIT_LINE_RE = /^  \[(\d+)\]\s+(.+?)\s+—\s+(.+)$/;
const URL_PART_RE = /(IG|FB)=(\S+)\s+via\s+(\w+)(?:\s+\(score=(\d+)(?:\s+(weak))?\))?/g;

function parseWeakIgHits(logPath) {
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
            if (platform === 'ig' && score === 1 && isWeak) {
                out.push({ placeId, name, platform, url });
            }
        }
    }
    return out;
}

// Score a single Apify profile object against the DB row using the same
// rules as cleanup-weak-socials.js Concept 1 + 2.
function scoreProfile(profile, place, handle) {
    if (!profile || profile.error) {
        return { decision: 'unknown', score: null, signals: { error: profile?.error || 'no-data' }, reason: 'apify-no-data' };
    }
    if (profile.private) {
        // Private profile — can't read bio. Conservative: keep as unknown.
        return { decision: 'unknown', score: null, signals: { private: true, fullName: profile.fullName }, reason: 'private-profile' };
    }

    const signals = {
        fullName: profile.fullName?.slice(0, 80),
        followers: profile.followersCount,
    };
    let score = 0;

    const fullName = (profile.fullName || '').toLowerCase();
    const bio = (profile.biography || '').toLowerCase();
    const externalUrl = (profile.externalUrl || '').toLowerCase();

    // Name token in fullName (display name)
    const nameTokens = normalizeName(place.name || '').split(/\s+/).filter(t => t.length >= 4);
    const fullNameNorm = normalizeName(fullName);
    if (nameTokens.length && nameTokens.some(t => fullNameNorm.includes(t))) {
        score++;
        signals.name = true;
    }

    // City in bio
    if (place.city && place.city.length >= 4 && bio.includes(place.city.toLowerCase())) {
        score++;
        signals.city = true;
    }

    // Website domain back-reference: profile's externalUrl host matches our websiteUrl host
    if (place.websiteUrl && externalUrl) {
        try {
            const ourHost = new URL(place.websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
            const theirHost = new URL(externalUrl).hostname.replace(/^www\./, '').toLowerCase();
            if (ourHost === theirHost) {
                score += 2; // domain back-reference is very strong — venue actively links to its own site
                signals.domain = ourHost;
            } else if (ourHost.length >= 5 && (bio.includes(ourHost) || bio.includes(ourHost.split('.')[0]))) {
                score++;
                signals.domain = 'in-bio';
            }
        } catch { /* ignore */ }
    } else if (place.websiteUrl && bio) {
        try {
            const host = new URL(place.websiteUrl).hostname.replace(/^www\./, '').toLowerCase();
            const stem = host.split('.')[0];
            if (host.length >= 5 && bio.includes(host)) {
                score++;
                signals.domain = 'in-bio';
            } else if (stem.length >= 5 && bio.includes(stem)) {
                score++;
                signals.domain = 'stem-in-bio';
            }
        } catch { /* ignore */ }
    }

    // Phone match in bio
    if (place.phone) {
        const digits = place.phone.replace(/\D/g, '');
        if (digits.length >= 7 && bio.replace(/\D/g, '').includes(digits.slice(-7))) {
            score++;
            signals.phone = true;
        }
    }

    // CONCEPT 1: pizza-context + expanded blocklist + handle match
    if (EXPANDED_BLOCKLIST.has(handle)) {
        score -= 3;
        signals.blocklistHit = handle;
        return { decision: 'null', score, signals, reason: 'expanded-blocklist' };
    }
    if (PIZZA_CONTEXT_RE.test(bio) || PIZZA_CONTEXT_RE.test(fullName)) {
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

    // CONCEPT 2: Jaro-Winkler + followers — for score=1 borderline
    if (fullName) {
        const jw = jaroWinkler(normalizeName(place.name || ''), normalizeName(fullName));
        signals.jaroWinkler = Math.round(jw * 100) / 100;
        if (jw >= 0.7) { score++; signals.jwMatch = true; }
    }
    if (profile.followersCount != null) {
        if (profile.followersCount >= 30) { score++; signals.followersOk = true; }
        else if (profile.followersCount === 0) { score--; signals.zeroFollowers = true; }
    }

    if (score >= 2) return { decision: 'keep', score, signals, reason: 'concept2-pass' };
    if (score <= 0) return { decision: 'null', score, signals, reason: 'concept2-fail' };
    return { decision: 'borderline', score, signals, reason: 'still-score-1' };
}

// Calls Apify's run-sync-get-dataset-items endpoint. Returns the array of
// profile objects directly. Times out at 5min on Apify's side — caller is
// responsible for keeping batch size manageable.
async function callApifyBatch(usernames, token) {
    const url = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ usernames }),
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
    const out = { apply: false, log: '/tmp/socials-all.log', limit: null, csv: null, token: null };
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

async function run({ apply = false, log = '/tmp/socials-all.log', limit = null, csv = null, token = null } = {}) {
    if (!token) {
        console.error('ERROR: Apify API token required. Pass --token=apify_api_xxx or set APIFY_TOKEN env.');
        console.error('       Get a token at https://console.apify.com/settings/integrations');
        process.exit(1);
    }
    if (!csv) {
        const stamp = new Date().toISOString().slice(0, 10);
        csv = `data/cleanup-weak-socials-via-apify-${stamp}.csv`;
    }
    if (!fs.existsSync(log)) {
        console.error(`[apify-cleanup] log file not found: ${log}`);
        process.exit(1);
    }

    let cohort = parseWeakIgHits(log);
    console.log(`[apify-cleanup] parsed ${cohort.length} score=1 weak IG entries from ${log}`);
    if (!cohort.length) { console.log('[apify-cleanup] nothing to do.'); return { ok: true, total: 0 }; }

    // Hydrate place data + filter to URL-still-matches
    const placeIds = [...new Set(cohort.map(c => c.placeId))];
    const places = await prisma.place.findMany({
        where: { id: { in: placeIds } },
        select: {
            id: true, name: true, city: true, country: true, phone: true,
            websiteUrl: true, instagramUrl: true,
        },
    });
    const placeById = new Map(places.map(p => [p.id, p]));

    const needsWork = cohort.filter(hit => {
        const p = placeById.get(hit.placeId);
        return p && p.instagramUrl === hit.url;
    });
    const alreadyDone = cohort.length - needsWork.length;
    cohort = needsWork;
    if (limit) cohort = cohort.slice(0, limit);

    const estCost = (cohort.length * COST_PER_PROFILE_USD).toFixed(2);
    console.log(`[apify-cleanup] ${cohort.length} to verify (${alreadyDone} already done) — est cost $${estCost}`);
    if (!apply) {
        console.log(`[apify-cleanup] DRY RUN — re-run with --apply to actually send to Apify.`);
        return { ok: true, total: cohort.length, estCost, dryRun: true };
    }
    if (!cohort.length) return { ok: true, total: 0 };

    // Build username → cohort-entry map (so we can look up the place when the
    // actor returns results in arbitrary order)
    const cohortByHandle = new Map();
    for (const hit of cohort) {
        const h = handleFromUrl(hit.url);
        if (h) cohortByHandle.set(h, hit);
    }
    const usernames = [...cohortByHandle.keys()];

    // Send to Apify in batches
    const results = [];
    const stats = { keep: 0, null: 0, unknown: 0, borderline: 0, skipped: 0, errors: 0 };
    for (let i = 0; i < usernames.length; i += BATCH_SIZE) {
        const batch = usernames.slice(i, i + BATCH_SIZE);
        console.log(`[apify-cleanup] batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(usernames.length / BATCH_SIZE)}: ${batch.length} usernames`);
        let profiles;
        try { profiles = await callApifyBatch(batch, token); }
        catch (e) {
            console.error(`[apify-cleanup] batch failed: ${e.message}`);
            for (const username of batch) {
                const hit = cohortByHandle.get(username);
                results.push({ placeId: hit.placeId, name: hit.name, handle: username, decision: 'unknown', score: null, reason: 'batch-error', signals: { error: e.message.slice(0, 120) } });
                stats.unknown++;
            }
            continue;
        }
        const profileByHandle = new Map();
        for (const p of profiles) {
            const h = (p.username || '').toLowerCase();
            if (h) profileByHandle.set(h, p);
        }
        for (const username of batch) {
            const hit = cohortByHandle.get(username);
            const place = placeById.get(hit.placeId);
            const profile = profileByHandle.get(username);
            const r = scoreProfile(profile, place, username);

            const sig = Object.entries(r.signals || {})
                .filter(([k, v]) => v && k !== 'fullName')
                .map(([k, v]) => typeof v === 'boolean' ? k : `${k}=${v}`)
                .join(',');
            console.log(`  [${hit.placeId}] ${hit.name} @${username} → ${r.decision} (score=${r.score} ${sig})`);

            results.push({ placeId: hit.placeId, name: hit.name, handle: username, ...r });
            stats[r.decision]++;

            // Apply nulls
            if (r.decision === 'null') {
                try {
                    await prisma.place.update({ where: { id: hit.placeId }, data: { instagramUrl: null } });
                } catch (e) {
                    console.warn(`    update failed: ${e.message.slice(0, 80)}`);
                }
            }
        }
    }

    writeCsv(csv, results);
    console.log('');
    console.log(`[apify-cleanup] done. ${cohort.length} processed`);
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
