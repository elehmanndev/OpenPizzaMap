const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");
const { sendVerificationEmail, sendPasswordResetEmail } = require("../services/email");

const router = express.Router();

const registerSchema = z.object({
    email: z.string().trim().email(),
    password: z
        .string()
        .min(8)
        .max(128)
        .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include letters and numbers"),
    displayName: z
        .string()
        .trim()
        .min(3)
        .max(20)
        .regex(/^[A-Za-z0-9_]+$/, "Username can use letters, numbers, and underscores"),
    newsletterOptIn: z
        .preprocess(
            (value) => value === true || value === "true" || value === "on",
            z.boolean()
        )
        .optional(),
    termsAccepted: z
        .preprocess(
            (value) => value === true || value === "true" || value === "on",
            z.boolean()
        )
        .refine((val) => val === true, "Terms must be accepted"),
});

const loginSchema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(1).max(128),
});

const resetRequestSchema = z.object({
    email: z.string().trim().email(),
});

const resetSchema = z.object({
    token: z.string().min(10),
    password: z
        .string()
        .min(8)
        .max(128)
        .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include letters and numbers"),
});

router.post("/register", authLimiter, async (req, res) => {
    try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

        const { email, password, displayName } = parsed.data;
        const newsletterOptIn = parsed.data.newsletterOptIn === true;
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) return res.status(409).json({ ok: false, error: "Email already in use" });

        const nameTaken = await prisma.user.findFirst({ where: { displayName } });
        if (nameTaken) return res.status(409).json({ ok: false, error: "Username already taken" });

        const passwordHash = await bcrypt.hash(password, 12);
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const tokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                displayName,
                role: "user",
                verificationTokenHash: tokenHash,
                verificationTokenExpiresAt: tokenExpiresAt,
                newsletterOptIn,
            },
            select: { id: true, email: true, displayName: true, role: true },
        });

        try {
            await sendVerificationEmail({ to: email, token });
        } catch (mailErr) {
            await prisma.user.delete({ where: { id: user.id } });
            console.error("Verification email failed:", mailErr);
            return res.status(500).json({ ok: false, error: "Failed to send verification email" });
        }

        res.json({ ok: true });
    } catch (err) {
        if (err && err.code === "P2002") {
            return res.status(409).json({ ok: false, error: "Email or username already in use" });
        }
        console.error("Register failed:", err);
        res.status(500).json({ ok: false, error: "Registration failed" });
    }
});

router.post("/login", authLimiter, async (req, res) => {
    try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

        const { email, password } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
            return res.status(401).json({ ok: false, error: "Invalid credentials" });
        }
        if (!user.emailVerifiedAt) {
            return res.status(403).json({ ok: false, error: "Please verify your email before signing in." });
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

        req.session.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
        res.json({ ok: true, user: req.session.user });
    } catch (err) {
        console.error("Login failed:", err);
        res.status(500).json({ ok: false, error: "Login failed" });
    }
});

router.post("/forgot", authLimiter, async (req, res) => {
    try {
        const parsed = resetRequestSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false });

        const { email } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user || !user.passwordHash) {
            return res.json({ ok: true });
        }

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const tokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60);

        await prisma.user.update({
            where: { id: user.id },
            data: {
                resetTokenHash: tokenHash,
                resetTokenExpiresAt: tokenExpiresAt,
            },
        });

        try {
            await sendPasswordResetEmail({ to: email, token });
        } catch (mailErr) {
            console.error("Password reset email failed:", mailErr);
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error("Reset request failed:", err);
        return res.status(500).json({ ok: false });
    }
});

router.post("/reset", authLimiter, async (req, res) => {
    try {
        const parsed = resetSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

        const { token, password } = parsed.data;
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const user = await prisma.user.findFirst({ where: { resetTokenHash: tokenHash } });
        if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date()) {
            return res.status(400).json({ ok: false, error: "Reset link is invalid or expired." });
        }

        const passwordHash = await bcrypt.hash(password, 12);
        await prisma.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                resetTokenHash: null,
                resetTokenExpiresAt: null,
            },
        });

        return res.json({ ok: true });
    } catch (err) {
        console.error("Password reset failed:", err);
        return res.status(500).json({ ok: false, error: "Reset failed" });
    }
});

router.post("/logout", async (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
