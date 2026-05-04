const { prisma } = require("../db");
const { buildSitemapXml, writeSitemapFiles } = require("./sitemap");
const { ensureCityCountryAfterPlaceApproved } = require("./landingAutoCreate");
const { sanitizeRichText } = require("./sanitize");
const { enrichAndValidate } = require("./enrichment");
const { PIPELINE_VERSION } = require("./enrichment/providers");

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
        // Run the enrichment pipeline (docs/enrichment-pipeline.md) before
        // creating. If it finds a duplicate or fails the coord-sanity gate,
        // refuse — admin investigates rather than silently creating a bad row.
        const verdict = await enrichAndValidate({
            name: payload.name,
            city: payload.city,
            country: payload.country,
            lat: payload.lat,
            lng: payload.lng,
        }, { prisma });

        if (verdict.action === "merge_into") {
            const e = new Error(
                `Submission overlaps existing place #${verdict.existing.id} (${verdict.existing.name}, ${verdict.existing.city}). ` +
                `Match via ${verdict.reasons.join("; ")}. Reject this submission and edit the existing place instead.`
            );
            e.code = "ENRICH_DUPLICATE";
            e.existingPlaceId = verdict.existing.id;
            throw e;
        }
        if (verdict.action === "manual_review") {
            const e = new Error(
                `Submission failed enrichment: ${verdict.reasons.join("; ")}. Verify the place exists and has correct coords before approving.`
            );
            e.code = "ENRICH_MANUAL_REVIEW";
            throw e;
        }

        // action === "insert" — enrich the payload with what the pipeline
        // resolved before writing.
        const enrichedPayload = { ...payload };
        if (verdict.coords.chosenLat != null) enrichedPayload.lat = verdict.coords.chosenLat;
        if (verdict.coords.chosenLng != null) enrichedPayload.lng = verdict.coords.chosenLng;
        if (verdict.resolved?.googlePlaceId) enrichedPayload.googlePlaceId = verdict.resolved.googlePlaceId;
        if (verdict.resolved?.googleMapsUrl) enrichedPayload.googlePlaceUrl = verdict.resolved.googleMapsUrl;
        enrichedPayload.enrichmentVersion = PIPELINE_VERSION;
        if (verdict.resolved) enrichedPayload.enrichedAt = new Date();

        place = await prisma.place.create({ data: enrichedPayload });
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
