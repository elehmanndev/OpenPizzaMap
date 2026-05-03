const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const fsPromises = require("fs/promises");
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
            styles: {
                include: { style: true },
                orderBy: { style: { sortOrder: "asc" } },
            },
        },
    });
    if (!place || place.isVisible === false) return res.status(404).send("Not found");

    const userId = req.session?.user?.id || null;
    // Server-side render the first page of reviews so the section paints
    // immediately. Client paginates from /api/places/:id/reviews after.
    const REVIEW_PAGE_SIZE = 10;
    const [visitCount, reviewsTotal, reviewsFirstPage] = await Promise.all([
        prisma.visit.count({ where: { placeId: id } }),
        prisma.review.count({ where: { placeId: id, isVisible: true } }),
        prisma.review.findMany({
            where: { placeId: id, isVisible: true },
            orderBy: { createdAt: "desc" },
            take: REVIEW_PAGE_SIZE,
            include: { user: { select: { username: true, displayName: true } } },
        }),
    ]);
    let viewerVisited = false;
    let viewerFavorited = false;
    let viewerReview = null;
    if (userId) {
        const [v, f, r] = await Promise.all([
            prisma.visit.findUnique({ where: { userId_placeId: { userId, placeId: id } }, select: { id: true } }),
            prisma.favorite.findUnique({ where: { userId_placeId: { userId, placeId: id } }, select: { id: true } }),
            prisma.review.findUnique({
                where: { placeId_userId: { placeId: id, userId } },
                select: { id: true, pizza: true, local: true, servicio: true, precio: true, comment: true },
            }),
        ]);
        viewerVisited = !!v;
        viewerFavorited = !!f;
        viewerReview = r;
    }
    place.visitCount = visitCount;
    place.viewerVisited = viewerVisited;
    place.viewerFavorited = viewerFavorited;
    place.reviewsTotal = reviewsTotal;
    place.reviewsFirstPage = reviewsFirstPage.map((row) => ({
        id: row.id,
        pizza: row.pizza,
        local: row.local,
        servicio: row.servicio,
        precio: row.precio,
        comment: row.comment,
        createdAt: row.createdAt,
        userName: row.user
            ? (row.user.username || row.user.displayName || "user")
            : "user",
    }));
    place.viewerReview = viewerReview;
    place.reviewPageSize = REVIEW_PAGE_SIZE;

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

router.get("/styles", async (req, res) => {
    const styles = await prisma.style.findMany({
        where: { isVisible: true },
        orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    });
    const counts = await prisma.placeStyle.groupBy({
        by: ["styleId"],
        _count: { _all: true },
    });
    const countMap = new Map(counts.map((r) => [r.styleId, r._count._all]));
    res.render("styles", {
        user: req.session.user || null,
        styles: styles.map((s) => ({ ...s, placeCount: countMap.get(s.id) || 0 })),
    });
});

router.get("/style/:slug", async (req, res) => {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const style = await prisma.style.findUnique({ where: { slug } });
    if (!style || !style.isVisible) return res.status(404).send("Not found");

    const places = await prisma.place.findMany({
        where: {
            status: "active",
            isVisible: true,
            styles: { some: { styleId: style.id } },
        },
        orderBy: [{ city: "asc" }, { name: "asc" }],
        take: 1000,
    });

    res.render("style", { user: req.session.user || null, style, places });
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

router.get("/favourites", requireAuth, async (req, res) => {
    const userId = req.session.user.id;
    const favs = await prisma.favorite.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: {
            place: {
                include: { styles: { include: { style: true }, orderBy: { style: { sortOrder: "asc" } } } },
            },
        },
    });
    const places = favs
        .filter((f) => f.place && f.place.isVisible !== false)
        .map((f) => f.place);
    res.render("favourites", { user: req.session.user, places });
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
    const country = typeof req.query.country === "string" ? req.query.country.trim() : "";
    const vis = req.query.vis; // "visible" | "hidden" | undefined
    const styleId = typeof req.query.styleId === "string" ? Number(req.query.styleId) : null;
    const needs = typeof req.query.needs === "string" ? req.query.needs : "";

    const where = {};
    if (q) where.name = { contains: q };
    if (country) where.country = { contains: country };
    if (vis === "visible") where.isVisible = true;
    if (vis === "hidden") where.isVisible = false;
    if (Number.isFinite(styleId) && styleId) where.styles = { some: { styleId } };
    if (needs === "no-style") where.styles = { none: {} };
    if (needs === "no-hero") where.heroImageUrl = null;
    if (needs === "no-phone") where.phone = null;
    if (needs === "no-website") where.websiteUrl = null;
    if (needs === "no-hours") where.openingHours = null;

    const [places, allStyles] = await Promise.all([
        prisma.place.findMany({
            where,
            orderBy: { id: "desc" },
            take: 300,
            select: {
                id: true, name: true, city: true, country: true,
                isVisible: true, heroImageUrl: true, phone: true,
                websiteUrl: true, openingHours: true,
                styles: { select: { style: { select: { name: true } } } },
            },
        }),
        prisma.style.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
    ]);

    res.render("admin_places", {
        user: req.session.user,
        places,
        allStyles,
        filters: { q, country, vis: vis || "", styleId: styleId || "", needs },
    });
});

router.post("/admin/places/bulk-style", requireAdmin, async (req, res) => {
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
    const ids = rawIds.map(Number).filter(n => Number.isFinite(n) && n > 0);
    const styleId = Number(req.body.styleId);
    const back = req.headers.referer || "/admin/places";

    if (!ids.length || !Number.isFinite(styleId)) return res.redirect(back);
    const style = await prisma.style.findUnique({ where: { id: styleId } });
    if (!style) return res.redirect(back);

    await prisma.placeStyle.createMany({
        data: ids.map(placeId => ({ placeId, styleId })),
        skipDuplicates: true,
    });

    for (const placeId of ids) {
        const place = await prisma.place.findUnique({
            where: { id: placeId },
            include: { styles: { include: { style: true } } },
        });
        if (!place) continue;
        await prisma.place.update({
            where: { id: placeId },
            data: { stylesJson: JSON.stringify(place.styles.map(s => s.style.slug)) },
        });
    }

    res.redirect(back);
});

router.get("/admin/places/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const place = await prisma.place.findUnique({
        where: { id },
        include: { styles: { select: { styleId: true } } },
    });
    if (!place) return res.redirect("/admin/places");
    const allStyles = await prisma.style.findMany({ orderBy: { sortOrder: "asc" } });
    const selectedStyleIds = new Set(place.styles.map((s) => s.styleId));
    res.render("admin_place_edit", {
        user: req.session.user,
        place,
        allStyles,
        selectedStyleIds,
    });
});

router.post("/admin/places/:id", requireAdmin, async (req, res) => {
    const { sanitizeRichText } = require("../services/sanitize");
    const id = Number(req.params.id);
    const b = req.body || {};

    function s(v, max) {
        const x = String(v == null ? "" : v).trim();
        return max ? x.slice(0, max) : x;
    }
    function nullable(v, max) { const x = s(v, max); return x ? x : null; }

    const name = s(b.name, 191);
    const addressLine = s(b.addressLine, 191);
    const city = s(b.city, 191);
    const country = s(b.country, 191);

    const priceLevelNum = Number(b.priceLevel);
    const priceLevel = Number.isFinite(priceLevelNum) ? Math.min(4, Math.max(0, Math.trunc(priceLevelNum))) : 2;

    const latRaw = s(b.lat);
    const lngRaw = s(b.lng);
    const lat = latRaw === "" ? null : Number(latRaw);
    const lng = lngRaw === "" ? null : Number(lngRaw);

    const data = {
        name: name || undefined,
        addressLine: addressLine || undefined,
        city: city || undefined,
        region: nullable(b.region, 191),
        postalCode: nullable(b.postalCode, 40),
        country: country || undefined,
        priceLevel,
        dineIn: !!b.dineIn,
        takeaway: !!b.takeaway,
        delivery: !!b.delivery,
        reservations: !!b.reservations,
        outdoorSeating: !!b.outdoorSeating,
        phone: nullable(b.phone, 60),
        websiteUrl: nullable(b.websiteUrl, 500),
        googleMapsUrl: nullable(b.googleMapsUrl, 500),
        instagramUrl: nullable(b.instagramUrl, 500),
        openingHours: nullable(b.openingHours),
        slug: nullable(b.slug, 191),
        heroImageUrl: nullable(b.heroImageUrl, 500),
        seoTitle: nullable(b.seoTitle, 191),
        seoDescription: nullable(b.seoDescription, 200),
        descriptionHtml: sanitizeRichText(String(b.descriptionHtml || "")) || null,
        isVisible: !!b.isVisible,
    };
    if (Number.isFinite(lat)) data.lat = lat;
    if (Number.isFinite(lng)) data.lng = lng;

    // OPM rating: optional manual override. Blank clears it.
    const opmRaw = s(b.opmRating);
    if (opmRaw === "") {
        data.opmRating = null;
    } else {
        const opm = Number(opmRaw);
        if (Number.isFinite(opm)) data.opmRating = Math.min(10, Math.max(1, Math.round(opm * 10) / 10));
    }

    // Styles: replace PlaceStyle joins, mirror to legacy stylesJson.
    const rawStyleIds = Array.isArray(b.styleIds) ? b.styleIds : (b.styleIds ? [b.styleIds] : []);
    const styleIds = rawStyleIds.map(Number).filter((n) => Number.isFinite(n));
    if (styleIds.length) {
        const styles = await prisma.style.findMany({ where: { id: { in: styleIds } }, select: { slug: true } });
        data.stylesJson = JSON.stringify(styles.map((s) => s.slug));
    } else {
        data.stylesJson = "[]";
    }

    await prisma.$transaction([
        prisma.place.update({ where: { id }, data }),
        prisma.placeStyle.deleteMany({ where: { placeId: id } }),
        ...(styleIds.length ? [prisma.placeStyle.createMany({ data: styleIds.map((sid) => ({ placeId: id, styleId: sid })) })] : []),
    ]);

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

// --- Styles CMS ---
router.get("/admin/styles", requireAdmin, async (req, res) => {
    const styles = await prisma.style.findMany({
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { places: true } } },
    });
    res.render("admin_styles", { user: req.session.user, styles });
});

router.get("/admin/styles/new", requireAdmin, (req, res) => {
    res.render("admin_style_edit", { user: req.session.user, style: null });
});

router.post("/admin/styles", requireAdmin, async (req, res) => {
    const b = req.body || {};
    function s(v, max) { const x = String(v == null ? "" : v).trim(); return max ? x.slice(0, max) : x; }
    function nullable(v, max) { const x = s(v, max); return x || null; }
    await prisma.style.create({
        data: {
            slug: s(b.slug, 40),
            name: s(b.name, 80),
            shortLabel: nullable(b.shortLabel, 40),
            heroImageUrl: nullable(b.heroImageUrl, 500),
            introHtml: nullable(b.introHtml),
            seoTitle: nullable(b.seoTitle, 191),
            seoDescription: nullable(b.seoDescription, 200),
            isVisible: !!b.isVisible,
            sortOrder: Number.isFinite(Number(b.sortOrder)) ? Math.trunc(Number(b.sortOrder)) : 0,
        },
    });
    res.redirect("/admin/styles");
});

router.get("/admin/styles/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const style = await prisma.style.findUnique({ where: { id } });
    if (!style) return res.redirect("/admin/styles");
    res.render("admin_style_edit", { user: req.session.user, style });
});

router.post("/admin/styles/:id", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const b = req.body || {};
    function s(v, max) { const x = String(v == null ? "" : v).trim(); return max ? x.slice(0, max) : x; }
    function nullable(v, max) { const x = s(v, max); return x || null; }
    await prisma.style.update({
        where: { id },
        data: {
            slug: s(b.slug, 40),
            name: s(b.name, 80),
            shortLabel: nullable(b.shortLabel, 40),
            heroImageUrl: nullable(b.heroImageUrl, 500),
            introHtml: nullable(b.introHtml),
            seoTitle: nullable(b.seoTitle, 191),
            seoDescription: nullable(b.seoDescription, 200),
            isVisible: !!b.isVisible,
            sortOrder: Number.isFinite(Number(b.sortOrder)) ? Math.trunc(Number(b.sortOrder)) : 0,
        },
    });
    res.redirect("/admin/styles");
});

router.post("/admin/styles/:id/toggle-visible", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const style = await prisma.style.findUnique({ where: { id } });
    if (!style) return res.redirect("/admin/styles");
    await prisma.style.update({ where: { id }, data: { isVisible: !style.isVisible } });
    res.redirect("/admin/styles");
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

// Single-flight build lock: if multiple crawler requests miss the cache at
// the same instant, they share one DB scan instead of each spawning their own.
let sitemapBuildInFlight = null;
async function readOrBuildSitemap() {
    const sitemapPath = path.join(process.cwd(), "public", "sitemap.xml");
    try {
        return await fsPromises.readFile(sitemapPath, "utf8");
    } catch (err) {
        if (err.code !== "ENOENT") throw err;
    }
    if (!sitemapBuildInFlight) {
        sitemapBuildInFlight = (async () => {
            try {
                const xml = await buildSitemapXml(prisma);
                writeSitemapFiles(xml);
                return xml;
            } finally {
                sitemapBuildInFlight = null;
            }
        })();
    }
    return sitemapBuildInFlight;
}

async function serveSitemap(req, res) {
    const xml = await readOrBuildSitemap();
    res.header("Content-Type", "application/xml");
    res.header("Cache-Control", "public, max-age=3600");
    res.send(xml);
}

router.get("/sitemap.xml", serveSitemap);
router.get("/sitemap", serveSitemap);

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
