const express = require("express");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const signupSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
    source: z.string().trim().max(40).optional(),
});

router.post("/", authLimiter, async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ ok: false, error: "Please enter a valid email." });
    }
    const { email, source } = parsed.data;
    await prisma.newsletterSignup.upsert({
        where: { email },
        update: {},
        create: { email, source: source || "maintenance" },
    });
    res.json({ ok: true });
});

module.exports = router;
