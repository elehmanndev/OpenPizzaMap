#!/usr/bin/env node
// One-shot: scrape gallery photos from AVPN (Associazione Verace Pizza
// Napoletana) for every place tagged source='avpn' in PlaceSource. Each
// detail page renders 1-3 photos under /public/assoc/<random>.jpg
// (suffixed 01a / 02a / 03a in their internal naming).
//
// URL→place mapping: fetch the listing once
// (https://www.pizzanapoletana.org/it/associati, ~862 rows in one HTML),
// parse rows, build map slugify(name) → detailUrl with city tiebreak.
// Match against our DB by slugify(place.name) since the import preserved
// AVPN's display name.
//
// Pipeline mirrors scrape-thegreat-pizza-photos.js — same /api/admin/
// gallery-download endpoint, same job shape, same 8-chunk pacing.
//
// Usage:
//   node scripts/admin/scrape-avpn-photos.js                # dry-run
//   node scripts/admin/scrape-avpn-photos.js --apply
//   node scripts/admin/scrape-avpn-photos.js --apply --limit=20
//   node scripts/admin/scrape-avpn-photos.js --apply --ids=1,2,3
//
// Requires HOSTINGER_URL + ADMIN_API_KEY in env.

const { prisma } = require('../lib/bootstrap');
const { slugify, canonCity } = require('../lib/utils');

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const LISTING_URL = 'https://www.pizzanapoletana.org/it/associati';
const FETCH_PACE_MS = 400;       // between detail-page fetches
const PUSH_CHUNK_SIZE = 8;
const FETCH_TIMEOUT_MS = 20000;

const HOSTINGER_URL = process.env.HOSTINGER_URL;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
    const out = { apply: false, ids: null, limit: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => (a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null);
        if (a === '--apply') out.apply = true;
        else if (eq('ids')) out.ids = eq('ids').split(',').map(Number).filter(Boolean);
        else if (eq('limit')) out.limit = parseInt(eq('limit'), 10);
    }
    return out;
}

async function fetchText(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' }, redirect: 'follow', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(t);
    }
}

function decodeEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}

// Returns Map<slug, Array<{city, name, url}>>
function parseListing(html) {
    const byKey = new Map();
    const trRe = /<tr>\s*<td>\s*(\d+)\s*<\/td>\s*<td>\s*<a\s+href="([^"]+)"[^>]*>\s*<strong>([\s\S]*?)<\/strong>\s*<\/a>\s*<\/td>\s*<td>([\s\S]*?)<\/td>/gi;
    let m;
    while ((m = trRe.exec(html)) !== null) {
        const url = m[2].trim();
        const name = decodeEntities(m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        const city = decodeEntities(m[4].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
        if (!name || !url) continue;
        const key = slugify(name);
        if (!key) continue;
        if (!byKey.has(key)) byKey.set(key, []);
        byKey.get(key).push({ name, city: canonCity(city), url });
    }
    return byKey;
}

function resolveDetailUrl(place, listing) {
    const key = slugify(place.name);
    const hits = listing.get(key);
    if (!hits || hits.length === 0) return null;
    if (hits.length === 1) return hits[0].url;
    const ourCity = canonCity(place.city);
    const exact = hits.find((h) => h.city === ourCity);
    if (exact) return exact.url;
    const loose = hits.find((h) => ourCity && (ourCity.includes(h.city) || h.city.includes(ourCity)));
    return loose ? loose.url : null;
}

// Pull all /public/assoc/ image refs from a detail page. The filename
// is the stable per-photo dedup key.
function extractImageRefs(html) {
    const found = new Map();
    const re = /https:\/\/www\.pizzanapoletana\.org\/public\/assoc\/([A-Za-z0-9_-]+\.(?:jpe?g|png|webp))/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const filename = m[1];
        if (!found.has(filename)) {
            found.set(filename, m[0]);
        }
    }
    return Array.from(found.entries()).map(([filename, sourceUrl]) => ({
        sourceRef: filename,
        sourceUrl,
    }));
}

async function pushJobs(jobs) {
    if (!HOSTINGER_URL || !ADMIN_API_KEY) {
        return { ok: false, error: 'HOSTINGER_URL or ADMIN_API_KEY not set' };
    }
    const url = `${HOSTINGER_URL}/api/admin/gallery-download`;
    const chunks = [];
    for (let i = 0; i < jobs.length; i += PUSH_CHUNK_SIZE) chunks.push(jobs.slice(i, i + PUSH_CHUNK_SIZE));
    const totals = { processed: 0, inserted: 0, skipped: 0, failed: 0, chunkFails: 0 };
    const errors = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'x-api-key': ADMIN_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobs: chunks[i] }),
            });
            const body = await res.text().catch(() => '');
            if (!res.ok) {
                totals.chunkFails++;
                errors.push(`chunk ${i + 1}/${chunks.length}: ${res.status} ${body.slice(0, 120)}`);
                continue;
            }
            const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
            if (parsed) {
                totals.processed += parsed.processed || 0;
                totals.inserted += parsed.inserted || 0;
                totals.skipped += parsed.skipped || 0;
                totals.failed += parsed.failed || 0;
            }
            console.log(`  chunk ${i + 1}/${chunks.length}: inserted=${parsed?.inserted || 0} skipped=${parsed?.skipped || 0} failed=${parsed?.failed || 0}`);
        } catch (err) {
            totals.chunkFails++;
            errors.push(`chunk ${i + 1}/${chunks.length}: ${err.message}`);
        }
    }
    return { ok: totals.chunkFails === 0, chunks: chunks.length, ...totals, errors };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));

    // 1. Candidates: visible places tagged source='avpn'
    let placeWhere = { isVisible: true };
    if (args.ids) placeWhere = { id: { in: args.ids } };

    const candidates = await prisma.place.findMany({
        where: {
            ...placeWhere,
            sources: { some: { source: 'avpn' } },
        },
        select: { id: true, name: true, city: true, slug: true },
        orderBy: { id: 'asc' },
    });

    console.log(`[avpn-photos] candidates=${candidates.length}`);
    if (!candidates.length) return;

    // 2. Listing → slug map
    console.log(`[avpn-photos] fetching listing ${LISTING_URL}…`);
    const listingHtml = await fetchText(LISTING_URL);
    const listing = parseListing(listingHtml);
    const entryCount = [...listing.values()].reduce((s, a) => s + a.length, 0);
    console.log(`[avpn-photos] listing entries=${entryCount} unique-slugs=${listing.size}`);

    // 3. Resolve URL per candidate
    const resolved = [];
    const unresolved = [];
    for (const p of candidates) {
        const url = resolveDetailUrl(p, listing);
        if (url) resolved.push({ place: p, url });
        else unresolved.push(p);
    }
    console.log(`[avpn-photos] resolved=${resolved.length}  unresolved=${unresolved.length}`);
    if (unresolved.length && unresolved.length <= 30) {
        console.log('  unresolved:', unresolved.map((p) => `#${p.id} "${p.name}" (${p.city})`).join('  |  '));
    }

    const batch = args.limit ? resolved.slice(0, args.limit) : resolved;
    console.log(`[avpn-photos] processing=${batch.length}  apply=${args.apply}`);

    // 4. Pre-skip refs already in PlaceImage for these places (source='avpn')
    const placeIds = batch.map((b) => b.place.id);
    const existing = await prisma.placeImage.findMany({
        where: { placeId: { in: placeIds }, source: 'avpn' },
        select: { placeId: true, sourceRef: true },
    });
    const haveByPlace = new Map();
    for (const e of existing) {
        if (!haveByPlace.has(e.placeId)) haveByPlace.set(e.placeId, new Set());
        haveByPlace.get(e.placeId).add(e.sourceRef);
    }

    // 5. Fetch detail pages, extract photos
    const jobs = [];
    const stats = { fetched: 0, fetchErrors: 0, totalRefs: 0, freshRefs: 0, placesWithFresh: 0 };
    const progressEvery = Math.max(1, Math.floor(batch.length / 20));

    for (let i = 0; i < batch.length; i++) {
        const { place, url } = batch[i];
        if (i % progressEvery === 0 || i === batch.length - 1) {
            process.stdout.write(`\r[${i + 1}/${batch.length}] fetched=${stats.fetched} fresh=${stats.freshRefs}   `);
        }
        let html;
        try {
            html = await fetchText(url);
            stats.fetched++;
        } catch (_err) {
            stats.fetchErrors++;
            await sleep(FETCH_PACE_MS);
            continue;
        }
        const refs = extractImageRefs(html);
        stats.totalRefs += refs.length;
        const have = haveByPlace.get(place.id) || new Set();
        const fresh = refs.filter((r) => !have.has(r.sourceRef));
        stats.freshRefs += fresh.length;
        if (fresh.length) {
            jobs.push({
                placeId: place.id,
                slug: place.slug,
                source: 'avpn',
                photos: fresh,
            });
            stats.placesWithFresh++;
        }
        await sleep(FETCH_PACE_MS);
    }
    process.stdout.write('\n');

    console.log(`[avpn-photos] scrape done — fetched=${stats.fetched}  fetchErrors=${stats.fetchErrors}  totalRefs=${stats.totalRefs}  freshRefs=${stats.freshRefs}  placesWithFresh=${stats.placesWithFresh}`);

    if (!args.apply) {
        console.log('[avpn-photos] DRY-RUN — pass --apply to POST jobs to Hostinger.');
        return;
    }
    if (!jobs.length) {
        console.log('[avpn-photos] no fresh jobs to push.');
        return;
    }
    console.log(`[avpn-photos] pushing ${jobs.length} jobs (${stats.freshRefs} photos) to ${HOSTINGER_URL}/api/admin/gallery-download in chunks of ${PUSH_CHUNK_SIZE}…`);
    const result = await pushJobs(jobs);
    console.log(`[avpn-photos] push result:`, result);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
