#!/usr/bin/env node
// Null out IG/FB URLs where the handle is a known false-positive (template
// defaults, platform corporate accounts, language codes, generic words).
// No browser, no verification — pure SQL pattern match. Handles in the
// blocklist are never legitimate venue profiles, so we don't need to
// re-verify before nulling.
//
// This is "Phase 2a" from the 2026-05-24 session plan — a tactical pass
// that clears the most obvious junk while we wait for IG rate-limits to
// cool down before running the full verifier-based cleanup.
//
// Usage:
//   node scripts/admin/null-blocklisted-socials.js           # dry-run (default)
//   node scripts/admin/null-blocklisted-socials.js --apply   # write nulls
//
// Safe to re-run — the OR clause in subsequent socials backfills will
// re-attempt these rows, but the multi-source verifier already excludes
// these handles via FB_PATH_BLOCKLIST + IG_PATH_BLOCKLIST so they won't
// be re-written (once Phase 3 promotes the expanded blocklist into the
// main script — until then there's still a small window for re-writes).

const { prisma } = require('../lib/bootstrap');

// Same expanded list used in cleanup-weak-socials.js Concept 1 step. Keep
// in sync if either changes.
const BLOCKLIST = new Set([
    'meta', 'squarespace', 'wix', 'shopify', 'instagram', 'facebook', 'fb',
    'share', 'sharer', 'login', 'help', 'about', 'developer', 'developers',
    'en', 'fr', 'it', 'es', 'de', 'pt', 'nl', 'ru', 'ja', 'zh',
    'pizza', 'cafe', 'restaurant', 'food', 'eats', 'home',
]);

function extractHandle(url) {
    if (!url) return null;
    try {
        const u = new URL(url);
        const seg = u.pathname.split('/').filter(Boolean);
        return seg[0]?.toLowerCase() || null;
    } catch { return null; }
}

async function run({ apply = false } = {}) {
    const rows = await prisma.place.findMany({
        where: {
            isVisible: true,
            OR: [{ instagramUrl: { not: null } }, { facebookUrl: { not: null } }],
        },
        select: { id: true, name: true, instagramUrl: true, facebookUrl: true },
        orderBy: { id: 'asc' },
    });

    const toNullIg = [];
    const toNullFb = [];
    for (const r of rows) {
        if (r.instagramUrl) {
            const h = extractHandle(r.instagramUrl);
            if (h && BLOCKLIST.has(h)) toNullIg.push({ id: r.id, name: r.name, url: r.instagramUrl, handle: h });
        }
        if (r.facebookUrl) {
            const h = extractHandle(r.facebookUrl);
            if (h && BLOCKLIST.has(h)) toNullFb.push({ id: r.id, name: r.name, url: r.facebookUrl, handle: h });
        }
    }

    console.log(`[null-blocklist] scanned ${rows.length} visible rows with at least one social`);
    console.log(`[null-blocklist] ${toNullIg.length} IG + ${toNullFb.length} FB matches in blocklist`);
    if (!toNullIg.length && !toNullFb.length) {
        console.log(`[null-blocklist] nothing to do.`);
        return { ok: true, igNulled: 0, fbNulled: 0 };
    }

    if (toNullIg.length) {
        console.log('');
        console.log(`Instagram nulls:`);
        for (const r of toNullIg) console.log(`  #${r.id.toString().padStart(5)} [${r.handle}] ${r.name} — ${r.url}`);
    }
    if (toNullFb.length) {
        console.log('');
        console.log(`Facebook nulls:`);
        for (const r of toNullFb) console.log(`  #${r.id.toString().padStart(5)} [${r.handle}] ${r.name} — ${r.url}`);
    }

    if (apply) {
        for (const r of toNullIg) await prisma.place.update({ where: { id: r.id }, data: { instagramUrl: null } }).catch(e => console.warn(`  IG #${r.id} update failed: ${e.message}`));
        for (const r of toNullFb) await prisma.place.update({ where: { id: r.id }, data: { facebookUrl: null } }).catch(e => console.warn(`  FB #${r.id} update failed: ${e.message}`));
        console.log('');
        console.log(`[null-blocklist] APPLIED — instagramUrl=${toNullIg.length} facebookUrl=${toNullFb.length}`);
    } else {
        console.log('');
        console.log(`[null-blocklist] DRY RUN — re-run with --apply to write`);
    }
    return { ok: true, igNulled: toNullIg.length, fbNulled: toNullFb.length };
}

module.exports = { run };

if (require.main === module) {
    const apply = process.argv.includes('--apply');
    run({ apply })
        .then(() => prisma.$disconnect())
        .catch(e => { console.error(e); process.exit(1); });
}
