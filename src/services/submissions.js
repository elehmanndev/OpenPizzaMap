const { prisma } = require("../db");
const { buildSitemapXml, writeSitemapFiles } = require("./sitemap");
const { ensureCityCountryAfterPlaceApproved } = require("./landingAutoCreate");
const { sanitizeRichText } = require("./sanitize");

function pick(obj, keys) {
    const out = {};
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) out[k] = obj[k];
    }
    return out;
}

async function rebuildSitemapBestEffort() {
    try {
        const xml = await buildSitemapXml(prisma);
        writeSitemapFiles(xml);
    } catch (err) {
        console.error("Sitemap update failed:", err && err.message ? err.message : err);
    }
}

async function approveSubmission({ submissionId, reviewerId }) {
    const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
    if (!sub) throw new Error("Submission not found");
    if (sub.status !== "pending") throw new Error("Submission not pending");

    const payload = JSON.parse(sub.payloadJson);
    let place = null;

    if (sub.type === "new_place") {
        place = await prisma.place.create({ data: payload });
    } else if (sub.type === "edit_place") {
        if (!sub.targetPlaceId) throw new Error("Missing targetPlaceId");
        const allowed = pick(payload, [
            "name",
            "addressLine",
            "city",
            "region",
            "postalCode",
            "country",
            "lat",
            "lng",
            "priceLevel",
            "stylesJson",
            "dineIn",
            "takeaway",
            "delivery",
            "websiteUrl",
            "googleMapsUrl",
            "instagramUrl",
            "status",
            "slug",
            "descriptionHtml",
            "heroImageUrl",
            "seoTitle",
            "seoDescription",
            "isVisible",
            "cityId",
        ]);

        if (typeof allowed.descriptionHtml === "string") {
            allowed.descriptionHtml = sanitizeRichText(allowed.descriptionHtml);
        }

        place = await prisma.place.update({ where: { id: sub.targetPlaceId }, data: allowed });
    } else {
        throw new Error("Unknown submission type");
    }

    await prisma.submission.update({
        where: { id: submissionId },
        data: {
            status: "approved",
            reviewedAt: new Date(),
            reviewedByUserId: reviewerId,
        },
    });

    // Post-approve hooks. Keep failures non-fatal for the approval action.
    try {
        await ensureCityCountryAfterPlaceApproved(place);
    } catch (err) {
        console.error("Auto city/country ensure failed:", err && err.message ? err.message : err);
    }
    await rebuildSitemapBestEffort();
}

async function rejectSubmission({ submissionId, reviewerId, reason }) {
    await prisma.submission.update({
        where: { id: submissionId },
        data: {
            status: "rejected",
            rejectionReason: reason || "Rejected",
            reviewedAt: new Date(),
            reviewedByUserId: reviewerId,
        },
    });
}

module.exports = { approveSubmission, rejectSubmission };
