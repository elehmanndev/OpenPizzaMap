#!/usr/bin/env node
// One-shot: scrape gallery photos from thegreat.pizza for every place tagged
// source='thegreat.pizza' in PlaceSource. Each detail page renders ~8-14
// IMG_*.jpeg refs under assets.thegreat.pizza/images/YYYY/MM/. We POST the
// resulting job list to Hostinger's /api/admin/gallery-download which
// downloads the bytes, writes them to <persistent>/uploads/places/<id>/,
// generates thumb+large variants, and inserts PlaceImage rows (dedup via
// the placeId_sourceRef unique constraint).
//
// URL→place mapping comes from their two pizzerie-sitemaps (560 detail URLs
// total). We key by slugify(place.name) → URL last-segment, with city used
// as a tiebreaker when the slug collides.
//
// Usage:
//   node scripts/admin/scrape-thegreat-pizza-photos.js                 # dry-run, all candidates
//   node scripts/admin/scrape-thegreat-pizza-photos.js --apply
//   node scripts/admin/scrape-thegreat-pizza-photos.js --apply --limit=10
//   node scripts/admin/scrape-thegreat-pizza-photos.js --apply --ids=1,2,3
//
// Requires HOSTINGER_URL + ADMIN_API_KEY in env (same as the runner).

const { prisma } = require('../lib/bootstrap');
const { slugify, canonCity } = require('../lib/utils');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
const SITEMAPS = [
    'https://thegreat.pizza/pizzerie-sitemap.xml',
    'https://thegreat.pizza/pizzerie-sitemap2.xml',
];
const FETCH_PACE_MS = 500;       // between detail-page fetches
const PUSH_CHUNK_SIZE = 8;       // matches runner.js pushGalleryJobs
const FETCH_TIMEOUT_MS = 15000;

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
        const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow', signal: ctrl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally {
        clearTimeout(t);
    }
}

// Returns Map<slug, Array<{city, url}>>
async function loadSitemap() {
    const byKey = new Map();
    for (const sm of SITEMAPS) {
        const xml = await fetchText(sm);
        const re = /<loc>(https:\/\/thegreat\.pizza\/pizzerie\/([^/]+)\/([^/]+)\/)<\/loc>/g;
        let m;
        while ((m = re.exec(xml)) !== null) {
            const [, url, city, slug] = m;
            const key = slug.toLowerCase();
            if (!byKey.has(key)) byKey.set(key, []);
            byKey.get(key).push({ city: canonCity(city), url });
        }
    }
    return byKey;
}

function resolveDetailUrl(place, sitemap) {
    const key = slugify(place.name);
    const hits = sitemap.get(key);
    if (!hits || hits.length === 0) return null;
    if (hits.length === 1) return hits[0].url;
    // multiple slug collisions — tiebreak by city
    const ourCity = canonCity(place.city);
    const exact = hits.find((h) => h.city === ourCity);
    if (exact) return exact.url;
    // last resort: substring overlap
    const loose = hits.find((h) => ourCity.includes(h.city) || h.city.includes(ourCity));
    return loose ? loose.url : null;
}

// Pull all assets.thegreat.pizza IMG_*.{jpeg,jpg,png,webp} refs from a detail
// page. Strips ?w=&h= and -scaled variants (prefer full-res original).
function extractImageRefs(html) {
    const found = new Map(); // filename → sourceUrl
    const re = /https:\/\/assets\.thegreat\.pizza\/images\/(\d{4})\/(\d{2})\/([A-Za-z0-9_-]+\.(?:jpe?g|png|webp))/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const [full, , , filename] = m;
        // Collapse `IMG_1264-scaled.jpeg` → `IMG_1264.jpeg`; prefer the
        // non-scaled version when both appear.
        const canon = filename.replace(/-scaled(\.[a-z]+)$/i, '$1');
        if (/^(header|logo|icon|favicon|cropped-fav)/i.test(canon)) continue;
        // Skip the theme directory entirely (already filtered by regex above
        // because it's /images/theme/, not /images/YYYY/MM/, so we're fine).
        const existing = found.get(canon);
        if (!existing || /-scaled/i.test(existing)) {
            // Replace if we have nothing or only the scaled variant.
            found.set(canon, full);
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

    // 1. Candidates: visible places tagged source='thegreat.pizza'
    let placeWhere = { isVisible: true };
    if (args.ids) placeWhere = { id: { in: args.ids } };

    const candidates = await prisma.place.findMany({
        where: {
            ...placeWhere,
            sources: { some: { source: 'thegreat.pizza' } },
        },
        select: { id: true, name: true, city: true, slug: true },
        orderBy: { id: 'asc' },
    });

    console.log(`[gp-photos] candidates=${candidates.length}`);
    if (!candidates.length) return;

    // 2. Sitemap → slug map (560 entries expected)
    console.log('[gp-photos] loading sitemaps…');
    const sitemap = await loadSitemap();
    console.log(`[gp-photos] sitemap entries=${[...sitemap.values()].reduce((s, a) => s + a.length, 0)} unique-slugs=${sitemap.size}`);

    // 3. Resolve URL per candidate
    const resolved = [];
    const unresolved = [];
    for (const p of candidates) {
        const url = resolveDetailUrl(p, sitemap);
        if (url) resolved.push({ place: p, url });
        else unresolved.push(p);
    }
    console.log(`[gp-photos] resolved=${resolved.length}  unresolved=${unresolved.length}`);
    if (unresolved.length && unresolved.length <= 30) {
        console.log('  unresolved:', unresolved.map((p) => `#${p.id} "${p.name}" (${p.city})`).join('  |  '));
    }

    const batch = args.limit ? resolved.slice(0, args.limit) : resolved;
    console.log(`[gp-photos] processing=${batch.length}  apply=${args.apply}`);

    // 4. For each, fetch detail page + extract images. Skip refs already in DB.
    const placeIds = batch.map((b) => b.place.id);
    const existing = await prisma.placeImage.findMany({
        where: { placeId: { in: placeIds }, source: 'thegreat.pizza' },
        select: { placeId: true, sourceRef: true },
    });
    const haveByPlace = new Map();
    for (const e of existing) {
        if (!haveByPlace.has(e.placeId)) haveByPlace.set(e.placeId, new Set());
        haveByPlace.get(e.placeId).add(e.sourceRef);
    }

    const jobs = [];
    const stats = { fetched: 0, fetchErrors: 0, totalRefs: 0, freshRefs: 0, placesWithFresh: 0 };

    for (let i = 0; i < batch.length; i++) {
        const { place, url } = batch[i];
        process.stdout.write(`[${i + 1}/${batch.length}] #${place.id} "${place.name}" → ${url} … `);
        let html;
        try {
            html = await fetchText(url);
            stats.fetched++;
        } catch (err) {
            console.log(`FETCH FAIL ${err.message.slice(0, 60)}`);
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
                source: 'thegreat.pizza',
                photos: fresh,
            });
            stats.placesWithFresh++;
            console.log(`${refs.length} refs (${fresh.length} fresh)`);
        } else {
            console.log(`${refs.length} refs (0 fresh — already have)`);
        }
        await sleep(FETCH_PACE_MS);
    }

    console.log('');
    console.log(`[gp-photos] scrape done — fetched=${stats.fetched}  fetchErrors=${stats.fetchErrors}  totalRefs=${stats.totalRefs}  freshRefs=${stats.freshRefs}  placesWithFresh=${stats.placesWithFresh}`);

    if (!args.apply) {
        console.log('[gp-photos] DRY-RUN — pass --apply to POST jobs to Hostinger.');
        return;
    }

    if (!jobs.length) {
        console.log('[gp-photos] no fresh jobs to push.');
        return;
    }

    console.log(`[gp-photos] pushing ${jobs.length} jobs (${stats.freshRefs} photos) to ${HOSTINGER_URL}/api/admin/gallery-download in chunks of ${PUSH_CHUNK_SIZE}…`);
    const result = await pushJobs(jobs);
    console.log(`[gp-photos] push result:`, result);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
