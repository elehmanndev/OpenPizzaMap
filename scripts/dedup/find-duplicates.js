#!/usr/bin/env node
// Scan the Place table for likely-duplicate pairs and emit a per-pair audit
// report showing EXACTLY what would happen if we merged each pair.
//
// Survivor = oldest row (lowest id). URL stable. Per-field "best wins"
// heuristics decide what survivor would inherit from drop. The report
// groups pairs into three buckets so a human can approve in batches:
//
//   1. Clean delete   — drop has nothing the survivor doesn't already have.
//                       Safe to delete drop with no patch.
//   2. Valuable merge — drop has fields/photos/descriptions/etc the survivor
//                       lacks. Patch survivor with those, then delete drop.
//   3. Flagged        — suspicious signals (different gpid, different phones,
//                       chain candidates). Manual review required.
//
// Output: notes/sessions/YYYY-MM-DD-duplicate-audit.md
//         (Also gitignored — Obsidian-mirrored separately per session policy.)
//
// Usage:
//   node scripts/dedup/find-duplicates.js [--include-hidden]
//
// --include-hidden: include isVisible=false rows. Default is visible-only
//   (matches what would actually appear on the public map).

const fs = require('fs');
const path = require('path');
const { prisma, ROOT } = require('../lib/bootstrap');
const { normalizePlaceName } = require(path.join(ROOT, 'src/services/normalize-place-name'));
const { buildPlan, haversineM } = require('./_logic');

const INCLUDE_HIDDEN = process.argv.includes('--include-hidden');

// Distance threshold for "same location" — duplicates whose coords differ
// by more than this are flagged as suspect (might be chain locations).
const COORD_MATCH_M = 100;

// Aggressive token-overlap pass: within this radius AND with at least one
// meaningful token in common, two rows are candidate dups even if the
// normalized names don't match exactly. Catches "Errico" vs "Errico Porzio
// Lungomare Napoli" at the same coords — they share token "errico" but
// the exact-normalized-name bucket wouldn't pair them.
const TOKEN_OVERLAP_RADIUS_M = 50;
const MIN_TOKEN_LEN = 4;

// Address-equality pass: rows with the same FULLY-normalized addressLine
// are candidate dups (after stripping case, punctuation, and country names).
// Prefix matching turned out to false-positive heavily on famous streets
// like "Via Partenope" — every venue on that strip matched every other.
const ADDRESS_MIN_LEN = 12; // Below this, address is too sparse to trust.

// Generic venue/cuisine words that pair too many unrelated places when used
// as the only shared "meaningful" token. "Maurizio's Pizzeria" + "Užupio
// Pizzeria" should NOT pair just because both contain "pizzeria".
const NAME_STOPWORDS = new Set([
    'pizza', 'pizzeria', 'pizzaria', 'pizze', 'pizzette',
    'restaurant', 'ristorante', 'trattoria', 'osteria',
    'antica', 'gourmet', 'bistrot', 'bistro', 'cucina',
    'forno', 'food', 'kitchen', 'house', 'place',
    'napoli', 'naples', 'roma', 'rome', 'milano', 'milan',
    'verona', 'firenze', 'florence', 'torino', 'turin',
    'napoletana', 'napoletano',
]);
function meaningfulTokens(normalizedName) {
    return String(normalizedName || '').split(/\s+/)
        .filter((t) => t.length >= MIN_TOKEN_LEN && !NAME_STOPWORDS.has(t));
}

function normalizeAddress(addr) {
    if (!addr) return null;
    let s = String(addr).toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // Drop trailing country/region words that don't disambiguate.
    s = s.replace(/\b(italy|italia|usa|united states|spain|espana|france|francia|uk|united kingdom)\b/g, '').trim();
    s = s.replace(/\s+/g, ' ');
    return s || null;
}

function fmtVal(v, max = 70) {
    if (v == null) return '(null)';
    if (typeof v === 'object') v = String(v);
    let s = String(v).replace(/\s+/g, ' ');
    if (s.length > max) s = s.slice(0, max - 1) + '…';
    return s;
}

async function main() {
    const where = INCLUDE_HIDDEN ? { status: 'active' } : { status: 'active', isVisible: true };
    const places = await prisma.place.findMany({
        where,
        include: {
            sources: { select: { id: true, source: true, rank: true } },
            visits: { select: { id: true, userId: true } },
            favorites: { select: { id: true, userId: true } },
            reviews: { select: { id: true } },
            styles: { select: { styleId: true } },
            faqs: { select: { id: true } },
        },
    });
    console.error(`[scan] ${places.length} candidate rows (visible-only=${!INCLUDE_HIDDEN})`);

    // Four candidate-finding passes. A row pair becomes a candidate if ANY
    // of these signals fire — duplicate-key dedup ensures we don't process
    // the same pair twice across passes.
    //
    //   1. Same googlePlaceId (canonical identity match — strongest signal)
    //   2. Exact normalized name + same country + within 100m
    //      (the original pass — catches identical re-imports)
    //   3. Same city + within 50m + meaningful-token overlap on names
    //      (NEW — catches "Errico" vs "Errico Porzio Lungomare" at same coords)
    //   4. Same city + same address-line prefix (15+ chars normalized)
    //      (NEW — catches re-imports where one row has a longer address tail)

    const byNameCountry = new Map();
    const byGpid = new Map();
    const byCity = new Map();
    const byAddrPrefix = new Map();

    for (const p of places) {
        if (!p.lat || !p.lng) continue;
        const normName = normalizePlaceName(p.name);
        // Pass 2 bucket
        const k2 = (p.country || '') + '|' + normName;
        if (!byNameCountry.has(k2)) byNameCountry.set(k2, []);
        byNameCountry.get(k2).push(p);
        // Pass 1 bucket
        if (p.googlePlaceId) {
            if (!byGpid.has(p.googlePlaceId)) byGpid.set(p.googlePlaceId, []);
            byGpid.get(p.googlePlaceId).push(p);
        }
        // Pass 3 bucket (per-city — we'll do O(n²) WITHIN each city, which
        // stays cheap because no city has >300 rows)
        const cityKey = (p.country || '') + '|' + (p.city || '');
        if (!byCity.has(cityKey)) byCity.set(cityKey, []);
        byCity.get(cityKey).push({ p, tokens: new Set(meaningfulTokens(normName)) });
        // Pass 4 bucket — full normalized address equality (within same city).
        const addr = normalizeAddress(p.addressLine);
        if (addr && addr.length >= ADDRESS_MIN_LEN) {
            const k4 = (p.city || '') + '|' + addr;
            if (!byAddrPrefix.has(k4)) byAddrPrefix.set(k4, []);
            byAddrPrefix.get(k4).push(p);
        }
    }

    const seen = new Set();
    const pairs = [];
    const addPair = (a, b, dist, why) => {
        const lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
        const k = lo + ':' + hi;
        if (seen.has(k)) return;
        seen.add(k);
        const survivor = a.id < b.id ? a : b;
        const drop = a.id < b.id ? b : a;
        pairs.push({ survivor, drop, distM: dist, why });
    };

    // Pass 1: same gpid
    for (const arr of byGpid.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            addPair(a, b, Math.round(d), 'same-gpid');
        }
    }
    // Pass 2: exact normalized name + country + ≤100m
    for (const arr of byNameCountry.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            if (d <= COORD_MATCH_M) addPair(a, b, Math.round(d), 'exact-name');
        }
    }
    // Pass 3: same city + ≤50m + token overlap
    for (const arr of byCity.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.p.lat), Number(a.p.lng), Number(b.p.lat), Number(b.p.lng));
            if (d > TOKEN_OVERLAP_RADIUS_M) continue;
            // Token overlap
            let overlap = 0;
            for (const t of a.tokens) if (b.tokens.has(t)) overlap++;
            if (overlap === 0) continue;
            addPair(a.p, b.p, Math.round(d), `token-overlap(${overlap})`);
        }
    }
    // Pass 4: same fully-normalized address in same city — but ONLY when
    // coords also agree (≤200m). Without the coord gate, landmark-style
    // addresses ("Ferrari World Abu Dhabi", "Praça do Comércio") pair every
    // venue inside the same complex even though they're kilometers apart.
    const ADDRESS_PASS_MAX_M = 200;
    for (const arr of byAddrPrefix.values()) {
        if (arr.length < 2) continue;
        for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
            const a = arr[i], b = arr[j];
            const d = haversineM(Number(a.lat), Number(a.lng), Number(b.lat), Number(b.lng));
            if (d <= ADDRESS_PASS_MAX_M) addPair(a, b, Math.round(d), 'address-match');
        }
    }

    // Per-pair plan + relation transfer counts
    const plans = pairs.map(({ survivor, drop, distM, why }) => {
        const { wins, flags } = buildPlan(survivor, drop);
        const svSources = new Set(survivor.sources.map((s) => s.source));
        const svVisitUsers = new Set(survivor.visits.map((v) => v.userId));
        const svFavUsers = new Set(survivor.favorites.map((v) => v.userId));
        const svStyleIds = new Set(survivor.styles.map((s) => s.styleId));
        const transferred = {
            sources: drop.sources.filter((s) => !svSources.has(s.source)).length,
            visits: drop.visits.filter((v) => !svVisitUsers.has(v.userId)).length,
            favorites: drop.favorites.filter((v) => !svFavUsers.has(v.userId)).length,
            reviews: drop.reviews.length,
            styles: drop.styles.filter((s) => !svStyleIds.has(s.styleId)).length,
            faqs: drop.faqs.length,
        };
        return { survivor, drop, distM, why, wins, flags, transferred };
    });

    const clean = plans.filter((p) => p.flags.length === 0 && p.wins.length === 0 && Object.values(p.transferred).every((n) => n === 0));
    const cleanWithRelations = plans.filter((p) => p.flags.length === 0 && p.wins.length === 0 && Object.values(p.transferred).some((n) => n > 0));
    const valuable = plans.filter((p) => p.flags.length === 0 && p.wins.length > 0);
    const flagged = plans.filter((p) => p.flags.length > 0);

    // Render markdown
    const today = new Date().toISOString().slice(0, 10);
    const outDir = path.join(ROOT, 'notes', 'sessions');
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${today}-duplicate-audit.md`);

    const lines = [];
    lines.push(`# Duplicate audit — ${today}`);
    lines.push('');
    lines.push(`Scanned ${places.length} active rows (visible-only=${!INCLUDE_HIDDEN}).`);
    lines.push(`Found **${pairs.length} candidate duplicate pairs**.`);
    lines.push('');
    lines.push(`- **${clean.length} clean deletes** — drop has nothing the survivor lacks. Safe to delete drop with no patch.`);
    lines.push(`- **${cleanWithRelations.length} delete + relation transfer** — drop has no new fields but does have sources/visits/etc. that should move to survivor first.`);
    lines.push(`- **${valuable.length} valuable merges** — drop has fields that improve the survivor. Patch + delete.`);
    lines.push(`- **${flagged.length} flagged for manual review** — suspicious mismatch (different gpids, different phones, etc.).`);
    lines.push('');
    lines.push(`Survivor selection rule: oldest row (lowest id) — preserves URL stability.`);
    lines.push('');

    function renderPair(p, showWins) {
        const { survivor: s, drop: d, distM, wins, flags, transferred, why } = p;
        lines.push(`### survivor=[${s.id}] "${s.name}" + drop=[${d.id}] "${d.name}"`);
        lines.push(`*${s.city}, ${s.country} — ${distM}m apart — caught by: ${why || '?'}*`);
        lines.push('');
        if (showWins && wins.length) {
            lines.push('Survivor gains:');
            lines.push('');
            lines.push('| field | survivor (before) | → drop (new) | reason |');
            lines.push('|---|---|---|---|');
            for (const w of wins) {
                lines.push(`| \`${w.field}\` | ${fmtVal(w.oldValue)} | ${fmtVal(w.newValue)} | ${w.reason} |`);
            }
            lines.push('');
        }
        if (flags.length) {
            lines.push('**Flags:**');
            lines.push('');
            for (const f of flags) {
                lines.push(`- \`${f.field}\`: survivor=\`${fmtVal(f.sv)}\` | drop=\`${fmtVal(f.dv)}\` — ${f.reason}`);
            }
            lines.push('');
        }
        const t = transferred;
        if (t.sources || t.visits || t.favorites || t.reviews || t.styles || t.faqs) {
            const parts = [];
            if (t.sources) parts.push(`${t.sources} sources`);
            if (t.visits) parts.push(`${t.visits} visits`);
            if (t.favorites) parts.push(`${t.favorites} favorites`);
            if (t.reviews) parts.push(`${t.reviews} reviews`);
            if (t.styles) parts.push(`${t.styles} styles`);
            if (t.faqs) parts.push(`${t.faqs} faqs`);
            lines.push(`Will transfer: ${parts.join(', ')}.`);
            lines.push('');
        }
        lines.push(`Sources — survivor: \`${s.sources.map((x) => x.source).join(',') || '(none)'}\` | drop: \`${d.sources.map((x) => x.source).join(',') || '(none)'}\``);
        lines.push('');
    }

    if (flagged.length) {
        lines.push('## 🚩 Flagged for manual review');
        lines.push('');
        for (const p of flagged) renderPair(p, true);
    }
    if (valuable.length) {
        lines.push('## ✨ Valuable merges (drop adds info)');
        lines.push('');
        for (const p of valuable) renderPair(p, true);
    }
    if (cleanWithRelations.length) {
        lines.push('## 🔁 Delete + relation transfer (drop has sources/visits to keep)');
        lines.push('');
        for (const p of cleanWithRelations) renderPair(p, false);
    }
    if (clean.length) {
        lines.push('## 🗑 Clean deletes (drop has nothing of value)');
        lines.push('');
        lines.push(`Quick batch — drop has no new fields, no sources to transfer, no users involved.`);
        lines.push('');
        lines.push('| survivor | drop | city | dist |');
        lines.push('|---|---|---|---|');
        for (const p of clean) {
            lines.push(`| [${p.survivor.id}] ${fmtVal(p.survivor.name, 40)} | [${p.drop.id}] ${fmtVal(p.drop.name, 40)} | ${p.survivor.city} | ${p.distM}m |`);
        }
        lines.push('');
    }

    fs.writeFileSync(outPath, lines.join('\n'));
    console.error(`[done] report → ${path.relative(ROOT, outPath)}`);
    console.error(`        pairs: ${pairs.length} | clean=${clean.length}  +relations=${cleanWithRelations.length}  valuable=${valuable.length}  flagged=${flagged.length}`);

    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
