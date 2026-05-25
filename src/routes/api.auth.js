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

// ─── POST /api/auth/avatar — upload + crop the user's profile picture ─────
//
// Multer reads the multipart body into memory (avatars are tiny — 256x256
// jpg lands at ~12-25 KB after sharp). We resize/crop to a 256x256 jpg
// (centred cover), write to public/uploads/avatars/{userId}.jpg, then
// update User.avatarUrl. Atomic write via a temp file + rename so a
// browser fetch mid-upload never sees a half-written image.
const path = require("path");
const fs = require("fs/promises");
const multer = require("multer");
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => {
        // Accept only common image MIME types; sharp will reject the rest anyway.
        if (/^image\/(jpeg|jpg|png|webp|gif|avif)$/i.test(file.mimetype)) cb(null, true);
        else cb(new Error("Unsupported file type. Use JPG, PNG, WebP, GIF, or AVIF."));
    },
});

router.post("/avatar", (req, res, next) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ ok: false, error: "Sign in required" });
    }
    upload.single("avatar")(req, res, (err) => {
        if (err) {
            const msg = err.code === "LIMIT_FILE_SIZE"
                ? "Image is too large. Max 5 MB."
                : err.message || "Upload failed";
            return res.status(400).json({ ok: false, error: msg });
        }
        handleAvatar(req, res).catch(next);
    });
});

async function handleAvatar(req, res) {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
        return res.status(400).json({ ok: false, error: "No file provided" });
    }
    const sharp = require("sharp");
    const userId = req.session.user.id;
    const dir = path.join(process.cwd(), "public", "uploads", "avatars");
    await fs.mkdir(dir, { recursive: true });

    const finalPath = path.join(dir, `${userId}.jpg`);
    const tmpPath = path.join(dir, `${userId}.tmp-${Date.now()}.jpg`);

    try {
        await sharp(req.file.buffer)
            .rotate()                          // honour EXIF orientation
            .resize(256, 256, { fit: "cover", position: "centre" })
            .jpeg({ quality: 82, mozjpeg: true })
            .toFile(tmpPath);
    } catch (err) {
        try { await fs.unlink(tmpPath); } catch (_) {}
        console.error("[avatar] sharp failed:", err && err.message);
        return res.status(400).json({ ok: false, error: "Couldn't process that image." });
    }
    await fs.rename(tmpPath, finalPath);

    // Cache-bust the URL so the live page picks up the new image without
    // a hard refresh. Append a t=<ms> query — the static handler ignores
    // unknown query params, browsers treat it as a fresh resource.
    const avatarUrl = `/uploads/avatars/${userId}.jpg?t=${Date.now()}`;

    const updated = await prisma.user.update({
        where: { id: userId },
        data: { avatarUrl },
        select: { id: true, email: true, displayName: true, username: true, role: true, avatarUrl: true },
    });
    req.session.user = {
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName,
        username: updated.username,
        role: updated.role,
        avatarUrl: updated.avatarUrl,
    };
    return res.json({ ok: true, avatarUrl: updated.avatarUrl });
}

// ─── PATCH /api/auth/profile — edit displayName + newsletter opt-in ──
//
// Settings page sends a partial body. Both fields are optional; only
// supplied keys are written. Returns the updated user shape so the
// client can refresh the session-derived UI without a full reload.
router.patch("/profile", async (req, res) => {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ ok: false, error: "Sign in required" });
        }
        const schema = z.object({
            displayName: z.string().trim().min(1, "Name is required").max(60).optional(),
            newsletterOptIn: z.boolean().optional(),
        });
        const parsed = schema.safeParse(req.body || {});
        if (!parsed.success) return res.status(400).json({ ok: false, error: parsed.error.flatten() });
        const data = parsed.data;
        if (Object.keys(data).length === 0) {
            return res.status(400).json({ ok: false, error: "Nothing to update" });
        }
        const updated = await prisma.user.update({
            where: { id: req.session.user.id },
            data,
            select: { id: true, email: true, displayName: true, username: true, role: true, avatarUrl: true, newsletterOptIn: true },
        });
        req.session.user = {
            id: updated.id,
            email: updated.email,
            displayName: updated.displayName,
            username: updated.username,
            role: updated.role,
            avatarUrl: updated.avatarUrl,
        };
        return res.json({ ok: true, user: updated });
    } catch (err) {
        console.error("Profile patch failed:", err);
        return res.status(500).json({ ok: false, error: "Update failed" });
    }
});

// ─── DELETE /api/auth/account — permanently remove the account ──────
//
// Cascade rules (per prisma/schema.prisma):
//   Visit / Favorite / Review → onDelete: Cascade (handled by FK)
//   Submission.userId is NOT NULL — wipe the user's own submissions
//   Submission.reviewedByUserId is nullable — null it out so moderation
//     history survives without the dangling reference
//
// Required body: { confirm: "<current username or email>" } — the client
// asks the user to type their handle. Belt-and-braces against accidental
// double-clicks on the danger button.
router.delete("/account", async (req, res) => {
    try {
        if (!req.session || !req.session.user) {
            return res.status(401).json({ ok: false, error: "Sign in required" });
        }
        const userId = req.session.user.id;
        const me = await prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, username: true, email: true },
        });
        if (!me) return res.status(404).json({ ok: false, error: "Account not found" });

        const expected = me.username || me.email;
        const supplied = String((req.body && req.body.confirm) || "").trim();
        if (!supplied || supplied.toLowerCase() !== expected.toLowerCase()) {
            return res.status(400).json({ ok: false, error: "Confirmation does not match" });
        }

        await prisma.$transaction([
            prisma.submission.updateMany({
                where: { reviewedByUserId: userId },
                data: { reviewedByUserId: null },
            }),
            prisma.submission.deleteMany({ where: { userId } }),
            prisma.user.delete({ where: { id: userId } }),
        ]);

        // Best-effort avatar cleanup — failures here shouldn't block account deletion.
        try {
            const avatarPath = path.join(process.cwd(), "public", "uploads", "avatars", `${userId}.jpg`);
            await fs.unlink(avatarPath);
        } catch (_) { /* file may not exist */ }

        req.session.destroy(() => {
            res.json({ ok: true });
        });
    } catch (err) {
        console.error("Account delete failed:", err);
        return res.status(500).json({ ok: false, error: "Delete failed" });
    }
});

module.exports = router;
