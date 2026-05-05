#!/usr/bin/env node
// Backfill heroImageUrl on the 102 LMP rows imported on 2026-05-02.
//
// The original LMP scraper's hero regex looked for absolute URLs with
// class="card-img-top", but lamejorpizza.es serves hero images via
// relative `../html5Upload/...` URLs with alt="Foto producto N" — so the
// regex never matched and 102/102 imports landed with heroImageUrl=null.
//
// scrape-lamejorpizza.js is now patched. This one-shot re-fetches each
// LMP detail page, runs the corrected matcher, and fills the hero on any
// DB row that's still null. Idempotent — already-set rows are skipped.

const path = require('path');
const fs = require('fs');
const { prisma, PATHS } = require('../lib/bootstrap');

const SCRAPE_JSON = path.join(PATHS.scrapes, 'lamejorpizza-scrape.json');

const UA = 'OpenPizzaMap/0.1 (eric@openpizzamap.com)';
const FETCH_DELAY_MS = 600;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function norm(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractHero(html) {
    const patterns = [
        /<img[^>]+src="(\.\.\/html5Upload\/[^"]+)"[^>]*alt="Foto producto/i,
        /<img[^>]+src="(https:\/\/lamejorpizza\.es\/html5Upload\/[^"]+)"[^>]*alt="Foto producto/i,
        /<img[^>]+src="(\.\.\/html5Upload\/[^"]+)"[^>]*class="card-img-top"/i,
        /<img[^>]+src="(https:\/\/lamejorpizza\.es\/html5Upload\/[^"]+)"/i,
    ];
    let url = null;
    for (const re of patterns) {
        const m = html.match(re);
        if (m) { url = m[1]; break; }
    }
    if (!url) return null;
    const m2 = url.match(/(?:^\.\.\/|^https:\/\/lamejorpizza\.es\/(?:[^/]+\/)*)?(html5Upload\/.+)$/i);
    return m2 ? `https://lamejorpizza.es/${m2[1]}` : url;
}

async function fetchHtml(url, attempt = 1) {
    try {
        const res = await fetch(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html', 'Referer': 'https://lamejorpizza.es/es/' },
        });
        if (!res.ok) throw new Error(`http ${res.status}`);
        return await res.text();
    } catch (e) {
        if (attempt < 3) { await sleep(2000 * attempt); return fetchHtml(url, attempt + 1); }
        throw e;
    }
}

async function main() {
    const data = JSON.parse(fs.readFileSync(SCRAPE_JSON, 'utf8'));
    const candidates = data.places.filter((v) => v.quality_pass === true);
    console.log(`[lmp-hero] ${candidates.length} quality-passed LMP venues to backfill`);

    // Pull all DB Spain rows for matching by normalised name.
    const dbRows = await prisma.place.findMany({
        where: { country: 'Spain', status: 'active' },
        select: { id: true, name: true, city: true, heroImageUrl: true },
    });
    const dbByName = new Map();
    for (const r of dbRows) {
        const k = norm(r.name);
        if (!dbByName.has(k)) dbByName.set(k, r);
    }

    let fetched = 0, matched = 0, alreadySet = 0, updated = 0, noHeroOnPage = 0, missingDb = 0, fetchFail = 0;
    for (let i = 0; i < candidates.length; i++) {
        const v = candidates[i];
        const ln = norm(v.name);
        let row = dbByName.get(ln);
        if (!row) {
            // Chain disambiguation (DB "Infraganti" vs LMP "Infraganti Pizza Bar Alicante").
            for (const [dn, r] of dbByName) {
                if (dn.length >= 6 && (ln === dn || ln.startsWith(dn + ' '))) { row = r; break; }
            }
        }
        if (!row) { missingDb++; console.warn(`  [no-db] LMP id=${v.id} ${v.name}`); continue; }
        matched++;
        if (row.heroImageUrl) { alreadySet++; continue; }

        let html;
        try { html = await fetchHtml(v.detailUrl); fetched++; }
        catch (e) { fetchFail++; console.warn(`  [fetch-fail] ${v.detailUrl}: ${e.message}`); continue; }

        const hero = extractHero(html);
        if (!hero) { noHeroOnPage++; continue; }

        await prisma.place.update({ where: { id: row.id }, data: { heroImageUrl: hero } });
        updated++;
        if (updated % 10 === 0) console.log(`  [progress] ${updated} updated of ${matched - alreadySet} candidates`);
        await sleep(FETCH_DELAY_MS);
    }

    console.log(`\n[done] candidates=${candidates.length} matched=${matched} already-set=${alreadySet} fetched=${fetched} updated=${updated} no-hero-on-page=${noHeroOnPage} fetch-fail=${fetchFail} no-db-match=${missingDb}`);
    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); prisma.$disconnect().finally(() => process.exit(1)); });
