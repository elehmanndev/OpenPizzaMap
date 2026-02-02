const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");

const router = express.Router();

const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    displayName: z.string().min(2).max(40),
});

const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1).max(128),
});

router.post("/register", authLimiter, async (req, res) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { email, password, displayName } = parsed.data;
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return res.status(409).json({ ok: false, error: "Email already in use" });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
        data: { email, passwordHash, displayName, role: "user" },
        select: { id: true, email: true, displayName: true, role: true },
    });

    req.session.user = user;
    res.json({ ok: true, user });
});

router.post("/login", authLimiter, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

    const { email, password } = parsed.data;
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    req.session.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
    res.json({ ok: true, user: req.session.user });
});

router.post("/logout", async (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
