const express = require("express");
const crypto = require("crypto");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");
const { sendMagicLinkEmail } = require("../services/email");
const passport = require("passport");
const { isGoogleAuthConfigured, getGoogleCallbackUrl } = require("../services/googleAuth");

const router = express.Router();

const startSchema = z.object({
    email: z.string().trim().toLowerCase().email(),
});

const TOKEN_TTL_MS = 1000 * 60 * 30; // 30 minutes

router.post("/start", authLimiter, async (req, res) => {
    try {
        const parsed = startSchema.safeParse(req.body);
        if (!parsed.success) {
            return res.status(400).json({ ok: false, error: "Please enter a valid email." });
        }

        const { email } = parsed.data;

        const token = crypto.randomBytes(32).toString("hex");
        const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
        const tokenExpiresAt = new Date(Date.now() + TOKEN_TTL_MS);

        const existing = await prisma.user.findUnique({ where: { email } });

        let isNewUser = false;
        if (existing) {
            await prisma.user.update({
                where: { id: existing.id },
                data: {
                    verificationTokenHash: tokenHash,
                    verificationTokenExpiresAt: tokenExpiresAt,
                },
            });
        } else {
            isNewUser = true;
            await prisma.user.create({
                data: {
                    email,
                    displayName: email.split("@")[0].slice(0, 60),
                    role: "user",
                    verificationTokenHash: tokenHash,
                    verificationTokenExpiresAt: tokenExpiresAt,
                    newsletterOptIn: true,
                },
            });
        }

        try {
            await sendMagicLinkEmail({ to: email, token, isNewUser });
        } catch (mailErr) {
            console.error("Magic-link email failed:", mailErr);
            return res.status(500).json({ ok: false, error: "Failed to send sign-in email. Try again." });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error("Auth start failed:", err);
        res.status(500).json({ ok: false, error: "Could not start sign-in." });
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
    })(req, res, next);
});

router.get("/google/callback", (req, res, next) => {
    if (!isGoogleAuthConfigured()) {
        return res.status(503).send("Google auth not configured");
    }
    if (!req.query || !req.query.code) {
        return res.redirect("/auth?google=failed");
    }
    const callbackURL = getGoogleCallbackUrl(req);
    if (!callbackURL) {
        return res.status(500).send("Google callback URL not available");
    }
    return passport.authenticate("google", { session: false, callbackURL }, (err, user) => {
        if (err || !user) {
            console.error("Google auth failed:", err);
            return res.redirect("/auth?google=failed");
        }
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            username: user.username,
            role: user.role,
        };
        const target = user.username ? "/me" : "/set-username";
        // Force the session to persist before responding. PrismaSessionStore
        // writes to MySQL; the implicit save inside res.end has races on
        // shared hosting that occasionally let the 302 fire before the row
        // exists, leaving the next request unauthenticated.
        return req.session.save((saveErr) => {
            if (saveErr) {
                console.error("Session save failed after Google auth:", saveErr);
                return res.redirect("/auth?google=failed");
            }
            return res.redirect(target);
        });
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
