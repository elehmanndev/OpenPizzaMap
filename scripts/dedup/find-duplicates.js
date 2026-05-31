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
const { prisma, ROOT, PATHS } = require('../lib/bootstrap');
const { buildPlan } = require('./_logic');
// The 4-pass candidate finder now lives in a shared module so this CLI and the
// /admin/merge queue run identical passes. See src/services/dedupCandidates.js.
const { findCandidatePairs } = require(path.join(ROOT, 'src/services/dedupCandidates'));

const INCLUDE_HIDDEN = process.argv.includes('--include-hidden');

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

    // Candidate pairs from the shared 4-pass finder (gpid / exact-name /
    // token-overlap / address-match). See src/services/dedupCandidates.js.
    const pairs = findCandidatePairs(places);

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

    // Batch-approve file for the flagged pairs. Each pair's `S:D` line is
    // commented out by default — uncomment the ones that are real dupes, then
    // feed the file to merge-duplicates.js --from-file. Turns "type ids one at
    // a time" into "skim and uncomment". Always (re)written so a run with zero
    // flags leaves an empty-but-explanatory file rather than a stale one.
    const flagPath = path.join(PATHS.reports, 'flagged-pairs.txt');
    const fl = [];
    fl.push(`# Flagged duplicate pairs — ${today}`);
    fl.push('#');
    fl.push('# These pairs disagree on a field that should match for one venue');
    fl.push('# (different phone, or two same-format Google place ids), so they');
    fl.push('# might be two REAL places. Review each below.');
    fl.push('#');
    fl.push('# To MERGE a pair: delete the leading "# " from its "S:D" line');
    fl.push('# (keep survivor:drop order — survivor is the lower id). Then run:');
    fl.push('#   node scripts/dedup/merge-duplicates.js --from-file data/reports/flagged-pairs.txt');
    fl.push('#');
    fl.push('# Lines starting with "#" are ignored. Pairs left commented stay unmerged.');
    fl.push('');
    if (!flagged.length) {
        fl.push('# (no flagged pairs in the latest scan)');
    }
    for (const p of flagged) {
        const { survivor: s, drop: d, distM, flags } = p;
        fl.push(`# survivor=[${s.id}] "${fmtVal(s.name, 50)}"  drop=[${d.id}] "${fmtVal(d.name, 50)}"  (${s.city}, ${s.country}, ${distM}m)`);
        for (const f of flags) {
            fl.push(`#   ${f.field}: ${fmtVal(f.sv)} ≠ ${fmtVal(f.dv)} — ${f.reason}`);
        }
        fl.push(`# ${s.id}:${d.id}`);
        fl.push('');
    }
    fs.writeFileSync(flagPath, fl.join('\n'));
    console.error(`        flagged batch file → ${path.relative(ROOT, flagPath)} (uncomment pairs to approve)`);

    await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
