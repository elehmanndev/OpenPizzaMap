// Field-by-field merge of one duplicate Place pair into its survivor.
// Extracted from scripts/admin/merge-pair.js so the admin web UI and the
// CLI tool share one implementation. Pure functions plus DB helpers —
// no I/O at module load time.
//
// Public API:
//   buildMergePlan(prisma, survivorId, dropId)
//     → { survivor, drop, decisions, sourcesToCopy, imagesToMove,
//         imagesSkipped, reviewsToMove, reviewsSkipped, visitsToMove,
//         visitsSkipped, favoritesToMove, favoritesSkipped, faqsToMove,
//         error? }
//   applyMergePlan(prisma, plan)
//     → { merged: true, droppedId, survivorId, fieldsPatched, ... }
//
// Caller decides UX (CLI prints + confirms, or the web form previews
// then applies on a second POST).

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
    slug: true,
};

const isEmpty = (v) => v == null || (typeof v === "string" && v.trim() === "");
const longer = (a, b) => (b != null && String(b).length > String(a ?? "").length);
const hasIntlPhone = (s) => typeof s === "string" && /^\+/.test(s.replace(/\s+/g, ""));

function pickField(field, sv, dv) {
    if (isEmpty(sv) && isEmpty(dv)) return null;
    if (isEmpty(sv) && !isEmpty(dv)) return { value: dv, reason: "survivor empty" };
    if (isEmpty(dv)) return null;

    switch (field) {
        case "name":
        case "addressLine":
        case "region":
        case "openingHours":
        case "descriptionHtml":
        case "tripadvisorRanking":
            if (longer(sv, dv)) return { value: dv, reason: `longer (${String(dv).length} > ${String(sv).length})` };
            return null;
        case "websiteUrl":
            if (/^http:/.test(sv) && /^https:/.test(dv)) return { value: dv, reason: "drop uses https" };
            if (/^https:/.test(sv) && /^http:/.test(dv)) return null;
            if (longer(sv, dv)) return { value: dv, reason: `longer (${dv.length} > ${sv.length})` };
            return null;
        case "phone":
            if (!hasIntlPhone(sv) && hasIntlPhone(dv)) return { value: dv, reason: "drop uses international format" };
            return null;
        case "stylesJson": {
            let svArr, dvArr;
            try { svArr = JSON.parse(sv) || []; } catch { svArr = []; }
            try { dvArr = JSON.parse(dv) || []; } catch { dvArr = []; }
            const merged = Array.from(new Set([...svArr, ...dvArr]));
            if (merged.length > svArr.length) {
                return { value: JSON.stringify(merged), reason: `union (${svArr.length}+${dvArr.length} → ${merged.length})` };
            }
            return null;
        }
        case "googleReviewCount":
        case "tripadvisorReviewCount":
        case "yelpReviewCount":
            if (Number(dv) > Number(sv)) return { value: dv, reason: `drop has higher count (${dv} > ${sv})` };
            return null;
        case "enrichmentVersion":
            if (Number(dv) > Number(sv)) return { value: dv, reason: `higher version (${dv} > ${sv})` };
            return null;
        case "priceLevel":
            if (Number(sv) === 2 && Number(dv) !== 2 && dv != null) return { value: dv, reason: "drop is non-default" };
            return null;
        default:
            return null;
    }
}

async function buildMergePlan(prisma, svId, dvId) {
    if (!svId || !dvId) return { error: "survivor and drop both required" };
    if (svId === dvId) return { error: "survivor and drop must differ" };

    const [sv, dv] = await Promise.all([
        prisma.place.findUnique({ where: { id: svId }, select: SELECT }),
        prisma.place.findUnique({ where: { id: dvId }, select: SELECT }),
    ]);
    if (!sv) return { error: `No place row with id=${svId}` };
    if (!dv) return { error: `No place row with id=${dvId}` };

    const patch = {};
    const decisions = [];
    for (const field of Object.keys(SELECT)) {
        if (["id", "isVisible", "slug"].includes(field)) continue;
        const pick = pickField(field, sv[field], dv[field]);
        if (!pick) continue;
        patch[field] = pick.value;
        decisions.push({ field, before: sv[field], after: pick.value, reason: pick.reason });
    }
    for (const [r, c] of [["googleRating", "googleReviewCount"], ["tripadvisorRating", "tripadvisorReviewCount"], ["yelpRating", "yelpReviewCount"]]) {
        if (patch[c] != null && dv[r] != null && String(sv[r]) !== String(dv[r])) {
            patch[r] = dv[r];
            decisions.push({ field: r, before: sv[r], after: dv[r], reason: `paired with ${c}` });
        }
    }

    const dropSources = await prisma.placeSource.findMany({ where: { placeId: dv.id } });
    const svSourceKeys = new Set((await prisma.placeSource.findMany({
        where: { placeId: sv.id }, select: { source: true },
    })).map((r) => r.source));
    const sourcesToCopy = dropSources.filter((s) => !svSourceKeys.has(s.source));

    const dropImages = await prisma.placeImage.findMany({ where: { placeId: dv.id }, orderBy: { position: "asc" } });
    const svImages = await prisma.placeImage.findMany({ where: { placeId: sv.id }, select: { position: true, sourceRef: true } });
    const svImageRefs = new Set(svImages.map((i) => i.sourceRef).filter(Boolean));
    let nextPosition = svImages.reduce((m, i) => Math.max(m, i.position), 0) + 1;
    const imagesToMove = [];
    const imagesSkipped = [];
    for (const img of dropImages) {
        if (img.sourceRef && svImageRefs.has(img.sourceRef)) imagesSkipped.push(img);
        else imagesToMove.push({ id: img.id, newPosition: nextPosition++, source: img.source, localPath: img.localPath });
    }

    const planUserScoped = async (model) => {
        const dropRows = await prisma[model].findMany({ where: { placeId: dv.id }, select: { id: true, userId: true } });
        if (!dropRows.length) return { move: [], skip: [] };
        const svUserIds = new Set((await prisma[model].findMany({
            where: { placeId: sv.id }, select: { userId: true },
        })).map((r) => r.userId));
        const move = [], skip = [];
        for (const r of dropRows) (svUserIds.has(r.userId) ? skip : move).push(r);
        return { move, skip };
    };
    const reviews = await planUserScoped("review");
    const visits = await planUserScoped("visit");
    const favorites = await planUserScoped("favorite");
    const faqs = await prisma.faq.findMany({ where: { placeId: dv.id }, select: { id: true, question: true } });

    return {
        survivor: sv,
        drop: dv,
        patch,
        decisions,
        sourcesToCopy,
        imagesToMove,
        imagesSkipped,
        reviewsToMove: reviews.move,
        reviewsSkipped: reviews.skip,
        visitsToMove: visits.move,
        visitsSkipped: visits.skip,
        favoritesToMove: favorites.move,
        favoritesSkipped: favorites.skip,
        faqsToMove: faqs,
    };
}

async function applyMergePlan(prisma, plan) {
    const { survivor: sv, drop: dv, patch, sourcesToCopy, imagesToMove,
        reviewsToMove, visitsToMove, favoritesToMove, faqsToMove } = plan;

    await prisma.$transaction(async (tx) => {
        if (Object.keys(patch).length) {
            const changedIdentity = ["lat", "lng", "googlePlaceId", "addressLine"].some((f) => f in patch);
            const data = { ...patch };
            if (changedIdentity) data.enrichmentVersion = 0;
            await tx.place.update({ where: { id: sv.id }, data });
        }
        for (const s of sourcesToCopy) {
            await tx.placeSource.create({ data: { placeId: sv.id, source: s.source, rank: s.rank } });
        }
        for (const m of imagesToMove) {
            await tx.placeImage.update({ where: { id: m.id }, data: { placeId: sv.id, position: m.newPosition } });
        }
        for (const r of reviewsToMove) await tx.review.update({ where: { id: r.id }, data: { placeId: sv.id } });
        for (const r of visitsToMove) await tx.visit.update({ where: { id: r.id }, data: { placeId: sv.id } });
        for (const r of favoritesToMove) await tx.favorite.update({ where: { id: r.id }, data: { placeId: sv.id } });
        if (faqsToMove.length) {
            await tx.faq.updateMany({ where: { placeId: dv.id }, data: { placeId: sv.id } });
        }
        // enrichmentVersion = -1: do not auto-publish on the next publishReady tick.
        await tx.place.update({ where: { id: dv.id }, data: { isVisible: false, enrichmentVersion: -1 } });
    });

    return {
        merged: true,
        survivorId: sv.id,
        droppedId: dv.id,
        fieldsPatched: Object.keys(patch).length,
        sourcesCopied: sourcesToCopy.length,
        imagesMoved: imagesToMove.length,
        reviewsMoved: reviewsToMove.length,
        visitsMoved: visitsToMove.length,
        favoritesMoved: favoritesToMove.length,
        faqsMoved: faqsToMove.length,
    };
}

module.exports = { buildMergePlan, applyMergePlan };
