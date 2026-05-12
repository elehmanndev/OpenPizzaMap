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
const { haversineM, AGGREGATOR_HOSTS } = require('../lib/utils');

// Targeted-override thresholds. Each gets its own constant so the policy is
// readable in one place — and so future tuning needs no surgery elsewhere.
const COORD_UPGRADE_MIN_DISTANCE_M = 200;   // pin must be >= this far from OSM coords to upgrade
const COORD_UPGRADE_MIN_SIMILARITY = 0.85;  // and OSM name must match this confidently

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
    // Targeted overrides — counted separately from null-fills so the log
    // makes it clear when we're upgrading a row vs. filling a blank.
    let coordUpgrades = 0, webUpgrades = 0;

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

        // Decide every potential write up-front so dry-run and apply share
        // identical logic and the summary numbers match what an --apply run
        // would actually write.
        const patch = {};
        // Fill-only-if-null: phone, hours, address. Discrepancies on these
        // are usually formatting noise (phone) or hard-to-arbitrate
        // crowdsourced data (hours, address), so we never overwrite.
        if (!p.phone && r.phone) patch.phone = r.phone;
        if (!p.openingHours && r.openingHours) patch.openingHours = r.openingHours;
        if ((!p.addressLine || !p.addressLine.trim()) && r.address) patch.addressLine = r.address;

        // Website: fill-if-null OR upgrade-if-current-is-aggregator. The
        // upgrade case swaps a Facebook/Insta/TripAdvisor stub for the
        // venue's real domain — never the reverse.
        let webIsUpgrade = false;
        if (!p.websiteUrl && r.websiteUrl) {
            patch.websiteUrl = r.websiteUrl;
        } else if (p.websiteUrl && r.websiteUrl
            && AGGREGATOR_HOSTS.test(p.websiteUrl)
            && !AGGREGATOR_HOSTS.test(r.websiteUrl)) {
            patch.websiteUrl = r.websiteUrl;
            webIsUpgrade = true;
        }

        // Coords: fill-if-null OR upgrade-if-far-and-confident. The upgrade
        // case fixes centroid-fallback rows where the existing pin is
        // hundreds of metres off the true venue location.
        let coordsAreUpgrade = false;
        if ((p.lat == null || p.lng == null) && r.lat != null && r.lng != null) {
            patch.lat = r.lat;
            patch.lng = r.lng;
        } else if (p.lat != null && p.lng != null && r.lat != null && r.lng != null
            && r.similarity >= COORD_UPGRADE_MIN_SIMILARITY) {
            const dist = haversineM(Number(p.lat), Number(p.lng), r.lat, r.lng);
            if (dist >= COORD_UPGRADE_MIN_DISTANCE_M) {
                patch.lat = r.lat;
                patch.lng = r.lng;
                coordsAreUpgrade = true;
            }
        }

        // Tally what changed for the summary.
        if (patch.phone) metaPhone++;
        if (patch.openingHours) metaHours++;
        if (patch.addressLine) metaAddr++;
        if (patch.websiteUrl) { metaWeb++; if (webIsUpgrade) webUpgrades++; }
        if (patch.lat != null && coordsAreUpgrade) coordUpgrades++;

        const changeCount = Object.keys(patch).length;
        if (changeCount > 0) resolved++; else skipped++;

        if (APPLY) {
            await prisma.place.update({
                where: { id: p.id },
                data: { ...patch, osmCheckedAt: new Date() },
            });
        }
    }

    console.log(`\n[osm] meta filled — phone=${metaPhone} website=${metaWeb} hours=${metaHours} address=${metaAddr}`);
    console.log(`[osm] upgrades — coords=${coordUpgrades} (>=${COORD_UPGRADE_MIN_DISTANCE_M}m, sim>=${COORD_UPGRADE_MIN_SIMILARITY})  website-from-aggregator=${webUpgrades}`);
    console.log(`[osm] ${resolved} resolved, ${missed} missed, ${skipped} skipped (no new fields)`);
    if (!APPLY) console.log('\n(dry-run — pass --apply to write back)');

    osm.saveCache(cache);
    await prisma.$disconnect();
})();
