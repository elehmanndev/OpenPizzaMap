#!/usr/bin/env node
// Probe Overpass to diagnose an OSM miss. Runs three widening queries:
//   1. cuisine=pizza in 200m (our default — same as the matcher's query)
//   2. cuisine=pizza in 1000m (did the matcher just miss by distance?)
//   3. ANY restaurant/fast_food in 200m (is it tagged but not as pizza?)
// Usage: node scripts/audits/probe-osm.js <lat> <lng> [name]
require('../lib/bootstrap');
const { overpassQuery } = require('../lib/osm');
const { jaroWinkler, normalizeName } = require('../lib/utils');

(async () => {
    const [lat, lng, ...rest] = process.argv.slice(2);
    const name = rest.join(' ');
    if (!lat || !lng) { console.error('usage: probe-osm.js <lat> <lng> [name]'); process.exit(1); }

    async function run(label, ql) {
        console.log(`\n=== ${label} ===`);
        const r = await overpassQuery(ql);
        const els = (r && r.elements) || [];
        console.log(`${els.length} elements`);
        for (const el of els) {
            const t = el.tags || {};
            const n = t.name || t['name:en'] || t['name:it'] || '(no name)';
            const cuisine = t.cuisine || '-';
            const amenity = t.amenity || '-';
            const sim = name ? jaroWinkler(normalizeName(name), normalizeName(n)).toFixed(2) : '';
            console.log(`  ${el.type}/${el.id} "${n}" amenity=${amenity} cuisine=${cuisine}${sim ? ` sim=${sim}` : ''}`);
        }
    }

    await run('cuisine=pizza in 200m (matcher default)', `[out:json][timeout:25];
(
  nwr["amenity"="restaurant"]["cuisine"~"pizza",i](around:200,${lat},${lng});
  nwr["amenity"="fast_food"]["cuisine"~"pizza",i](around:200,${lat},${lng});
);
out center tags 30;`);

    await run('cuisine=pizza in 1000m', `[out:json][timeout:25];
(
  nwr["amenity"="restaurant"]["cuisine"~"pizza",i](around:1000,${lat},${lng});
  nwr["amenity"="fast_food"]["cuisine"~"pizza",i](around:1000,${lat},${lng});
);
out center tags 30;`);

    await run('ANY restaurant/fast_food in 200m (untagged-cuisine check)', `[out:json][timeout:25];
(
  nwr["amenity"="restaurant"](around:200,${lat},${lng});
  nwr["amenity"="fast_food"](around:200,${lat},${lng});
);
out center tags 30;`);
})();
