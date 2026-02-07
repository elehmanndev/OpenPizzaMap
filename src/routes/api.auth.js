const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");
const { sendVerificationEmail, sendPasswordResetEmail } = require("../services/email");
const passport = require("passport");
const { isGoogleAuthConfigured, getGoogleCallbackUrl } = require("../services/googleAuth");

const router = express.Router();

const registerSchema = z.object({
    email: z.string().trim().email(),
    password: z
        .string()
        .min(8)
        .max(128)
        .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include letters and numbers"),
    username: z
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
    login: z.string().trim().min(3).max(254),
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

const setPasswordSchema = z.object({
    email: z.string().trim().email(),
    username: z
        .string()
        .trim()
        .min(3)
        .max(20)
        .regex(/^[A-Za-z0-9_]+$/, "Username can use letters, numbers, and underscores")
        .optional(),
    password: z
        .string()
        .min(8)
        .max(128)
        .regex(/^(?=.*[A-Za-z])(?=.*\d).+$/, "Password must include letters and numbers"),
    confirmPassword: z.string().min(1).max(128),
}).refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
});

router.post("/register", authLimiter, async (req, res) => {
    try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

        const { email, password, username } = parsed.data;
        const newsletterOptIn = parsed.data.newsletterOptIn === true;
        const existing = await prisma.user.findUnique({ where: { email } });
        if (existing) {
            if (!existing.passwordHash) {
                return res.status(409).json({
                    ok: false,
                    error: "google_account",
                    email,
                });
            }
            return res.status(409).json({ ok: false, error: "Email already in use" });
        }

        const nameTaken = await prisma.user.findFirst({ where: { username } });
        if (nameTaken) return res.status(409).json({ ok: false, error: "Username already taken" });

        const passwordHash = await bcrypt.hash(password, 12);
        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const tokenExpiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24);

        const user = await prisma.user.create({
            data: {
                email,
                passwordHash,
                displayName: username,
                username,
                role: "user",
                verificationTokenHash: tokenHash,
                verificationTokenExpiresAt: tokenExpiresAt,
                newsletterOptIn,
            },
            select: { id: true, email: true, displayName: true, username: true, role: true },
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

        const { login, password } = parsed.data;
        const normalized = login.trim();
        const isEmail = normalized.includes("@");
        let user = isEmail
            ? await prisma.user.findUnique({ where: { email: normalized.toLowerCase() } })
            : await prisma.user.findUnique({ where: { username: normalized } });

        if (!user || !user.passwordHash) {
            if (user && !user.passwordHash && isEmail) {
                const passwordOk = /^(?=.*[A-Za-z])(?=.*\d).{8,128}$/.test(password);
                if (!passwordOk) {
                    return res.status(400).json({
                        ok: false,
                        error: "Password must be at least 8 characters and include letters and numbers.",
                    });
                }

                const passwordHash = await bcrypt.hash(password, 12);
                const updates = {
                    passwordHash,
                    emailVerifiedAt: user.emailVerifiedAt || new Date(),
                    verificationTokenHash: null,
                    verificationTokenExpiresAt: null,
                };

                user = await prisma.user.update({
                    where: { id: user.id },
                    data: updates,
                });

                req.session.user = {
                    id: user.id,
                    email: user.email,
                    displayName: user.displayName,
                    username: user.username,
                    role: user.role,
                };

                if (!user.username) {
                    return res.json({ ok: true, redirect: "/set-username" });
                }
                return res.json({ ok: true, redirect: "/me" });
            }

            return res.status(401).json({ ok: false, error: "Incorrect email/username or password." });
        }
        if (!user.emailVerifiedAt) {
            return res.status(403).json({ ok: false, error: "Please verify your email before signing in." });
        }

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ ok: false, error: "Incorrect email/username or password." });

        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            username: user.username,
            role: user.role,
        };
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

        try {
            await prisma.user.update({
                where: { id: user.id },
                data: {
                    resetTokenHash: tokenHash,
                    resetTokenExpiresAt: tokenExpiresAt,
                },
            });
        } catch (dbErr) {
            console.error("Reset token update failed:", dbErr);
            return res.json({ ok: true });
        }

        try {
            await sendPasswordResetEmail({ to: email, token });
        } catch (mailErr) {
            console.error("Password reset email failed:", mailErr);
        }

        return res.json({ ok: true });
    } catch (err) {
        console.error("Reset request failed:", err);
        return res.json({ ok: true });
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
        const updated = await prisma.user.update({
            where: { id: user.id },
            data: {
                passwordHash,
                resetTokenHash: null,
                resetTokenExpiresAt: null,
            },
            select: { id: true, email: true, displayName: true, username: true, role: true },
        });

        req.session.user = updated;
        return res.json({ ok: true, user: updated });
    } catch (err) {
        console.error("Password reset failed:", err);
        return res.status(500).json({ ok: false, error: "Reset failed" });
    }
});

router.post("/set-password", authLimiter, async (req, res) => {
    try {
        const parsed = setPasswordSchema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });

        const { email, password, username } = parsed.data;
        const user = await prisma.user.findUnique({ where: { email } });
        if (!user) return res.status(404).json({ ok: false, error: "Account not found" });
        if (user.passwordHash) {
            return res.status(409).json({ ok: false, error: "Password already set" });
        }
        if (!user.username) {
            if (!username) {
                return res.status(400).json({ ok: false, error: "Username is required." });
            }
            const existingUsername = await prisma.user.findFirst({ where: { username } });
            if (existingUsername) {
                return res.status(409).json({ ok: false, error: "Username already taken" });
            }
        }

        const passwordHash = await bcrypt.hash(password, 12);
        const updates = {
            passwordHash,
            emailVerifiedAt: user.emailVerifiedAt || new Date(),
            verificationTokenHash: null,
            verificationTokenExpiresAt: null,
        };
        if (!user.username && username) updates.username = username;

        const updated = await prisma.user.update({
            where: { id: user.id },
            data: updates,
            select: { id: true, email: true, displayName: true, username: true, role: true },
        });

        req.session.user = updated;
        return res.json({ ok: true, user: updated });
    } catch (err) {
        console.error("Set password failed:", err);
        return res.status(500).json({ ok: false, error: "Set password failed" });
    }
});

router.post("/logout", async (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

router.get("/google", (req, res, next) => {
    if (!isGoogleAuthConfigured()) {
        return res.status(503).send("Google auth not configured");
    }
    const callbackURL = getGoogleCallbackUrl(req);
    if (!callbackURL) {
        return res.status(500).send("Google callback URL not available");
    }
    return passport.authenticate("google", {
        scope: ["profile", "email"],
        prompt: "select_account",
        callbackURL,
    })(
        req,
        res,
        next
    );
});

router.get("/google/callback", (req, res, next) => {
    if (!isGoogleAuthConfigured()) {
        return res.status(503).send("Google auth not configured");
    }
    if (!req.query || !req.query.code) {
        const reason = typeof req.query?.error === "string" ? req.query.error : "missing_code";
        return res.redirect(`/login?google=${encodeURIComponent(reason)}`);
    }
    const callbackURL = getGoogleCallbackUrl(req);
    if (!callbackURL) {
        return res.status(500).send("Google callback URL not available");
    }
    return passport.authenticate("google", { session: false, callbackURL }, (err, user) => {
        if (err || !user) {
            console.error("Google auth failed:", err);
            return res.redirect("/login?google=failed");
        }
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            username: user.username,
            role: user.role,
        };
        if (!user.username) {
            return res.redirect("/set-username");
        }
        return res.redirect("/me");
    })(req, res, next);
});

router.post("/set-username", authLimiter, async (req, res) => {
    try {
        const schema = z.object({
            username: z
                .string()
                .trim()
                .min(3)
                .max(20)
                .regex(/^[A-Za-z0-9_]+$/, "Username can use letters, numbers, and underscores"),
        });
        const parsed = schema.safeParse(req.body);
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
        if (!req.session || !req.session.user) {
            return res.status(401).json({ ok: false, error: "Unauthorized" });
        }

        const { username } = parsed.data;
        const existing = await prisma.user.findFirst({ where: { username } });
        if (existing) return res.status(409).json({ ok: false, error: "Username already taken" });

        const updated = await prisma.user.update({
            where: { id: req.session.user.id },
            data: { username },
            select: { id: true, email: true, displayName: true, username: true, role: true },
        });

        req.session.user = updated;
        return res.json({ ok: true, user: updated });
    } catch (err) {
        console.error("Set username failed:", err);
        return res.status(500).json({ ok: false, error: "Set username failed" });
    }
});

module.exports = router;
