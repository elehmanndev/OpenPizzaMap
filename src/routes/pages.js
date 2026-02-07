const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { prisma } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { sendWelcomeEmail } = require("../services/email");
const { buildSitemapXml, writeSitemapFiles } = require("../services/sitemap");
const { isGoogleAuthConfigured } = require("../services/googleAuth");

const router = express.Router();

router.get("/", (req, res) => res.render("maintenance"));

router.get("/map", (req, res) => {
    res.render("map", { user: req.session.user || null });
});

router.get("/place/:id", async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id } });
    if (!place) return res.status(404).send("Not found");
    res.render("place", { user: req.session.user || null, place });
});

router.get("/add", requireAuth, (req, res) => {
    res.render("add", { user: req.session.user });
});

router.post("/add", requireAuth, async (req, res) => {
    // form posts into submissions endpoint logic (server-side)
    const payload = {
        name: req.body.name,
        addressLine: req.body.addressLine,
        city: req.body.city,
        region: req.body.region || null,
        postalCode: req.body.postalCode || null,
        country: req.body.country || "ES",
        lat: req.body.lat,
        lng: req.body.lng,
        priceLevel: Number(req.body.priceLevel || 2),
        stylesJson: JSON.stringify((req.body.styles || "").split(",").map(s => s.trim()).filter(Boolean)),
        dineIn: !!req.body.dineIn,
        takeaway: !!req.body.takeaway,
        delivery: !!req.body.delivery,
        websiteUrl: req.body.websiteUrl || null,
        googleMapsUrl: req.body.googleMapsUrl || null,
        instagramUrl: req.body.instagramUrl || null,
        status: "active",
    };

    await prisma.submission.create({
        data: {
            userId: req.session.user.id,
            type: "new_place",
            payloadJson: JSON.stringify(payload),
        },
    });

    res.redirect("/me");
});

router.get("/register", (req, res) =>
    res.render("register", { user: req.session.user || null, googleAuthEnabled: isGoogleAuthConfigured() })
);
router.get("/login", (req, res) =>
    res.render("login", { user: req.session.user || null, googleAuthEnabled: isGoogleAuthConfigured() })
);
router.get("/set-username", requireAuth, async (req, res) => {
    const existing = await prisma.user.findUnique({
        where: { id: req.session.user.id },
        select: { username: true },
    });
    if (existing && existing.username) {
        return res.redirect("/me");
    }
    res.render("set_username", { user: req.session.user || null });
});
router.get("/forgot", (req, res) => res.render("forgot", { user: req.session.user || null }));
router.get("/set-password", async (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : "";
    let needsUsername = false;
    if (email) {
        const existing = await prisma.user.findUnique({
            where: { email },
            select: { username: true },
        });
        needsUsername = !!existing && !existing.username;
    }
    res.render("set_password", { user: req.session.user || null, email, needsUsername });
});
router.get("/reset", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    res.render("reset", { user: req.session.user || null, token });
});
router.get("/check-email", (req, res) => {
    const email = typeof req.query.email === "string" ? req.query.email : null;
    res.render("check_email", { user: req.session.user || null, email });
});
router.get("/verify", async (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
        return res.render("verify", {
            user: req.session.user || null,
            status: "error",
            message: "Missing verification token. Please open the link from your email.",
        });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await prisma.user.findFirst({ where: { verificationTokenHash: tokenHash } });
    if (!user) {
        return res.render("verify", {
            user: req.session.user || null,
            status: "error",
            message: "That verification link is invalid or has already been used.",
        });
    }

    if (user.emailVerifiedAt) {
        req.session.user = {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            username: user.username,
            role: user.role,
        };
        return res.render("verify", {
            user: req.session.user || null,
            status: "success",
            message: "You're already verified. Let's get you in.",
        });
    }

    if (user.verificationTokenExpiresAt && user.verificationTokenExpiresAt < new Date()) {
        return res.render("verify", {
            user: req.session.user || null,
            status: "error",
            message: "That verification link has expired. Please register again.",
        });
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            emailVerifiedAt: new Date(),
            verificationTokenHash: null,
            verificationTokenExpiresAt: null,
        },
    });

    req.session.user = {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        username: user.username,
        role: user.role,
    };

    try {
        await sendWelcomeEmail({ to: user.email });
    } catch (err) {
        console.error("Welcome email failed:", err);
    }

    res.render("verify", {
        user: req.session.user || null,
        status: "success",
        message: "Your email is verified! Welcome to OpenPizzaMap.",
    });
});
router.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

router.get("/terms", (req, res) => {
    res.render("terms", { user: req.session.user || null });
});

router.get("/privacy", (req, res) => {
    res.render("privacy", { user: req.session.user || null });
});

router.get("/me", requireAuth, async (req, res) => {
    const subs = await prisma.submission.findMany({
        where: { userId: req.session.user.id },
        orderBy: { createdAt: "desc" },
        take: 100,
    });
    res.render("me", { user: req.session.user, submissions: subs });
});

router.get("/favourites", requireAuth, (req, res) => {
    res.render("favourites", { user: req.session.user });
});

router.get("/admin/submissions", requireAdmin, async (req, res) => {
    const subs = await prisma.submission.findMany({
        where: { status: "pending" },
        orderBy: { createdAt: "desc" },
        take: 200,
    });
    res.render("admin_submissions", { user: req.session.user, submissions: subs });
});

router.post("/admin/submissions/:id/approve", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const sub = await prisma.submission.findUnique({ where: { id } });
    if (!sub || sub.status !== "pending") return res.redirect("/admin/submissions");

    const payload = JSON.parse(sub.payloadJson);
    await prisma.place.create({ data: payload });

    await prisma.submission.update({
        where: { id },
        data: { status: "approved", reviewedAt: new Date(), reviewedByUserId: req.session.user.id },
    });

    try {
        const xml = await buildSitemapXml(prisma);
        writeSitemapFiles(xml);
    } catch (err) {
        console.error("Sitemap update failed:", err);
    }

    res.redirect("/admin/submissions");
});

router.post("/admin/submissions/:id/reject", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const reason = (req.body.reason || "Rejected").slice(0, 200);

    await prisma.submission.update({
        where: { id },
        data: { status: "rejected", rejectionReason: reason, reviewedAt: new Date(), reviewedByUserId: req.session.user.id },
    });

    res.redirect("/admin/submissions");
});

router.post("/admin/sitemap/rebuild", requireAdmin, async (req, res) => {
    try {
        const xml = await buildSitemapXml(prisma);
        writeSitemapFiles(xml);
        return res.json({ ok: true });
    } catch (err) {
        console.error("Sitemap rebuild failed:", err);
        return res.status(500).json({ ok: false, error: "Failed to rebuild sitemap" });
    }
});

router.get("/sitemap.xml", async (req, res) => {
    const sitemapPath = path.join(process.cwd(), "public", "sitemap.xml");
    if (fs.existsSync(sitemapPath)) {
        res.header("Content-Type", "application/xml");
        return res.send(fs.readFileSync(sitemapPath, "utf8"));
    }
    const xml = await buildSitemapXml(prisma);
    writeSitemapFiles(xml);
    res.header("Content-Type", "application/xml");
    return res.send(xml);
});

router.get("/sitemap", async (req, res) => {
    const sitemapPath = path.join(process.cwd(), "public", "sitemap.xml");
    if (fs.existsSync(sitemapPath)) {
        res.header("Content-Type", "application/xml");
        return res.send(fs.readFileSync(sitemapPath, "utf8"));
    }
    const xml = await buildSitemapXml(prisma);
    writeSitemapFiles(xml);
    res.header("Content-Type", "application/xml");
    return res.send(xml);
});

router.get("/robots.txt", (req, res) => {
    const baseUrl = process.env.BASE_URL || "https://openpizzamap.com";
    const body = [
        "User-agent: *",
        "Allow: /",
        `Sitemap: ${baseUrl}/sitemap.xml`,
    ].join("\n");
    res.header("Content-Type", "text/plain");
    res.send(body);
});

module.exports = router;
