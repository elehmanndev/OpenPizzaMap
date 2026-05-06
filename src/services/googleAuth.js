const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { prisma } = require("../db");

function buildCallbackUrl() {
    if (process.env.GOOGLE_CALLBACK_URL) return process.env.GOOGLE_CALLBACK_URL;
    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) return null;
    return `${baseUrl.replace(/\/$/, "")}/api/auth/google/callback`;
}

function getGoogleCallbackUrl(req) {
    const envUrl = buildCallbackUrl();
    if (envUrl) return envUrl;
    if (!req) return null;
    const host = req.get("host");
    if (!host) return null;
    const forwardedProto = req.get("x-forwarded-proto");
    const proto = (forwardedProto || req.protocol || "http").split(",")[0].trim();
    return `${proto}://${host}/api/auth/google/callback`;
}

function isGoogleAuthConfigured() {
    return !!(
        process.env.GOOGLE_CLIENT_ID &&
        process.env.GOOGLE_CLIENT_SECRET
    );
}

function normalizeDisplayName(raw, email) {
    const cleaned = String(raw || "")
        .trim()
        .replace(/\s+/g, " ")
        .replace(/[^A-Za-z0-9\s'-]/g, "")
        .slice(0, 32);

    if (cleaned.length >= 2) return cleaned;

    if (email && email.includes("@")) {
        const fallback = email.split("@")[0].split(/[._-]/)[0].slice(0, 32);
        if (fallback.length >= 2) return fallback;
    }

    return "pizza";
}

function pickDisplayName(profile, email) {
    if (profile && profile.name && profile.name.givenName) {
        return profile.name.givenName;
    }
    if (profile && profile.displayName) {
        return String(profile.displayName).trim().split(/\s+/)[0];
    }
    if (email && email.includes("@")) {
        return email.split("@")[0].split(/[._-]/)[0];
    }
    return "pizza";
}

function configureGoogleAuth() {
    if (!isGoogleAuthConfigured()) return false;

    passport.use(
        new GoogleStrategy(
            {
                clientID: process.env.GOOGLE_CLIENT_ID,
                clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                callbackURL: buildCallbackUrl() || "/api/auth/google/callback",
            },
            async (accessToken, refreshToken, profile, done) => {
                try {
                    const googleId = profile && profile.id ? String(profile.id) : null;
                    const email = profile && profile.emails && profile.emails[0]
                        ? String(profile.emails[0].value).toLowerCase()
                        : null;

                    if (!googleId || !email) {
                        return done(new Error("Google did not provide an email address."));
                    }

                    let user = await prisma.user.findFirst({ where: { googleId } });
                    if (!user) {
                        user = await prisma.user.findUnique({ where: { email } });
                    }

                    const now = new Date();

                    const displayName = normalizeDisplayName(pickDisplayName(profile, email), email);
                    const avatarUrl = profile && profile.photos && profile.photos[0]
                        ? String(profile.photos[0].value || "").slice(0, 1024) || null
                        : null;

                    if (user) {
                        if (user.googleId && user.googleId !== googleId) {
                            return done(new Error("Google account already linked to another user."));
                        }

                        const updates = {};
                        if (!user.googleId) updates.googleId = googleId;
                        if (!user.emailVerifiedAt) updates.emailVerifiedAt = now;
                        if (user.displayName !== displayName) updates.displayName = displayName;
                        if (avatarUrl && user.avatarUrl !== avatarUrl) updates.avatarUrl = avatarUrl;
                        if (user.verificationTokenHash || user.verificationTokenExpiresAt) {
                            updates.verificationTokenHash = null;
                            updates.verificationTokenExpiresAt = null;
                        }

                        if (Object.keys(updates).length) {
                            user = await prisma.user.update({
                                where: { id: user.id },
                                data: updates,
                            });
                        }

                        return done(null, user);
                    }

                    const created = await prisma.user.create({
                        data: {
                            email,
                            displayName,
                            username: null,
                            role: "user",
                            googleId,
                            avatarUrl,
                            emailVerifiedAt: now,
                            newsletterOptIn: true,
                        },
                    });

                    return done(null, created);
                } catch (err) {
                    return done(err);
                }
            }
        )
    );

    return true;
}

module.exports = { configureGoogleAuth, isGoogleAuthConfigured, getGoogleCallbackUrl };
