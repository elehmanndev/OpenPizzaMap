#!/usr/bin/env node
// Playwright-based place resolver — opm-runner replacement for the
// paid Google Places searchText API.
//
// Picks rows where googlePlaceId IS NULL and tries to find one via
// the public Maps search. Stamps enrichedAt regardless of outcome so
// the queue rotates; bumps enrichmentVersion only on a confirmed match.
//
// Throttle: 3s between places (Maps is more sensitive than other paths).

const { prisma } = require("../lib/bootstrap");
const { createGmapsPage, findPlaceByName } = require("../lib/gmaps");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickQueue(limit) {
    return prisma.place.findMany({
        where: {
            googlePlaceId: null,
            enrichmentVersion: 0,
        },
        orderBy: [
            { isVisible: "asc" },                     // hidden submissions first
            { enrichedAt: { sort: "asc", nulls: "first" } },
            { id: "asc" },
        ],
        select: {
            id: true, name: true, city: true, country: true,
            lat: true, lng: true,
        },
        take: limit,
    });
}

async function run({ limit = 5, disconnect = true } = {}) {
    const queue = await pickQueue(limit);
    if (!queue.length) {
        console.log("[resolve] queue empty");
        if (disconnect) await prisma.$disconnect();
        return { ok: true, resolved: 0 };
    }

    console.log(`[resolve] queue ${queue.length} places`);
    const { browser, page } = await createGmapsPage();
    const stats = { resolved: 0, missed: 0, captcha: 0, mismatch: 0 };

    for (const p of queue) {
        try {
            const r = await findPlaceByName(page, {
                name: p.name,
                city: p.city,
                country: p.country,
                lat: p.lat ? Number(p.lat) : null,
                lng: p.lng ? Number(p.lng) : null,
            });

            if (r && r.error === "captcha") {
                console.warn(`[resolve] #${p.id} CAPTCHA — aborting tick`);
                stats.captcha++;
                break;
            }

            if (!r || !r.matched) {
                const reason = r?.reason || "no-match";
                console.log(`[resolve] #${p.id} "${p.name}" — ${reason}`);
                // 2026-05-30: for definitive mismatches (found a place,
                // verified it's the wrong one) bump enrichmentVersion=1
                // so the queue stops re-picking. Retrying won't change
                // the outcome unless the input data (name, city, coords)
                // changes — which would require human edit. For
                // "no-match" (resolver returned null), also mark — same
                // logic, this place simply isn't on Google Maps.
                await prisma.place.update({
                    where: { id: p.id },
                    data: {
                        enrichedAt: new Date(),
                        enrichmentVersion: 1,
                    },
                }).catch((e) => {
                    console.warn(`[resolve] #${p.id} mark-mismatch DB update failed: ${e.message}`);
                });
                if (reason === "name-mismatch" || reason === "coord-mismatch") stats.mismatch++;
                else stats.missed++;
                await sleep(3000);
                continue;
            }

            // Match confirmed. Write placeId, bump enrichmentVersion,
            // stamp enrichedAt. Downstream phases (galleryScrape,
            // scrapeReviews, ratingsDist, TA) will pick it up next tick.
            try {
                await prisma.place.update({
                    where: { id: p.id },
                    data: {
                        googlePlaceId: r.placeId,
                        enrichmentVersion: 1,
                        enrichedAt: new Date(),
                        ...(r.lat != null && r.lng != null && (p.lat == null || p.lng == null) ? {
                            lat: r.lat, lng: r.lng,
                        } : {}),
                    },
                });
                console.log(`[resolve] #${p.id} "${p.name}" → placeId=${r.placeId} (heading="${r.heading || ''}")`);
                stats.resolved++;
            } catch (writeErr) {
                // P2002 = unique constraint violation on googlePlaceId. Means
                // ANOTHER place already has this googlePlaceId — i.e. p is a
                // duplicate of an existing row. Don't crash + retry forever.
                // Mark enrichmentVersion=1 so the queue stops picking it,
                // and log loudly as a dedup candidate.
                const isUniqueViolation = writeErr.code === "P2002"
                    || /Unique constraint failed/i.test(writeErr.message || "");
                if (isUniqueViolation) {
                    const dup = await prisma.place.findFirst({
                        where: { googlePlaceId: r.placeId, NOT: { id: p.id } },
                        select: { id: true, name: true, city: true },
                    }).catch(() => null);
                    console.warn(`[resolve] #${p.id} "${p.name}" → DUPLICATE of #${dup?.id} "${dup?.name}" (${dup?.city}) — both resolve to ${r.placeId}; marking enrichmentVersion=1 to skip future ticks. Manual dedup candidate.`);
                    await prisma.place.update({
                        where: { id: p.id },
                        data: { enrichmentVersion: 1, enrichedAt: new Date() },
                    }).catch(() => {});
                    stats.missed++;
                } else {
                    throw writeErr;
                }
            }
            await sleep(3000);
        } catch (err) {
            console.warn(`[resolve] #${p.id} crash: ${err.message}`);
            stats.missed++;
            await sleep(3000);
        }
    }

    await browser.close().catch(() => {});
    if (disconnect) await prisma.$disconnect();
    return { ok: true, stats, ...stats };
}

module.exports = { run };

if (require.main === module) {
    const args = process.argv.slice(2);
    const limit = (() => {
        const i = args.indexOf("--limit");
        if (i === -1) return 5;
        const n = parseInt(args[i + 1], 10);
        return Number.isFinite(n) ? n : 5;
    })();
    run({ limit, disconnect: true })
        .then((r) => console.log(JSON.stringify({ summary: r.stats || {} }, null, 2)))
        .catch((e) => { console.error(e); process.exit(1); });
}
