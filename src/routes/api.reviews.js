const express = require("express");
const { prisma } = require("../db");
const { recalcPlaceOpmRating } = require("../services/opm-rating");

const router = express.Router();

function requireApiAuth(req, res, next) {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, error: "Sign in required" });
    }
    next();
}

// DELETE /api/reviews/:id — only the review's author may delete. The
// visit row is left in place because the user can re-review later;
// removing it would also undo the implicit "I've been here" without
// the user explicitly asking.
router.delete("/:id", requireApiAuth, async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "Bad id" });

    const review = await prisma.review.findUnique({
        where: { id },
        select: { id: true, userId: true, placeId: true },
    });
    if (!review) return res.status(404).json({ ok: false, error: "Not found" });
    if (review.userId !== req.session.user.id) {
        return res.status(403).json({ ok: false, error: "Forbidden" });
    }

    await prisma.review.delete({ where: { id } });
    const opmRating = await recalcPlaceOpmRating(prisma, review.placeId);

    res.json({ ok: true, opmRating });
});

module.exports = router;
