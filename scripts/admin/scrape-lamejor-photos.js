#!/usr/bin/env node
// One-shot: scrape gallery photos from lamejorpizza.es for every place
// tagged source='lamejorpizza' in PlaceSource. Each detail page renders
// up to 5 curated dish photos under `alt="Foto producto N"`.
//
// URL→place mapping: fetch home once (single HTML, ~152KB), parse anchors
// like `participante/{id}/{venueSlug}[/{pizzaSlug}]`, build a slug→URL
// map. Match against our DB by slugify(place.name) since the importer
// preserved lamejor's display name.
//
// Pipeline mirrors scrape-thegreat-pizza-photos.js / scrape-avpn-photos.js.
// Same /api/admin/gallery-download endpoint, same job shape (source:
// 'lamejorpizza'), same 8-chunk pacing.
//
// Usage:
//   node scripts/admin/scrape-lamejor-photos.js                # dry-run
//   node scripts/admin/scrape-lamejor-photos.js --apply
//   node scripts/admin/scrape-lamejor-photos.js --apply --limit=10
//
// Requires HOSTINGER_URL + ADMIN_API_KEY in env.

const { prisma } = require('../lib/bootstrap');
const { slugify, canonCity } = require('../lib/utils');

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const HOME_URL = 'https://lamejorpizza.es/es/';
const REFERER = 'https://lamejorpizza.es/es/';
const ASSET_ROOT = 'https://lamejorpizza.es/';
const FETCH_PACE_MS = 500;
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
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': REFERER },
            redirect: 'follow',
            signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
    } finally { clearTimeout(t); }
}

// Returns Map<venueSlug, {id, url}> — first occurrence per id wins.
function parseHome(html) {
    const map = new Map();
    const re = /href="(participante\/(\d+)\/([a-z0-9_-]+)(?:\/[a-z0-9_-]+)?)"/gi;
    let m;
    const seenIds = new Set();
    while ((m = re.exec(html)) !== null) {
        const id = parseInt(m[2], 10);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        const venueSlug = m[3].toLowerCase();
        const url = `https://lamejorpizza.es/es/${m[1]}`;
        if (!map.has(venueSlug)) map.set(venueSlug, []);
        map.get(venueSlug).push({ id, url });
    }
    return map;
}

function resolveDetailUrl(place, home) {
    const key = slugify(place.name);
    const hits = home.get(key);
    if (!hits || hits.length === 0) return null;
    return hits[0].url;   // first wins; venueSlug + city already disambiguates in practice
}

// Pull `Foto producto N` images. Filename is the stable sourceRef
// (per-place uniqueness comes from placeId_sourceRef).
function extractImageRefs(html) {
    const found = new Map();
    const re = /<img[^>]+src="((?:\.\.\/|https:\/\/lamejorpizza\.es\/)html5Upload\/[^"]+\.(?:jpe?g|png|webp))"[^>]*alt="Foto producto[^"]*"/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        let url = m[1];
        // Normalize `../html5Upload/...` → absolute
        url = url.replace(/^\.\.\//, ASSET_ROOT);
        const filename = url.split('/').pop();
        if (!found.has(filename)) found.set(filename, url);
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

    // 1. Candidates
    let placeWhere = { isVisible: true };
    if (args.ids) placeWhere = { id: { in: args.ids } };

    const candidates = await prisma.place.findMany({
        where: { ...placeWhere, sources: { some: { source: 'lamejorpizza' } } },
        select: { id: true, name: true, city: true, slug: true },
        orderBy: { id: 'asc' },
    });
    console.log(`[lmp-photos] candidates=${candidates.length}`);
    if (!candidates.length) return;

    // 2. Home → URL map
    console.log(`[lmp-photos] fetching home ${HOME_URL}…`);
    const homeHtml = await fetchText(HOME_URL);
    const home = parseHome(homeHtml);
    const total = [...home.values()].reduce((s, a) => s + a.length, 0);
    console.log(`[lmp-photos] home entries=${total} unique-slugs=${home.size}`);

    // 3. Resolve
    const resolved = [];
    const unresolved = [];
    for (const p of candidates) {
        const url = resolveDetailUrl(p, home);
        if (url) resolved.push({ place: p, url });
        else unresolved.push(p);
    }
    console.log(`[lmp-photos] resolved=${resolved.length}  unresolved=${unresolved.length}`);
    if (unresolved.length && unresolved.length <= 30) {
        console.log('  unresolved:', unresolved.map((p) => `#${p.id} "${p.name}" (${p.city})`).join('  |  '));
    }

    const batch = args.limit ? resolved.slice(0, args.limit) : resolved;
    console.log(`[lmp-photos] processing=${batch.length}  apply=${args.apply}`);

    // 4. Pre-skip refs already in PlaceImage (source='lamejorpizza')
    const placeIds = batch.map((b) => b.place.id);
    const existing = await prisma.placeImage.findMany({
        where: { placeId: { in: placeIds }, source: 'lamejorpizza' },
        select: { placeId: true, sourceRef: true },
    });
    const haveByPlace = new Map();
    for (const e of existing) {
        if (!haveByPlace.has(e.placeId)) haveByPlace.set(e.placeId, new Set());
        haveByPlace.get(e.placeId).add(e.sourceRef);
    }

    // 5. Fetch detail pages
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
                source: 'lamejorpizza',
                photos: fresh,
            });
            stats.placesWithFresh++;
        }
        await sleep(FETCH_PACE_MS);
    }
    process.stdout.write('\n');

    console.log(`[lmp-photos] scrape done — fetched=${stats.fetched}  fetchErrors=${stats.fetchErrors}  totalRefs=${stats.totalRefs}  freshRefs=${stats.freshRefs}  placesWithFresh=${stats.placesWithFresh}`);

    if (!args.apply) {
        console.log('[lmp-photos] DRY-RUN — pass --apply to POST jobs to Hostinger.');
        return;
    }
    if (!jobs.length) {
        console.log('[lmp-photos] no fresh jobs to push.');
        return;
    }
    console.log(`[lmp-photos] pushing ${jobs.length} jobs (${stats.freshRefs} photos) to ${HOSTINGER_URL}/api/admin/gallery-download in chunks of ${PUSH_CHUNK_SIZE}…`);
    const result = await pushJobs(jobs);
    console.log(`[lmp-photos] push result:`, result);
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
