const express = require("express");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");
const passport = require("passport");
const { isGoogleAuthConfigured, getGoogleCallbackUrl } = require("../services/googleAuth");

const router = express.Router();

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
            avatarUrl: user.avatarUrl || null,
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
            select: { id: true, email: true, displayName: true, username: true, role: true, avatarUrl: true },
        });

        req.session.user = updated;
        return res.json({ ok: true, user: updated });
    } catch (err) {
        console.error("Set username failed:", err);
        return res.status(500).json({ ok: false, error: "Set username failed" });
    }
});

module.exports = router;
