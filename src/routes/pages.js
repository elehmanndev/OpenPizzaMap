const express = require("express");
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
