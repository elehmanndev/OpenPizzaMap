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

    // One pass through every place attached to these cities gives us both the
    // count and the top picks. Note: Place.country stores full names ("Italy"),
    // not ISO codes, so we filter by cityId — matches what the existing count
    // logic did, plus carries the data we need to rank by popularity.
    const ids = cities.map((c) => c.id);
    const places = ids.length
        ? await prisma.place.findMany({
            where: { cityId: { in: ids }, status: "active", isVisible: true },
            select: {
                id: true, name: true, cityId: true, heroImageUrl: true,
                priceLevel: true,
                opmRating: true, googleRating: true, tripadvisorRating: true, yelpRating: true,
                googleReviewCount: true, tripadvisorReviewCount: true, yelpReviewCount: true,
                styles: {
                    include: { style: { select: { slug: true, name: true, shortLabel: true } } },
                    orderBy: { style: { sortOrder: "asc" } },
                    take: 1,
                },
            },
        })
        : [];
    const buckets = new Map(cities.map((c) => [c.id, []]));
    for (const p of places) {
        const arr = buckets.get(p.cityId);
        if (arr) arr.push(p);
    }
    // "Most popular" = total review count across Google + TripAdvisor + Yelp.
    // Foot traffic is the truest signal of fame: famous pizzerias accumulate
    // tens of thousands of reviews, niche ones don't. Tiebreaker is opmRating
    // so close-volume rows still favour the better one. Quality floor (>= 4.0
    // on the best available source) drops mega-popular tourist traps that have
    // earned 10k+ reviews despite a sub-par average. The header place count
    // stays unfiltered — it represents "total places in city" — so the floor
    // only narrows the top-3 picks, not the headline number.
    const TOP_PER_CITY = 3;
    const MIN_RATING = 4.0;
    const ratingOf = (p) => {
        const r = p.opmRating ?? p.googleRating ?? p.tripadvisorRating ?? p.yelpRating;
        return r == null ? null : Number(r);
    };
    const volumeOf = (p) =>
        (p.googleReviewCount || 0) +
        (p.tripadvisorReviewCount || 0) +
        (p.yelpReviewCount || 0);
    const opmOf = (p) => Number(p.opmRating ?? -1);
    const topByCity = new Map();
    for (const [key, arr] of buckets) {
        const eligible = arr.filter((p) => {
            const r = ratingOf(p);
            return r != null && r >= MIN_RATING;
        });
        eligible.sort((a, b) => (volumeOf(b) - volumeOf(a)) || (opmOf(b) - opmOf(a)));
        topByCity.set(key, eligible);
    }

    const faqs = await prisma.faq.findMany({
        where: { scope: "country", isVisible: true, countryCode: code },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 200,
    });

    res.render("country", {
        user: req.session.user || null,
        country,
        cities: cities.map((c) => {
            const totalArr = buckets.get(c.id) || [];
            const topArr = topByCity.get(c.id) || [];
            return {
                ...c,
                placeCount: totalArr.length,
                topPlaces: topArr.slice(0, TOP_PER_CITY).map((p) => {
                    // Pick the best available rating, mirroring map.js ratingFor():
                    // opm (composite) → google → tripadvisor → yelp.
                    const r = p.opmRating ?? p.googleRating ?? p.tripadvisorRating ?? p.yelpRating;
                    const rating = r == null ? null : Number(r);
                    // Swap /uploads/places/foo.jpg → /uploads/places/foo-thumb.jpg
                    // when the file is a local upload; external URLs pass through.
                    let thumb = p.heroImageUrl;
                    if (thumb && thumb.startsWith("/uploads/places/")) {
                        const m = thumb.match(/^(.*)\.(jpe?g|png|webp|gif|avif)$/i);
                        if (m && !/-thumb$/.test(m[1])) thumb = `${m[1]}-thumb.jpg`;
                    }
                    const reviewsTotal =
                        (p.googleReviewCount || 0) +
                        (p.tripadvisorReviewCount || 0) +
                        (p.yelpReviewCount || 0);
                    const firstStyle = p.styles && p.styles[0] && p.styles[0].style;
                    return {
                        id: p.id,
                        name: p.name,
                        rating,
                        heroImageUrl: thumb,
                        priceLevel: p.priceLevel || null,
                        reviewsTotal: reviewsTotal || null,
                        style: firstStyle
                            ? { slug: firstStyle.slug, label: firstStyle.shortLabel || firstStyle.name }
                            : null,
                    };
                }),
            };
        }),
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

    // Match what the city detail page used to do — covers both new rows
    // (cityId set) and legacy rows imported before the City normalization,
    // which only have the plain `city` string. The previous handler also
    // gated on `country: code`, but Place.country stores full names
    // ("Italy"), not ISO codes, so that clause silently dropped every
    // legacy row. Removing it.
    const allPlaces = await prisma.place.findMany({
        where: {
            status: "active",
            isVisible: true,
            OR: [{ cityId: city.id }, { cityId: null, city: city.name }],
        },
        select: {
            id: true, name: true, lat: true, lng: true, heroImageUrl: true,
            priceLevel: true,
            opmRating: true, googleRating: true, tripadvisorRating: true, yelpRating: true,
            googleReviewCount: true, tripadvisorReviewCount: true, yelpReviewCount: true,
            styles: {
                include: { style: { select: { slug: true, name: true, shortLabel: true } } },
                orderBy: { style: { sortOrder: "asc" } },
                take: 1,
            },
        },
    });

    // Quality floor: places at 4.0+ on the best-available rating are always
    // shown first regardless of which sort is active, then below-floor places
    // come after. This keeps the page useful even when sorting by price.
    const MIN_RATING = 4.0;
    const ratingOf = (p) => {
        const r = p.opmRating ?? p.googleRating ?? p.tripadvisorRating ?? p.yelpRating;
        return r == null ? null : Number(r);
    };
    const volumeOf = (p) =>
        (p.googleReviewCount || 0) +
        (p.tripadvisorReviewCount || 0) +
        (p.yelpReviewCount || 0);
    const opmOf = (p) => Number(p.opmRating ?? -1);
    const priceOf = (p) => (p.priceLevel == null ? null : Number(p.priceLevel));

    // Server-side sort key. "near-me" is client-side only — geolocation lives
    // in the browser — so the server treats it as the default and the page
    // re-sorts in JS once the user grants permission.
    const SORT_KEY = String(req.query.sort || "popular").toLowerCase();
    const sorters = {
        popular: (a, b) => (volumeOf(b) - volumeOf(a)) || (opmOf(b) - opmOf(a)),
        rating: (a, b) => ((ratingOf(b) ?? -1) - (ratingOf(a) ?? -1)) || (volumeOf(b) - volumeOf(a)),
        "price-asc": (a, b) => ((priceOf(a) ?? 99) - (priceOf(b) ?? 99)) || (volumeOf(b) - volumeOf(a)),
        "price-desc": (a, b) => ((priceOf(b) ?? -1) - (priceOf(a) ?? -1)) || (volumeOf(b) - volumeOf(a)),
    };
    const compare = sorters[SORT_KEY] || sorters.popular;
    const ranked = [...allPlaces].sort((a, b) => {
        const aOk = (ratingOf(a) ?? -1) >= MIN_RATING ? 1 : 0;
        const bOk = (ratingOf(b) ?? -1) >= MIN_RATING ? 1 : 0;
        if (aOk !== bOk) return bOk - aOk; // eligible first
        return compare(a, b);
    });
    const activeSort = sorters[SORT_KEY] ? SORT_KEY : "popular";

    // Pagination — 10 per page. `?page=N` is 1-indexed; clamp invalid to 1.
    const PAGE_SIZE = 10;
    const totalPages = Math.max(1, Math.ceil(ranked.length / PAGE_SIZE));
    const requestedPage = Number(req.query.page || 1);
    const page = Math.min(totalPages, Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1));
    const pageStart = (page - 1) * PAGE_SIZE;
    const pageEnd = pageStart + PAGE_SIZE;
    const pageSlice = ranked.slice(pageStart, pageEnd);

    // Shape places for the card. Mirrors the country-page payload so the
    // .map-sidebar-card markup is identical between /country and /city.
    const places = pageSlice.map((p) => {
        const r = ratingOf(p);
        let thumb = p.heroImageUrl;
        if (thumb && thumb.startsWith("/uploads/places/")) {
            const m = thumb.match(/^(.*)\.(jpe?g|png|webp|gif|avif)$/i);
            if (m && !/-thumb$/.test(m[1])) thumb = `${m[1]}-thumb.jpg`;
        }
        const firstStyle = p.styles && p.styles[0] && p.styles[0].style;
        return {
            id: p.id,
            name: p.name,
            rating: r,
            heroImageUrl: thumb,
            priceLevel: p.priceLevel || null,
            reviewsTotal: volumeOf(p) || null,
            style: firstStyle ? { slug: firstStyle.slug, label: firstStyle.shortLabel || firstStyle.name } : null,
            lat: p.lat != null ? Number(p.lat) : null,
            lng: p.lng != null ? Number(p.lng) : null,
        };
    });

    // Compact marker payload for the mini-map widget. All places, not just
    // the current page — the map shows the whole city.
    const mapPoints = allPlaces
        .filter((p) => p.lat != null && p.lng != null)
        .map((p) => ({ id: p.id, name: p.name, lat: Number(p.lat), lng: Number(p.lng) }));

    const faqs = await prisma.faq.findMany({
        where: { scope: "city", isVisible: true, cityId: city.id },
        orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
        take: 200,
    });

    res.render("city", {
        user: req.session.user || null,
        city,
        places,
        mapPoints,
        pagination: { page, totalPages, totalPlaces: ranked.length, pageSize: PAGE_SIZE },
        activeSort,
        faqs,
    });
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
    const userId = req.session.user.id;

    // Pull everything we need for the profile in one round-trip-shaped batch.
    // Counts come from Prisma's count(); lists are bounded so a power user
    // with thousands of favourites still renders in O(view-cap).
    const [account, visitRows, favoriteRows, reviewRows, submissionsCount] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { id: true, email: true, displayName: true, username: true, role: true, avatarUrl: true, createdAt: true },
        }),
        prisma.visit.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            include: { place: { select: { id: true, name: true, city: true, country: true, isVisible: true } } },
        }),
        prisma.favorite.findMany({
            where: { userId },
            orderBy: { createdAt: "desc" },
            include: { place: { select: { id: true, name: true, city: true, country: true, isVisible: true } } },
        }),
        prisma.review.findMany({
            where: { userId, isVisible: true },
            orderBy: { createdAt: "desc" },
            take: 10,
            include: { place: { select: { id: true, name: true, city: true, country: true } } },
        }),
        prisma.submission.count({ where: { userId } }),
    ]);

    const visiblePlace = (p) => p && p.isVisible !== false;
    const visits = visitRows.filter((v) => visiblePlace(v.place));
    const visitedPlaceIds = new Set(visits.map((v) => v.placeId));

    const favoritesAll = favoriteRows.filter((f) => visiblePlace(f.place));
    const wishlist = favoritesAll.filter((f) => !visitedPlaceIds.has(f.placeId));
    const beenFromFavorites = favoritesAll.filter((f) => visitedPlaceIds.has(f.placeId));

    // "Been there" = unioned by place: every visit, plus the favourite row's
    // metadata where the visit happened to be a saved place. Visits drive
    // ordering (most recent first), favourites annotate.
    const favByPlace = new Map(beenFromFavorites.map((f) => [f.placeId, f]));
    const beenThere = visits.map((v) => ({
        place: v.place,
        visitedAt: v.createdAt,
        favoritedAt: favByPlace.has(v.placeId) ? favByPlace.get(v.placeId).createdAt : null,
    }));

    res.render("me", {
        user: req.session.user,
        account,
        counts: {
            visits: visits.length,
            favorites: favoritesAll.length,
            wishlist: wishlist.length,
            been: beenThere.length,
            reviews: reviewRows.length,
            submissions: submissionsCount,
        },
        wishlist,
        beenThere,
        reviews: reviewRows,
    });
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
