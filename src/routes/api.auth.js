const express = require("express");
const bcrypt = require("bcryptjs");
const { z } = require("zod");
const { prisma } = require("../db");
const { authLimiter } = require("../middleware/rateLimit");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;

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

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleCallbackUrl = process.env.GOOGLE_CALLBACK_URL;

const googleOAuthEnabled = !!(googleClientId && googleClientSecret && googleCallbackUrl);

if (googleOAuthEnabled) {
    passport.use(
        new GoogleStrategy(
            {
                clientID: googleClientId,
                clientSecret: googleClientSecret,
                callbackURL: googleCallbackUrl,
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const email = profile.emails && profile.emails[0] ? profile.emails[0].value.toLowerCase() : null;
                    if (!email) return done(new Error("Google account missing email"));

                    let user = await prisma.user.findUnique({ where: { googleId: profile.id } });

                    if (!user) {
                        const byEmail = await prisma.user.findUnique({ where: { email } });
                        if (byEmail) {
                            user = await prisma.user.update({
                                where: { id: byEmail.id },
                                data: { googleId: profile.id },
                            });
                        } else {
                            user = await prisma.user.create({
                                data: {
                                    email,
                                    passwordHash: null,
                                    googleId: profile.id,
                                    displayName: profile.displayName || email.split("@")[0],
                                    role: "user",
                                },
                            });
                        }
                    }

                    return done(null, {
                        id: user.id,
                        email: user.email,
                        displayName: user.displayName,
                        role: user.role,
                    });
                } catch (err) {
                    return done(err);
                }
            }
        )
    );
}

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
    if (!user || !user.passwordHash) {
        return res.status(401).json({ ok: false, error: "Use Google login for this account" });
    }

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });

    req.session.user = { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
    res.json({ ok: true, user: req.session.user });
});

router.post("/logout", async (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

router.get("/google", (req, res, next) => {
    if (!googleOAuthEnabled) {
        return res.status(503).send("Google OAuth not configured");
    }
    return passport.authenticate("google", {
        scope: ["profile", "email"],
        session: false,
    })(req, res, next);
});

router.get(
    "/google/callback",
    (req, res, next) => {
        if (!googleOAuthEnabled) {
            return res.status(503).send("Google OAuth not configured");
        }
        return passport.authenticate("google", {
            session: false,
            failureRedirect: "/login?error=google",
        })(req, res, next);
    },
    (req, res) => {
        req.session.user = req.user;
        res.redirect("/map");
    }
);

module.exports = router;
