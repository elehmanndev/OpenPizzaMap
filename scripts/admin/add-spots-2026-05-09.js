#!/usr/bin/env node
// One-off: add 5 hand-picked Catalonia pizzerias from share.google links.
// Each is run through the enrichment pipeline so it picks up canonical
// coords/address via the Playwright Google Maps resolver, then inserted
// (or merged-into-existing if dedup hits).
//
// Usage:
//   node scripts/admin/add-spots-2026-05-09.js [--dry-run] [--hidden]

const path = require('path');
const { prisma, ROOT } = require('../lib/bootstrap');
const { enrichAndValidate } = require(path.join(ROOT, 'src', 'services', 'enrichment'));
const { getProvider, PIPELINE_VERSION } = require(path.join(ROOT, 'src', 'services', 'enrichment', 'providers'));
const { slugify } = require(path.join(ROOT, 'src', 'services', 'slugify'));

const DRY_RUN = process.argv.includes('--dry-run');
const HIDDEN  = process.argv.includes('--hidden');   // default: visible

const SPOTS = [
  {
    name: 'Pizzeria Tarricone',
    city: 'Tarragona',
    country: 'Spain', countryCode: 'ES', region: 'Catalonia',
    addressLine: 'Plaça de Santiago Rusiñol',
    phone: '+34 623 553 392',
    instagramUrl: 'https://www.instagram.com/pizzeriatarricone/',
    styles: ['neapolitan'],
  },
  {
    name: 'Oplontina PizzaBar',
    city: 'Reus',
    country: 'Spain', countryCode: 'ES', region: 'Catalonia',
    addressLine: 'Carrer de la Puríssima Concepció, 19',
    postalCode: '43201',
    phone: '+34 977 53 22 56',
    websiteUrl: 'https://oplontinapizzabar.es',
    instagramUrl: 'https://www.instagram.com/oplontina_pizza_bar/',
    styles: ['neapolitan'],
  },
  {
    name: 'Pizzeria La Dolce Vita',
    city: 'Salou',
    country: 'Spain', countryCode: 'ES', region: 'Catalonia',
    addressLine: 'Carrer de Lleida',
    postalCode: '43840',
    instagramUrl: 'https://www.instagram.com/ladolcevitasalou/',
    styles: ['italian'],
  },
  {
    name: 'Pizzeria Da Gennaro',
    city: 'Cambrils',
    country: 'Spain', countryCode: 'ES', region: 'Catalonia',
    addressLine: 'Carrer de Pau Casals, 35',
    postalCode: '43850',
    phone: '+34 674 79 04 28',
    instagramUrl: 'https://www.instagram.com/dagennaropizzeria/',
    styles: ['neapolitan'],
  },
  {
    name: 'Pizzeria Sardenya',
    city: 'Altafulla',
    country: 'Spain', countryCode: 'ES', region: 'Catalonia',
    addressLine: "Ronda d'Altafulla, 107",
    phone: '+34 977 42 48 68',
    instagramUrl: 'https://www.instagram.com/la_sardenya/',
    styles: ['italian'],
  },
];

async function nominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'OpenPizzaMap-add-spots/0.1 (eric@openpizzamap.com)' },
  });
  if (!res.ok) return null;
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) return null;
  return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
}

async function fallbackCoords(spot, resolved) {
  const tries = [];
  if (resolved?.formattedAddress) tries.push(resolved.formattedAddress);
  if (spot.addressLine) tries.push([spot.addressLine, spot.city, spot.country].filter(Boolean).join(', '));
  if (spot.postalCode) tries.push([spot.addressLine, spot.postalCode, spot.city, spot.country].filter(Boolean).join(', '));
  // Drop the "Carrer de"/"Calle"/"Plaça" prefix to give Nominatim a name-only match.
  if (spot.addressLine) {
    const stripped = spot.addressLine.replace(/^(Carrer de la |Carrer de |Carrer del |Carrer |Calle |Plaça de |Plaça |Ronda d'|Ronda de |Avinguda |Avenida )/i, '');
    if (stripped !== spot.addressLine) {
      tries.push([stripped, spot.city, spot.country].filter(Boolean).join(', '));
    }
  }
  tries.push([spot.city, spot.country].filter(Boolean).join(', '));
  for (const q of [...new Set(tries)]) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const hit = await nominatim(q);
      if (hit) {
        console.log(`   nominatim fallback hit: ${q} → ${hit.lat}, ${hit.lng}`);
        return hit;
      } else {
        console.log(`   nominatim miss: ${q}`);
      }
    } catch (e) {
      console.log(`   nominatim error: ${e.message}`);
    }
  }
  return null;
}

async function ensureCity(p) {
  const slug = slugify(p.city);
  let row = await prisma.city.findUnique({
    where: { countryCode_slug: { countryCode: p.countryCode, slug } },
  });
  if (!row) {
    row = await prisma.city.create({
      data: { name: p.city, slug, countryCode: p.countryCode, isVisible: false },
    });
    console.log(`  + city created: ${p.city} (${p.countryCode})`);
  }
  return row;
}

async function main() {
  console.log(`[mode] dry-run=${DRY_RUN} visibility=${HIDDEN ? 'hidden' : 'visible'}`);
  const provider = getProvider({ prisma });
  const results = [];

  for (const spot of SPOTS) {
    console.log(`\n→ ${spot.name} (${spot.city})`);
    const verdict = await enrichAndValidate({
      name: spot.name,
      city: spot.city,
      country: spot.country,
      lat: null,
      lng: null,
    }, { prisma, provider });

    console.log(`   action=${verdict.action} provider=${verdict.providerUsed} reasons=${verdict.reasons.join(' | ') || '-'}`);
    if (verdict.coords?.chosenLat != null) {
      console.log(`   coords: ${verdict.coords.chosenLat}, ${verdict.coords.chosenLng} (${verdict.coords.source})`);
    }
    if (verdict.resolved?.formattedAddress) {
      console.log(`   resolved address: ${verdict.resolved.formattedAddress}`);
    }

    if (verdict.action === 'manual_review') {
      results.push({ spot, verdict, status: 'skipped: manual_review' });
      continue;
    }

    let lat = verdict.coords.chosenLat;
    let lng = verdict.coords.chosenLng;
    if (lat == null || lng == null) {
      const fb = await fallbackCoords(spot, verdict.resolved);
      if (fb) { lat = fb.lat; lng = fb.lng; }
    }
    if (lat == null || lng == null) {
      console.log(`   ! no coords after fallback — skipping`);
      results.push({ spot, verdict, status: 'skipped: no coords' });
      continue;
    }

    if (DRY_RUN) {
      console.log(`   would insert with coords ${lat}, ${lng}`);
      results.push({ spot, verdict, status: 'dry-run' });
      continue;
    }

    const city = await ensureCity(spot);
    const resolved = verdict.resolved || {};

    if (verdict.action === 'merge_into') {
      const existing = verdict.existing;
      console.log(`   merge into existing place id=${existing.id} (${existing.name})`);
      // Fill-only patch — same policy as the bulk importer.
      const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');
      const patch = {};
      const cand = {
        addressLine:  spot.addressLine || resolved.formattedAddress || null,
        region:       spot.region || null,
        postalCode:   spot.postalCode || null,
        phone:        spot.phone || resolved.phone || null,
        websiteUrl:   spot.websiteUrl || resolved.websiteUrl || null,
        instagramUrl: spot.instagramUrl || null,
      };
      for (const [f, v] of Object.entries(cand)) {
        if (isEmpty(existing[f]) && !isEmpty(v)) patch[f] = v;
      }
      // Style union
      let prev = [];
      try { prev = JSON.parse(existing.stylesJson || '[]') || []; } catch {}
      const merged = [...new Set([...prev, ...(spot.styles || [])])];
      if (merged.length !== prev.length) patch.stylesJson = JSON.stringify(merged);

      if (Object.keys(patch).length) {
        await prisma.place.update({ where: { id: existing.id }, data: patch });
        console.log(`   patched fields: ${Object.keys(patch).join(', ')}`);
      } else {
        console.log(`   nothing to patch`);
      }
      await prisma.placeSource.upsert({
        where: { placeId_source: { placeId: existing.id, source: 'user' } },
        update: {},
        create: { placeId: existing.id, source: 'user' },
      });
      results.push({ spot, verdict, status: 'merged', placeId: existing.id });
      continue;
    }

    // insert path
    const baseSlug = slugify(`${spot.name}-${spot.city}`);
    let placeSlug = baseSlug;
    for (let n = 2; n <= 50; n++) {
      const clash = await prisma.place.findUnique({ where: { slug: placeSlug }, select: { id: true } });
      if (!clash) break;
      placeSlug = `${baseSlug}-${n}`;
    }
    const place = await prisma.place.create({
      data: {
        name: spot.name,
        addressLine: spot.addressLine || resolved.formattedAddress || '',
        city: spot.city,
        region: spot.region || null,
        postalCode: spot.postalCode || null,
        country: spot.country,
        lat, lng,
        priceLevel: 2,
        stylesJson: JSON.stringify(spot.styles || []),
        phone: spot.phone || resolved.phone || null,
        websiteUrl: spot.websiteUrl || resolved.websiteUrl || null,
        instagramUrl: spot.instagramUrl || null,
        slug: placeSlug,
        cityId: city.id,
        status: 'active',
        isVisible: !HIDDEN,
        googlePlaceId: resolved.googlePlaceId || null,
        googlePlaceUrl: resolved.googleMapsUrl || null,
        enrichmentVersion: PIPELINE_VERSION,
        enrichedAt: resolved.formattedAddress ? new Date() : null,
      },
    });
    await prisma.placeSource.create({
      data: { placeId: place.id, source: 'user' },
    });
    console.log(`   + inserted id=${place.id} slug=${placeSlug} visible=${!HIDDEN}`);
    results.push({ spot, verdict, status: 'inserted', placeId: place.id });
  }

  await provider.close().catch(() => {});

  console.log('\n=== summary ===');
  for (const r of results) {
    console.log(`${r.status.padEnd(20)} ${r.spot.name} (${r.spot.city})${r.placeId ? ` → id=${r.placeId}` : ''}`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
