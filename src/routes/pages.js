const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { prisma } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { buildSitemapXml, writeSitemapFiles } = require("../services/sitemap");
const { isGoogleAuthConfigured } = require("../services/googleAuth");

const router = express.Router();

router.get("/", (req, res) => res.render("maintenance"));

router.get("/map", (req, res) => {
    res.render("map", { user: req.session.user || null });
});

router.get("/place/:id", async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({
        where: { id },
        include: {
            cityRef: true,
            faqs: {
                where: { isVisible: true, scope: "place" },
                orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
            },
        },
    });
    if (!place || place.isVisible === false) return res.status(404).send("Not found");
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

router.get("/auth", (req, res) => {
    if (req.session.user) return res.redirect("/me");
    res.render("auth", { user: null, googleAuthEnabled: isGoogleAuthConfigured() });
});

router.get(["/login", "/register", "/forgot", "/reset", "/set-password"], (req, res) => {
    res.redirect("/auth");
});

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
            message: "Missing sign-in token. Please open the link from your email.",
        });
    }

    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const user = await prisma.user.findFirst({ where: { verificationTokenHash: tokenHash } });
    if (!user) {
        return res.render("verify", {
            user: req.session.user || null,
            status: "error",
            message: "That sign-in link is invalid or has already been used.",
        });
    }

    if (user.verificationTokenExpiresAt && user.verificationTokenExpiresAt < new Date()) {
        return res.render("verify", {
            user: req.session.user || null,
            status: "error",
            message: "That sign-in link has expired. Please request a new one.",
        });
    }

    await prisma.user.update({
        where: { id: user.id },
        data: {
            emailVerifiedAt: user.emailVerifiedAt || new Date(),
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

    if (!user.username) {
        return res.redirect("/set-username");
    }
    return res.redirect("/me");
});
router.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/")));

router.get("/about", async (req, res) => {
    const page = await prisma.page.findUnique({ where: { key: "about" } });
    if (!page || !page.isVisible) return res.status(404).send("Not found");
    res.render("about", { user: req.session.user || null, page });
});

router.get("/faq", async (req, res) => {
    const faqs = await prisma.faq.findMany({
        where: { scope: "global", isVisible: true },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 500,
    });
    const intro = await prisma.page.findUnique({ where: { key: "faq" } });
    res.render("faq", { user: req.session.user || null, faqs, introHtml: intro && intro.isVisible ? intro.bodyHtml : "" });
});

router.get("/country/:code", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const country = await prisma.country.findUnique({ where: { code } });
    if (!country || !country.isVisible) return res.status(404).send("Not found");

    const cities = await prisma.city.findMany({
        where: { countryCode: code, isVisible: true },
        orderBy: [{ name: "asc" }],
        take: 1000,
    });
    const ids = cities.map((c) => c.id);
    const placeCounts = ids.length
        ? await prisma.place.groupBy({
            by: ["cityId"],
            where: { cityId: { in: ids }, status: "active", isVisible: true },
            _count: { _all: true },
        })
        : [];
    const countMap = new Map(placeCounts.map((r) => [r.cityId, r._count._all]));

    const faqs = await prisma.faq.findMany({
        where: { scope: "country", isVisible: true, countryCode: code },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 200,
    });

    res.render("country", {
        user: req.session.user || null,
        country,
        cities: cities.map((c) => ({ ...c, placeCount: countMap.get(c.id) || 0 })),
        faqs,
    });
});

router.get("/country/:code/city/:slug", async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const city = await prisma.city.findUnique({
        where: { countryCode_slug: { countryCode: code, slug } },
    });
    if (!city || !city.isVisible) return res.status(404).send("Not found");

    const places = await prisma.place.findMany({
        where: {
            status: "active",
            isVisible: true,
            country: code,
            OR: [{ cityId: city.id }, { cityId: null, city: city.name }],
        },
        orderBy: { updatedAt: "desc" },
        take: 500,
    });

    const faqs = await prisma.faq.findMany({
        where: { scope: "city", isVisible: true, cityId: city.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 200,
    });

    res.render("city", { user: req.session.user || null, city, places, faqs });
});

router.get("/place/:id/suggest-edit", requireAuth, async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id } });
    if (!place || place.isVisible === false) return res.status(404).send("Not found");
    res.render("suggest_edit", { user: req.session.user, place });
});

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

// --------------------
// Admin CMS (EJS)
// --------------------

router.get("/admin/pages", requireAdmin, async (req, res) => {
    const pages = await prisma.page.findMany({
        orderBy: { key: "asc" },
    });
    res.render("admin_pages", { user: req.session.user, pages });
});

router.get("/admin/pages/new", requireAdmin, (req, res) => {
    const key = typeof req.query.key === "string" ? req.query.key.trim() : "";
    if (!key) return res.redirect("/admin/pages");
    res.redirect(`/admin/pages/${encodeURIComponent(key)}`);
});

router.get("/admin/pages/:key", requireAdmin, async (req, res) => {
    const key = String(req.params.key || "").trim();
    const existing = await prisma.page.findUnique({ where: { key } });
    const page = existing || { key, title: "", bodyHtml: "", isVisible: false };
    res.render("admin_page_edit", { user: req.session.user, page });
});

router.post("/admin/pages/:key", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const key = String(req.params.key || "").trim();
    const title = String(req.body.title || "").trim().slice(0, 120);
    const bodyHtml = sanitizeRichText(String(req.body.bodyHtml || ""));
    const isVisible = !!req.body.isVisible;
    if (!key) return res.redirect("/admin/pages");

    await prisma.page.upsert({
        where: { key },
        update: { title, bodyHtml, isVisible },
        create: { key, title, bodyHtml, isVisible },
    });
    res.redirect(`/admin/pages/${encodeURIComponent(key)}`);
});

router.get("/admin/faqs", requireAdmin, async (req, res) => {
    const scope = typeof req.query.scope === "string" ? req.query.scope : "global";
    const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode.trim().toUpperCase() : "";
    const cityId = typeof req.query.cityId === "string" ? Number(req.query.cityId) : null;
    const placeId = typeof req.query.placeId === "string" ? Number(req.query.placeId) : null;

    const where = { scope };
    if (countryCode) where.countryCode = countryCode;
    if (Number.isFinite(cityId) && cityId) where.cityId = cityId;
    if (Number.isFinite(placeId) && placeId) where.placeId = placeId;

    const faqs = await prisma.faq.findMany({
        where,
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 500,
    });

    res.render("admin_faqs", {
        user: req.session.user,
        faqs,
        filters: {
            scope,
            countryCode,
            cityId: Number.isFinite(cityId) && cityId ? String(cityId) : "",
            placeId: Number.isFinite(placeId) && placeId ? String(placeId) : "",
        },
    });
});

router.get("/admin/faqs/new", requireAdmin, async (req, res) => {
    const scope = typeof req.query.scope === "string" ? req.query.scope : "global";
    const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode.trim().toUpperCase() : "";
    const cityId = typeof req.query.cityId === "string" ? Number(req.query.cityId) : null;
    const placeId = typeof req.query.placeId === "string" ? Number(req.query.placeId) : null;
    const faq = {
        id: null,
        scope,
        countryCode: countryCode || null,
        cityId: Number.isFinite(cityId) && cityId ? cityId : null,
        placeId: Number.isFinite(placeId) && placeId ? placeId : null,
        question: "",
        answerHtml: "",
        sortOrder: 0,
        isVisible: false,
    };
    res.render("admin_faq_edit", { user: req.session.user, faq });
});

router.post("/admin/faqs", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const scope = String(req.body.scope || "global");
    const countryCode = String(req.body.countryCode || "").trim().toUpperCase();
    const cityId = req.body.cityId ? Number(req.body.cityId) : null;
    const placeId = req.body.placeId ? Number(req.body.placeId) : null;
    const question = String(req.body.question || "").trim().slice(0, 200);
    const answerHtml = sanitizeRichText(String(req.body.answerHtml || ""));
    const sortOrder = Number(req.body.sortOrder || 0);
    const isVisible = !!req.body.isVisible;

    const faq = await prisma.faq.create({
        data: {
            scope,
            countryCode: countryCode || null,
            cityId: Number.isFinite(cityId) ? cityId : null,
            placeId: Number.isFinite(placeId) ? placeId : null,
            question,
            answerHtml,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
            isVisible,
        },
    });

    res.redirect(`/admin/faqs/${faq.id}`);
});

router.get("/admin/faqs/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const faq = await prisma.faq.findUnique({ where: { id } });
    if (!faq) return res.redirect("/admin/faqs");
    res.render("admin_faq_edit", { user: req.session.user, faq });
});

router.post("/admin/faqs/:id", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const id = Number(req.params.id);
    const scope = String(req.body.scope || "global");
    const countryCode = String(req.body.countryCode || "").trim().toUpperCase();
    const cityId = req.body.cityId ? Number(req.body.cityId) : null;
    const placeId = req.body.placeId ? Number(req.body.placeId) : null;
    const question = String(req.body.question || "").trim().slice(0, 200);
    const answerHtml = sanitizeRichText(String(req.body.answerHtml || ""));
    const sortOrder = Number(req.body.sortOrder || 0);
    const isVisible = !!req.body.isVisible;

    await prisma.faq.update({
        where: { id },
        data: {
            scope,
            countryCode: countryCode || null,
            cityId: Number.isFinite(cityId) ? cityId : null,
            placeId: Number.isFinite(placeId) ? placeId : null,
            question,
            answerHtml,
            sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
            isVisible,
        },
    });

    res.redirect(`/admin/faqs/${id}`);
});

router.post("/admin/faqs/:id/delete", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    await prisma.faq.delete({ where: { id } });
    res.redirect("/admin/faqs");
});

router.get("/admin/countries", requireAdmin, async (req, res) => {
    const countries = await prisma.country.findMany({ orderBy: { code: "asc" } });
    const codes = countries.map((c) => c.code);
    const cityCounts = await prisma.city.groupBy({
        by: ["countryCode"],
        where: { countryCode: { in: codes }, isVisible: true },
        _count: { _all: true },
    });
    const countMap = new Map(cityCounts.map((r) => [r.countryCode, r._count._all]));
    res.render("admin_countries", {
        user: req.session.user,
        countries: countries.map((c) => ({ ...c, visibleCities: countMap.get(c.code) || 0 })),
    });
});

router.post("/admin/countries/upsert", requireAdmin, async (req, res) => {
    const code = String(req.body.code || "").trim().toUpperCase().slice(0, 2);
    const name = String(req.body.name || "").trim().slice(0, 120);
    if (!code || code.length !== 2) return res.redirect("/admin/countries");
    await prisma.country.upsert({
        where: { code },
        update: { name: name || null },
        create: { code, name: name || null, isVisible: false },
    });
    res.redirect(`/admin/countries/${encodeURIComponent(code)}`);
});

router.get("/admin/countries/:code", requireAdmin, async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const country = await prisma.country.findUnique({ where: { code } });
    if (!country) return res.redirect("/admin/countries");
    res.render("admin_country_edit", { user: req.session.user, country });
});

router.post("/admin/countries/:code", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const code = String(req.params.code || "").trim().toUpperCase();
    const name = String(req.body.name || "").trim().slice(0, 120);
    const heroImageUrl = String(req.body.heroImageUrl || "").trim();
    const isVisible = !!req.body.isVisible;
    const introHtml = sanitizeRichText(String(req.body.introHtml || ""));
    await prisma.country.update({
        where: { code },
        data: {
            name: name || null,
            heroImageUrl: heroImageUrl || null,
            introHtml: introHtml || null,
            isVisible,
        },
    });
    res.redirect(`/admin/countries/${encodeURIComponent(code)}`);
});

router.post("/admin/countries/:code/toggle-visible", requireAdmin, async (req, res) => {
    const code = String(req.params.code || "").trim().toUpperCase();
    const country = await prisma.country.findUnique({ where: { code } });
    if (!country) return res.redirect("/admin/countries");
    await prisma.country.update({ where: { code }, data: { isVisible: !country.isVisible } });
    res.redirect("/admin/countries");
});

router.get("/admin/cities", requireAdmin, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const countryCode = typeof req.query.countryCode === "string" ? req.query.countryCode.trim().toUpperCase() : "";

    const where = {};
    if (q) where.name = { contains: q };
    if (countryCode) where.countryCode = countryCode;

    const cities = await prisma.city.findMany({
        where,
        orderBy: [{ countryCode: "asc" }, { name: "asc" }],
        take: 500,
    });

    const ids = cities.map((c) => c.id);
    const placeCounts = await prisma.place.groupBy({
        by: ["cityId"],
        where: { cityId: { in: ids }, status: "active", isVisible: true },
        _count: { _all: true },
    });
    const countMap = new Map(placeCounts.map((r) => [r.cityId, r._count._all]));

    res.render("admin_cities", {
        user: req.session.user,
        cities: cities.map((c) => ({ ...c, placeCount: countMap.get(c.id) || 0 })),
        filters: { q, countryCode },
    });
});

router.get("/admin/cities/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const city = await prisma.city.findUnique({ where: { id } });
    if (!city) return res.redirect("/admin/cities");
    res.render("admin_city_edit", { user: req.session.user, city });
});

router.post("/admin/cities/:id", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const id = Number(req.params.id);
    const name = String(req.body.name || "").trim().slice(0, 120);
    const slug = String(req.body.slug || "").trim().slice(0, 120);
    const heroImageUrl = String(req.body.heroImageUrl || "").trim();
    const isVisible = !!req.body.isVisible;
    const introHtml = sanitizeRichText(String(req.body.introHtml || ""));
    await prisma.city.update({
        where: { id },
        data: {
            name,
            slug,
            heroImageUrl: heroImageUrl || null,
            introHtml: introHtml || null,
            isVisible,
        },
    });
    res.redirect(`/admin/cities/${id}`);
});

router.post("/admin/cities/:id/toggle-visible", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const city = await prisma.city.findUnique({ where: { id } });
    if (!city) return res.redirect("/admin/cities");
    await prisma.city.update({ where: { id }, data: { isVisible: !city.isVisible } });
    res.redirect("/admin/cities");
});

router.get("/admin/places", requireAdmin, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const cityId = typeof req.query.cityId === "string" ? Number(req.query.cityId) : null;

    const where = {};
    if (q) where.name = { contains: q };
    if (Number.isFinite(cityId) && cityId) where.cityId = cityId;

    const places = await prisma.place.findMany({
        where,
        orderBy: { updatedAt: "desc" },
        take: 200,
    });

    res.render("admin_places", {
        user: req.session.user,
        places,
        filters: {
            q,
            cityId: Number.isFinite(cityId) && cityId ? String(cityId) : "",
        },
    });
});

router.get("/admin/places/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id } });
    if (!place) return res.redirect("/admin/places");
    res.render("admin_place_edit", { user: req.session.user, place });
});

router.post("/admin/places/:id", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const id = Number(req.params.id);
    const slug = String(req.body.slug || "").trim().slice(0, 191);
    const heroImageUrl = String(req.body.heroImageUrl || "").trim();
    const isVisible = !!req.body.isVisible;
    const descriptionHtml = sanitizeRichText(String(req.body.descriptionHtml || ""));

    await prisma.place.update({
        where: { id },
        data: {
            slug: slug || null,
            heroImageUrl: heroImageUrl || null,
            descriptionHtml: descriptionHtml || null,
            isVisible,
        },
    });

    // Ensure city/country/thresholds are up to date after manual edits.
    try {
        const { ensureCityCountryAfterPlaceApproved } = require("../services/landingAutoCreate");
        const updated = await prisma.place.findUnique({ where: { id } });
        await ensureCityCountryAfterPlaceApproved(updated);
    } catch (err) {
        console.error("Auto city/country ensure failed:", err && err.message ? err.message : err);
    }

    res.redirect(`/admin/places/${id}`);
});

router.post("/admin/places/:id/toggle-visible", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({ where: { id } });
    if (!place) return res.redirect("/admin/places");
    await prisma.place.update({ where: { id }, data: { isVisible: !place.isVisible } });
    res.redirect("/admin/places");
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
    const { approveSubmission } = require("../services/submissions");
    try {
        await approveSubmission({ submissionId: id, reviewerId: req.session.user.id });
    } catch (err) {
        console.error("Approve submission failed:", err && err.message ? err.message : err);
    }
    res.redirect("/admin/submissions");
});

router.post("/admin/submissions/:id/reject", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const reason = (req.body.reason || "Rejected").slice(0, 200);
    const { rejectSubmission } = require("../services/submissions");
    try {
        await rejectSubmission({ submissionId: id, reviewerId: req.session.user.id, reason });
    } catch (err) {
        console.error("Reject submission failed:", err && err.message ? err.message : err);
    }
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
