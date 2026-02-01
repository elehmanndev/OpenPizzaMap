const { prisma } = require("../db");

async function approveSubmission({ submissionId, reviewerId }) {
    const sub = await prisma.submission.findUnique({ where: { id: submissionId } });
    if (!sub) throw new Error("Submission not found");
    if (sub.status !== "pending") throw new Error("Submission not pending");

    const payload = JSON.parse(sub.payloadJson);

    if (sub.type === "new_place") {
        await prisma.place.create({ data: payload });
    } else if (sub.type === "edit_place") {
        if (!sub.targetPlaceId) throw new Error("Missing targetPlaceId");
        await prisma.place.update({ where: { id: sub.targetPlaceId }, data: payload });
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
