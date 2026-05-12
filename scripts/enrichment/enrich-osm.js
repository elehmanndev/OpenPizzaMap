#!/usr/bin/env node
// Fill missing metadata (phone, websiteUrl, openingHours, address) from
// OpenStreetMap via the Overpass API.
//
// Usage:
//   node scripts/enrichment/enrich-osm.js              # dry-run, prints findings
//   node scripts/enrichment/enrich-osm.js --apply      # write to DB
//   node scripts/enrichment/enrich-osm.js --ids=1,2,3  # specific place IDs
//   node scripts/enrichment/enrich-osm.js --limit=N    # cap candidates per run
//   node scripts/enrichment/enrich-osm.js --radius=N   # search radius in metres
//
// Target queue: visible places where ANY of phone / websiteUrl /
// openingHours is null, ordered NULL osmCheckedAt first, then oldest
// check. Mirrors the resolve-via-gmaps queue ordering so the OSM phase
// drains the same long-tail backlog.
//
// Fill-only-if-null on every metadata field — never overwrite existing
// values. Always stamps osmCheckedAt so no-op rows drop down the queue
// (lesson learned from commit 07c39f4).

const { prisma } = require('../lib/bootstrap');
const osm = require('../lib/osm');

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
const RADIUS = (() => {
    const a = args.find((x) => x.startsWith('--radius='));
    return a ? parseInt(a.slice(9), 10) : undefined;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    let where;
    if (IDS) where = { id: { in: IDS } };
    else {
        where = {
            isVisible: true,
            lat: { not: null },
            lng: { not: null },
            OR: [{ phone: null }, { websiteUrl: null }, { openingHours: null }],
        };
    }

    const placesAll = await prisma.place.findMany({
        where,
        select: {
            id: true, name: true, city: true, country: true,
            lat: true, lng: true, addressLine: true,
            phone: true, websiteUrl: true, openingHours: true,
            osmCheckedAt: true,
        },
        orderBy: [
            { osmCheckedAt: { sort: 'asc', nulls: 'first' } },
            { id: 'asc' },
        ],
    });
    const places = LIMIT ? placesAll.slice(0, LIMIT) : placesAll;
    console.log(`[osm] ${places.length} places to look up (apply=${APPLY}${RADIUS ? `, radius=${RADIUS}m` : ''})`);

    const cache = osm.loadCache();
    let resolved = 0, missed = 0, skipped = 0;
    let metaPhone = 0, metaWeb = 0, metaHours = 0, metaAddr = 0;

    for (const p of places) {
        const cacheKey = `${p.name}|${p.city || ''}`;
        let r = cache[cacheKey];
        if (!r) {
            try {
                r = await osm.lookup(p.name, Number(p.lat), Number(p.lng), { radiusM: RADIUS });
                cache[cacheKey] = r || { miss: true, ts: Date.now() };
                osm.saveCache(cache);
                await sleep(1100); // ~1 query/sec — be a good Overpass citizen
            } catch (e) {
                console.log(`[osm] #${p.id} "${p.name}" ERROR: ${e.message}`);
                cache[cacheKey] = { error: e.message, ts: Date.now() };
                continue;
            }
        }

        if (!r || r.miss) {
            missed++;
            console.log(`[osm] #${p.id} "${p.name}" — no OSM match`);
            if (APPLY) await prisma.place.update({ where: { id: p.id }, data: { osmCheckedAt: new Date() } });
            continue;
        }

        const tags = [
            r.phone ? `📞${r.phone}` : '',
            r.websiteUrl ? '🌐' : '',
            r.openingHours ? '🕒' : '',
            r.address ? `📍${r.address}` : '',
            `sim=${r.similarity} dist=${r.distanceM}m`,
        ].filter(Boolean).join(' ');
        console.log(`[osm] #${p.id} "${p.name}" → osm/${r.osmType}/${r.osmId}  ${tags}`);

        if (APPLY) {
            const data = { osmCheckedAt: new Date() };
            if (!p.phone && r.phone) { data.phone = r.phone; metaPhone++; }
            if (!p.websiteUrl && r.websiteUrl) { data.websiteUrl = r.websiteUrl; metaWeb++; }
            if (!p.openingHours && r.openingHours) { data.openingHours = r.openingHours; metaHours++; }
            if ((!p.addressLine || !p.addressLine.trim()) && r.address) { data.addressLine = r.address; metaAddr++; }
            await prisma.place.update({ where: { id: p.id }, data });
            const filled = Object.keys(data).filter((k) => k !== 'osmCheckedAt').length;
            if (filled > 0) resolved++; else skipped++;
        } else {
            // Dry-run: count what we WOULD fill so the summary is meaningful.
            const wouldFill = (
                (!p.phone && r.phone ? 1 : 0) +
                (!p.websiteUrl && r.websiteUrl ? 1 : 0) +
                (!p.openingHours && r.openingHours ? 1 : 0) +
                ((!p.addressLine || !p.addressLine.trim()) && r.address ? 1 : 0)
            );
            if (wouldFill > 0) {
                resolved++;
                if (!p.phone && r.phone) metaPhone++;
                if (!p.websiteUrl && r.websiteUrl) metaWeb++;
                if (!p.openingHours && r.openingHours) metaHours++;
                if ((!p.addressLine || !p.addressLine.trim()) && r.address) metaAddr++;
            } else {
                skipped++;
            }
        }
    }

    console.log(`\n[osm] meta filled — phone=${metaPhone} website=${metaWeb} hours=${metaHours} address=${metaAddr}`);
    console.log(`[osm] ${resolved} resolved, ${missed} missed, ${skipped} skipped (no new fields)`);
    if (!APPLY) console.log('\n(dry-run — pass --apply to write back)');

    osm.saveCache(cache);
    await prisma.$disconnect();
})();
