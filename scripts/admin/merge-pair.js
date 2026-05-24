#!/usr/bin/env node
// Proper merge of one duplicate Place pair. Reads both rows, builds a
// field-by-field "best of both" patch onto the survivor using simple
// per-field rules (longer wins for text, max for counters, prefer
// https/international format, union for stylesJson, etc.), copies
// non-overlapping PlaceSource rows, then hides the drop.
//
// Built because just hiding the drop loses data the survivor lacked
// (drop's longer descriptions, googlePlaceId, ratings, etc.).
//
// Usage:
//   node scripts/admin/merge-pair.js --survivor=180 --drop=1620          # dry run
//   node scripts/admin/merge-pair.js --survivor=180 --drop=1620 --apply  # apply
//
// Does NOT touch: PlaceImage rows (drop's images stay on drop;
// becomes invisible when drop is hidden). Update merge-duplicates.js
// for that — Track 2 schema needs careful handling.

const { prisma } = require('../lib/bootstrap');

function parseArgs(argv) {
    const out = { survivor: null, drop: null, apply: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const eq = (k) => a.startsWith(`--${k}=`) ? a.split('=').slice(1).join('=') : null;
        if (a === '--survivor') out.survivor = parseInt(argv[++i], 10);
        else if (eq('survivor')) out.survivor = parseInt(eq('survivor'), 10);
        else if (a === '--drop') out.drop = parseInt(argv[++i], 10);
        else if (eq('drop')) out.drop = parseInt(eq('drop'), 10);
        else if (a === '--apply') out.apply = true;
    }
    return out;
}

const SELECT = {
    id: true, name: true, addressLine: true, city: true, region: true,
    postalCode: true, country: true, lat: true, lng: true, priceLevel: true,
    stylesJson: true, phone: true, websiteUrl: true, googleMapsUrl: true,
    instagramUrl: true, facebookUrl: true, openingHours: true,
    googlePlaceId: true, googlePlaceUrl: true, googleRating: true,
    googleReviewCount: true, tripadvisorLocationId: true,
    tripadvisorRanking: true, tripadvisorRating: true,
    tripadvisorReviewCount: true, tripadvisorUrl: true,
    yelpRating: true, yelpReviewCount: true, yelpUrl: true,
    descriptionHtml: true, heroImageUrl: true, seoTitle: true,
    seoDescription: true, enrichmentVersion: true, isVisible: true,
};

const isEmpty = (v) => v == null || (typeof v === 'string' && v.trim() === '');
const longer = (a, b) => (b != null && String(b).length > String(a ?? '').length);
const hasIntlPhone = (s) => typeof s === 'string' && /^\+/.test(s.replace(/\s+/g, ''));

// Per-field selection rules. Returns { winner: 'survivor'|'drop'|'merge', value, reason }
// for each field where survivor's current value should be replaced or merged with drop's.
function pickField(field, sv, dv) {
    // Both empty — nothing to do.
    if (isEmpty(sv) && isEmpty(dv)) return null;
    // Survivor empty, drop has value — take drop.
    if (isEmpty(sv) && !isEmpty(dv)) return { value: dv, reason: 'survivor empty' };
    // Drop empty — keep survivor.
    if (isEmpty(dv)) return null;

    // Both have values. Field-specific rules:
    switch (field) {
        case 'name':
        case 'addressLine':
        case 'region':
        case 'openingHours':
        case 'descriptionHtml':
        case 'tripadvisorRanking':
            // Longer text wins (drop's "FI" vs survivor's "Toscana", etc.)
            if (longer(sv, dv)) return { value: dv, reason: `longer (${String(dv).length} > ${String(sv).length})` };
            return null;

        case 'websiteUrl':
            // Prefer https, then longer.
            if (/^http:/.test(sv) && /^https:/.test(dv)) return { value: dv, reason: 'drop uses https' };
            if (/^https:/.test(sv) && /^http:/.test(dv)) return null;
            if (longer(sv, dv)) return { value: dv, reason: `longer (${dv.length} > ${sv.length})` };
            return null;

        case 'phone':
            // Prefer international format.
            if (!hasIntlPhone(sv) && hasIntlPhone(dv)) return { value: dv, reason: 'drop uses international format' };
            return null;

        case 'stylesJson': {
            // Union — parse JSON arrays, merge unique values.
            let svArr, dvArr;
            try { svArr = JSON.parse(sv) || []; } catch { svArr = []; }
            try { dvArr = JSON.parse(dv) || []; } catch { dvArr = []; }
            const merged = Array.from(new Set([...svArr, ...dvArr]));
            if (merged.length > svArr.length) {
                return { value: JSON.stringify(merged), reason: `union (${svArr.length}+${dvArr.length} → ${merged.length})` };
            }
            return null;
        }

        case 'googleReviewCount':
        case 'tripadvisorReviewCount':
        case 'yelpReviewCount': {
            // Prefer higher review count (and apply matching rating below).
            if (Number(dv) > Number(sv)) return { value: dv, reason: `drop has higher count (${dv} > ${sv})` };
            return null;
        }

        case 'googleRating':
        case 'tripadvisorRating':
        case 'yelpRating':
            // Always paired with the count above — applied transactionally below.
            return null;

        case 'enrichmentVersion':
            if (Number(dv) > Number(sv)) return { value: dv, reason: `higher version (${dv} > ${sv})` };
            return null;

        case 'priceLevel':
            // Drop wins only when survivor is default (2) and drop is set differently.
            if (Number(sv) === 2 && Number(dv) !== 2 && dv != null) return { value: dv, reason: 'drop is non-default' };
            return null;

        case 'lat':
        case 'lng':
            // Coord swap only when there's a meaningful difference (>50m roughly = ~0.0005 deg).
            // For safety, skip — patch-place.js handles this manually.
            return null;

        case 'googlePlaceId':
        case 'googlePlaceUrl':
        case 'googleMapsUrl':
        case 'instagramUrl':
        case 'facebookUrl':
        case 'tripadvisorLocationId':
        case 'tripadvisorUrl':
        case 'yelpUrl':
        case 'heroImageUrl':
        case 'seoTitle':
        case 'seoDescription':
        case 'postalCode':
            // Conservative: only fill when survivor is empty (handled at top). Otherwise keep survivor.
            return null;

        default:
            return null;
    }
}

async function main() {
    const { survivor: svId, drop: dvId, apply } = parseArgs(process.argv.slice(2));
    if (!svId || !dvId) {
        console.error('Usage: node merge-pair.js --survivor=N --drop=M [--apply]');
        process.exit(1);
    }
    if (svId === dvId) {
        console.error('survivor and drop must differ');
        process.exit(1);
    }

    const [sv, dv] = await Promise.all([
        prisma.place.findUnique({ where: { id: svId }, select: SELECT }),
        prisma.place.findUnique({ where: { id: dvId }, select: SELECT }),
    ]);
    if (!sv) { console.error(`No survivor row #${svId}`); process.exit(1); }
    if (!dv) { console.error(`No drop row #${dvId}`); process.exit(1); }

    console.log(`SURVIVOR  #${sv.id} "${sv.name}" (${sv.city}) visible=${sv.isVisible}`);
    console.log(`DROP      #${dv.id} "${dv.name}" (${dv.city}) visible=${dv.isVisible}`);
    console.log();

    const patch = {};
    const decisions = [];
    for (const field of Object.keys(SELECT)) {
        if (['id', 'isVisible'].includes(field)) continue;
        const pick = pickField(field, sv[field], dv[field]);
        if (!pick) continue;
        patch[field] = pick.value;
        decisions.push({ field, before: sv[field], after: pick.value, reason: pick.reason });
    }

    // Pair ratings with their counts: only update rating if we're updating its count.
    for (const [r, c] of [['googleRating', 'googleReviewCount'], ['tripadvisorRating', 'tripadvisorReviewCount'], ['yelpRating', 'yelpReviewCount']]) {
        if (patch[c] != null && dv[r] != null && String(sv[r]) !== String(dv[r])) {
            patch[r] = dv[r];
            decisions.push({ field: r, before: sv[r], after: dv[r], reason: `paired with ${c}` });
        }
    }

    if (!decisions.length) {
        console.log('No field-level changes — survivor already has the better data.');
    } else {
        console.log('Patch onto survivor:');
        for (const d of decisions) {
            const beforeStr = d.before == null ? '(null)' : String(d.before).slice(0, 60);
            const afterStr = d.after == null ? '(null)' : String(d.after).slice(0, 60);
            console.log(`  ${d.field.padEnd(22)} ${beforeStr.padEnd(60)} → ${afterStr}  [${d.reason}]`);
        }
    }

    // PlaceSource — copy non-overlapping rows from drop to survivor.
    const dropSources = await prisma.placeSource.findMany({ where: { placeId: dv.id } });
    const svSourceKeys = new Set((await prisma.placeSource.findMany({
        where: { placeId: sv.id }, select: { source: true },
    })).map((r) => r.source));
    const sourcesToCopy = dropSources.filter((s) => !svSourceKeys.has(s.source));
    if (sourcesToCopy.length) {
        console.log();
        console.log(`Sources to copy from drop → survivor:`);
        for (const s of sourcesToCopy) console.log(`  ${s.source}${s.rank != null ? `  (rank=${s.rank})` : ''}`);
    }

    console.log();
    console.log(`After merge: hide drop #${dv.id} (isVisible=false).`);

    if (!apply) {
        console.log('\nDry run. Pass --apply to commit.');
        return;
    }

    // Apply atomically.
    await prisma.$transaction(async (tx) => {
        if (Object.keys(patch).length) {
            // Reset survivor's enrichmentVersion if we changed identity-ish fields.
            const changedIdentity = ['lat', 'lng', 'googlePlaceId', 'addressLine'].some((f) => f in patch);
            const data = { ...patch };
            if (changedIdentity) data.enrichmentVersion = 0;
            await tx.place.update({ where: { id: sv.id }, data });
        }
        for (const s of sourcesToCopy) {
            await tx.placeSource.create({
                data: { placeId: sv.id, source: s.source, rank: s.rank },
            });
        }
        await tx.place.update({ where: { id: dv.id }, data: { isVisible: false } });
    });

    console.log('\nMERGED. Drop hidden.');
}

main()
    .catch((e) => { console.error(e); process.exit(1); })
    .finally(() => prisma.$disconnect());
