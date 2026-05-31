// Admin-only EJS pages — CMS for Pages, FAQs, Countries, Cities, Places,
// Styles, Submissions, plus the sitemap rebuild trigger. Every route here
// is gated by requireAdmin; mounted at "/" in src/app.js, paths begin with
// "/admin/".
//
// Split out from pages.js on 2026-05-05 — pages.js was 983 lines and mixed
// public + admin in one file, which made navigation slow and made it easy
// to drop a route in the wrong scope.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { prisma } = require("../db");
const { requireAdmin } = require("../middleware/auth");
const { buildSitemapXml, writeSitemapFiles } = require("../services/sitemap");

const router = express.Router();

// Quick filesystem inspection of data/cache on Hostinger (deploy wipes this too).
router.get("/admin/cache-state", (req, res) => {
    try {
        const appRoot = path.join(__dirname, "..", "..");
        const cacheDir = path.join(appRoot, "data", "cache");
        const out = { cacheDir, exists: fs.existsSync(cacheDir) };
        if (out.exists) {
            const entries = fs.readdirSync(cacheDir);
            out.files = entries.map((name) => {
                const p = path.join(cacheDir, name);
                try {
                    const s = fs.statSync(p);
                    return { name, size: s.size, mtime: s.mtime };
                } catch { return { name, error: "stat failed" }; }
            });
        }
        res.json(out);
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

// One-shot: move existing slug-keyed dirs to id-keyed dirs.
//   <persistent>/uploads/places/<slug>/   →   <persistent>/uploads/places/<id>/
// New URL pattern is /uploads/places/<id>/<slug>/<n>.<ext> with the slug
// stripped by the rewrite middleware in src/app.js, so disk only needs the
// id segment. Public, idempotent (skips when target exists), safe to re-run.
router.post("/admin/migrate-uploads-to-id-keyed", async (req, res) => {
    try {
        const appRoot = path.join(__dirname, "..", "..");
        const uploadsTarget = process.env.UPLOADS_DIR
            || path.join(appRoot, "..", "persistent", "uploads");
        const placesDir = path.join(uploadsTarget, "places");
        if (!fs.existsSync(placesDir)) {
            return res.json({ ok: false, error: "places dir missing", placesDir });
        }
        const entries = fs.readdirSync(placesDir, { withFileTypes: true });
        const slugDirs = entries
            .filter((e) => e.isDirectory() && !/^\d+$/.test(e.name))
            .map((e) => e.name);
        // Slug → id lookup from the Place table.
        const slugs = await prisma.place.findMany({
            where: { slug: { in: slugDirs } },
            select: { id: true, slug: true },
        });
        const slugToId = new Map(slugs.map((p) => [p.slug, p.id]));
        const results = { moved: [], skipped: [], orphan: [] };
        for (const slug of slugDirs) {
            const id = slugToId.get(slug);
            if (!id) { results.orphan.push(slug); continue; }
            const src = path.join(placesDir, slug);
            const dst = path.join(placesDir, String(id));
            if (fs.existsSync(dst)) { results.skipped.push({ slug, id, reason: "target exists" }); continue; }
            try {
                fs.renameSync(src, dst);
                results.moved.push({ slug, id });
            } catch (err) {
                results.skipped.push({ slug, id, reason: err.message });
            }
        }
        res.json({ ok: true, ...results });
    } catch (err) {
        console.error("[migrate-uploads] crashed:", err);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Diagnostic: dump the upload-serving path state so we can debug 404s on
// /uploads/* without SSH. The fix in commit 5a5b53b made Express serve
// /uploads from persistent/uploads when it exists; this endpoint shows
// whether that's actually happening on this instance.
//
// Public read-only — only exposes path strings + directory entry names,
// no file contents or DB rows. Remove once the upload-serving bug is fixed.
router.get("/admin/uploads-debug", (req, res) => {
    const cwd = process.cwd();
    const appRoot = path.join(__dirname, "..", "..");
    const uploadsLink = path.join(appRoot, "public", "uploads");
    const uploadsTargetDefault = path.join(appRoot, "..", "persistent", "uploads");
    const uploadsTarget = process.env.UPLOADS_DIR || uploadsTargetDefault;
    const fallback = path.join(appRoot, "public", "uploads");

    function inspect(p) {
        try {
            const exists = fs.existsSync(p);
            if (!exists) return { path: p, exists: false };
            const stat = fs.lstatSync(p);
            const out = {
                path: p,
                exists: true,
                isSymlink: stat.isSymbolicLink(),
                isDirectory: stat.isDirectory(),
            };
            if (stat.isSymbolicLink()) {
                try { out.linkTarget = fs.readlinkSync(p); } catch (e) { out.linkTargetErr = e.message; }
            }
            // Top-level listing
            try {
                const entries = fs.readdirSync(p).slice(0, 12);
                out.sample = entries;
            } catch (e) { out.listErr = e.message; }
            // Inner places dir — count + categorize entries
            try {
                const entries = fs.readdirSync(path.join(p, "places"), { withFileTypes: true });
                const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);
                const files = entries.filter((e) => e.isFile()).map((e) => e.name);
                out.placesDirCount = dirs.length;
                out.placesFileCount = files.length;
                out.placesDirsSample = dirs.sort().slice(0, 60);
                out.placesFilesSample = files.slice(0, 6);
                // Probe a specific dir for the user-named case (debugging).
                try {
                    out.dir42Listing = fs.readdirSync(path.join(p, "places", "42"));
                } catch (e) { out.dir42Err = e.message; }
            } catch (e) { out.placesErr = e.message; }
            return out;
        } catch (e) {
            return { path: p, error: e.message };
        }
    }

    const serveBranch = fs.existsSync(uploadsTarget) ? "persistent" : "fallback (public/uploads)";

    res.json({
        cwd,
        appRoot,
        env: {
            UPLOADS_DIR: process.env.UPLOADS_DIR || null,
            PWD: process.env.PWD || null,
        },
        uploadsServePath: fs.existsSync(uploadsTarget) ? uploadsTarget : fallback,
        serveBranch,
        uploadsTarget: inspect(uploadsTarget),
        uploadsLinkPublic: inspect(uploadsLink),
        fallbackPublic: inspect(fallback),
    });
});

// /admin/pages CMS was removed on 2026-05-18 — it managed the bodyHtml
// for /about and the intro on /faq, but Eric didn't recall it existing
// and nothing in the live nav linked to /about. The `Page` table stays
// intact so existing rows still render on /about if they exist; just
// no editor. Kill the rest of the table later if /about is truly dead.

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

// Hero thumbnail path for the list grid. heroImageUrl may be a base
// (/uploads/places/{id}/{n}.jpg), a -large.jpg, or an external URL.
// Derive the -thumb.jpg sibling for local uploads; leave external URLs alone.
function heroThumb(u) {
    if (!u) return null;
    if (!u.startsWith("/uploads/")) return u;
    const m = /^(.*?)(?:-large|-thumb)?\.[a-z0-9]+$/i.exec(u);
    return m ? `${m[1]}-thumb.jpg` : u;
}

const PLACES_PER_PAGE = 50;

router.get("/admin/places", requireAdmin, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const country = typeof req.query.country === "string" ? req.query.country.trim() : "";
    const vis = req.query.vis; // "visible" | "hidden" | undefined
    const styleId = typeof req.query.styleId === "string" ? Number(req.query.styleId) : null;
    const needs = typeof req.query.needs === "string" ? req.query.needs : "";
    const sort = typeof req.query.sort === "string" ? req.query.sort : "id_desc";
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

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
    if (needs === "no-description") where.descriptionHtml = null;
    if (needs === "no-photos") where.images = { none: {} };
    if (needs === "no-reviews") where.externalReviews = { none: {} };
    if (needs === "not-enriched") where.enrichedAt = null;

    const orderBy =
        sort === "name_asc" ? [{ name: "asc" }] :
        sort === "rating_desc" ? [{ googleRating: "desc" }, { id: "desc" }] :
        sort === "id_asc" ? [{ id: "asc" }] :
        [{ id: "desc" }];

    const [total, places, allStyles] = await Promise.all([
        prisma.place.count({ where }),
        prisma.place.findMany({
            where,
            orderBy,
            take: PLACES_PER_PAGE,
            skip: (page - 1) * PLACES_PER_PAGE,
            select: {
                id: true, slug: true, name: true, city: true, country: true,
                isVisible: true, heroImageUrl: true, phone: true,
                websiteUrl: true, openingHours: true,
                googleRating: true, opmRating: true, enrichedAt: true,
                styles: { select: { style: { select: { name: true } } } },
                _count: { select: { images: true, externalReviews: true } },
            },
        }),
        prisma.style.findMany({ orderBy: { sortOrder: "asc" }, select: { id: true, name: true } }),
    ]);

    const totalPages = Math.max(1, Math.ceil(total / PLACES_PER_PAGE));
    // Filter querystring (minus page) so pagination/sort links keep context.
    const qparts = [];
    if (q) qparts.push("q=" + encodeURIComponent(q));
    if (country) qparts.push("country=" + encodeURIComponent(country));
    if (vis) qparts.push("vis=" + encodeURIComponent(vis));
    if (Number.isFinite(styleId) && styleId) qparts.push("styleId=" + styleId);
    if (needs) qparts.push("needs=" + encodeURIComponent(needs));
    if (sort && sort !== "id_desc") qparts.push("sort=" + encodeURIComponent(sort));
    res.render("admin_places", {
        user: req.session.user,
        places: places.map((p) => ({ ...p, heroThumb: heroThumb(p.heroImageUrl) })),
        allStyles,
        filters: { q, country, vis: vis || "", styleId: styleId || "", needs, sort },
        page, totalPages, total, perPage: PLACES_PER_PAGE,
        qbase: qparts.join("&"),
    });
});

// Bulk visibility — show/hide the selected places at once.
router.post("/admin/places/bulk-visibility", requireAdmin, async (req, res) => {
    const rawIds = Array.isArray(req.body.ids) ? req.body.ids : (req.body.ids ? [req.body.ids] : []);
    const ids = rawIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
    const makeVisible = req.body.action === "show";
    const back = req.headers.referer || "/admin/places";
    if (ids.length) {
        await prisma.place.updateMany({ where: { id: { in: ids } }, data: { isVisible: makeVisible } });
    }
    res.redirect(back);
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
        include: {
            styles: { select: { styleId: true } },
            images: { orderBy: [{ position: "asc" }, { id: "asc" }] },
            externalReviews: { orderBy: [{ source: "asc" }, { position: "asc" }, { id: "asc" }] },
            _count: { select: { reviews: true } },
        },
    });
    if (!place) return res.redirect("/admin/places");
    const allStyles = await prisma.style.findMany({ orderBy: { sortOrder: "asc" } });
    const selectedStyleIds = new Set(place.styles.map((s) => s.styleId));
    // External reviews now come from the ExternalReview table (admin sees ALL
    // incl. hidden, so they can toggle). Split by source for the manager.
    const reviews = place.externalReviews || [];
    res.render("admin_place_edit", {
        user: req.session.user,
        place,
        allStyles,
        selectedStyleIds,
        photos: (place.images || []).map((img) => ({
            ...img,
            thumb: thumbOf(img.localPath),
            isHero: !!place.heroImageUrl && (largeOf(img.localPath) === place.heroImageUrl || img.localPath === place.heroImageUrl),
        })),
        googleReviews: reviews.filter((r) => r.source === "google"),
        taReviews: reviews.filter((r) => r.source === "tripadvisor"),
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
        tripadvisorUrl: nullable(b.tripadvisorUrl, 500),
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
    res.redirect(req.headers.referer || "/admin/places");
});

// --- Place photo management (PlaceImage reorder / hide / set-hero) ---
// PlaceImage rows already carry position + isHidden (isHidden survives
// re-scrapes via the sourceRef dedup unique constraint). These endpoints
// give the admin direct control; each redirects back to the edit page.
// localPath is /uploads/places/{id}/{pos}.{ext}; siblings are
// {pos}-thumb.jpg (admin grid) and {pos}-large.jpg (hero).
function thumbOf(localPath) {
    const m = /^(.*)\.[a-z0-9]+$/i.exec(localPath || "");
    return m && !/-thumb$/.test(m[1]) ? `${m[1]}-thumb.jpg` : (localPath || "");
}
function largeOf(localPath) {
    const m = /^(.*)\.[a-z0-9]+$/i.exec(localPath || "");
    return m && !/-large$/.test(m[1]) ? `${m[1]}-large.jpg` : (localPath || "");
}

router.post("/admin/places/:id/photos/:imageId/move", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const dir = String(req.query.dir || (req.body && req.body.dir) || "").toLowerCase();
    const imgs = await prisma.placeImage.findMany({
        where: { placeId: id },
        orderBy: [{ position: "asc" }, { id: "asc" }],
    });
    const idx = imgs.findIndex((x) => x.id === imageId);
    const swapWith = dir === "up" ? idx - 1 : idx + 1;
    if (idx !== -1 && swapWith >= 0 && swapWith < imgs.length) {
        const arr = imgs.slice();
        const [moved] = arr.splice(idx, 1);
        arr.splice(swapWith, 0, moved);
        // Renumber positions 1..N — heals any pre-existing gaps. No unique
        // constraint on (placeId, position) so transient dupes are fine.
        await prisma.$transaction(
            arr.map((img, i) => prisma.placeImage.update({ where: { id: img.id }, data: { position: i + 1 } }))
        );
    }
    res.redirect(`/admin/places/${id}`);
});

router.post("/admin/places/:id/photos/:imageId/toggle-hidden", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const img = await prisma.placeImage.findFirst({ where: { id: imageId, placeId: id } });
    if (img) await prisma.placeImage.update({ where: { id: img.id }, data: { isHidden: !img.isHidden } });
    res.redirect(`/admin/places/${id}`);
});

router.post("/admin/places/:id/photos/:imageId/set-hero", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const imageId = Number(req.params.imageId);
    const img = await prisma.placeImage.findFirst({ where: { id: imageId, placeId: id } });
    if (img) await prisma.place.update({ where: { id }, data: { heroImageUrl: largeOf(img.localPath) } });
    res.redirect(`/admin/places/${id}`);
});

// --- Place external-review management (ExternalReview reorder / hide) ---
// Same model as photos: each review row owns position + isHidden, both of
// which survive re-scrapes (scraper upserts on placeId+source+dedupKey).
// move reorders within a (place, source) group; toggle-hidden flips isHidden.
router.post("/admin/places/:id/reviews/:reviewId/move", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const reviewId = Number(req.params.reviewId);
    const dir = String(req.query.dir || (req.body && req.body.dir) || "").toLowerCase();
    const target = await prisma.externalReview.findFirst({ where: { id: reviewId, placeId: id } });
    if (target) {
        const group = await prisma.externalReview.findMany({
            where: { placeId: id, source: target.source },
            orderBy: [{ position: "asc" }, { id: "asc" }],
        });
        const idx = group.findIndex((r) => r.id === reviewId);
        const swapWith = dir === "up" ? idx - 1 : idx + 1;
        if (idx !== -1 && swapWith >= 0 && swapWith < group.length) {
            const arr = group.slice();
            const [moved] = arr.splice(idx, 1);
            arr.splice(swapWith, 0, moved);
            await prisma.$transaction(
                arr.map((r, i) => prisma.externalReview.update({ where: { id: r.id }, data: { position: i + 1 } }))
            );
        }
    }
    res.redirect(`/admin/places/${id}`);
});

router.post("/admin/places/:id/reviews/:reviewId/toggle-hidden", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const reviewId = Number(req.params.reviewId);
    const r = await prisma.externalReview.findFirst({ where: { id: reviewId, placeId: id } });
    if (r) await prisma.externalReview.update({ where: { id: r.id }, data: { isHidden: !r.isHidden } });
    res.redirect(`/admin/places/${id}`);
});

// --- Delete a place (danger zone). Cascades to images, externalReviews,
// styles, visits, favorites, reviews via the schema's onDelete rules. ---
router.post("/admin/places/:id/delete", requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    if (String(req.body.confirm || "") !== String(id)) {
        return res.redirect(`/admin/places/${id}`);
    }
    await prisma.place.delete({ where: { id } }).catch(() => {});
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

// Dedup merge tool — UI wrapper around scripts/admin/merge-pair.js logic.
// Same field-by-field merge: drop's better data lands on survivor, drop's
// PlaceImage / Review / Visit / Favorite / Faq rows reassign to survivor
// where unique constraints allow, drop is hidden + tagged with
// enrichmentVersion=-1 so publishReady never auto-revives it.
const { buildMergePlan, applyMergePlan } = require("../services/dedupMerge");

router.get("/admin/merge", requireAdmin, async (req, res) => {
    const survivor = Number(req.query.survivor) || null;
    const drop = Number(req.query.drop) || null;
    const action = String(req.query.action || "");

    let plan = null;
    let result = null;
    let error = null;
    if (survivor && drop) {
        try {
            plan = await buildMergePlan(prisma, survivor, drop);
            if (plan.error) { error = plan.error; plan = null; }
            else if (action === "apply") {
                result = await applyMergePlan(prisma, plan);
            }
        } catch (e) {
            error = e.message;
        }
    }
    res.render("admin_merge", { user: req.session.user, survivor, drop, plan, result, error });
});

router.post("/admin/merge", requireAdmin, async (req, res) => {
    const survivor = Number(req.body.survivor);
    const drop = Number(req.body.drop);
    const action = String(req.body.action || "preview");
    if (!survivor || !drop) return res.redirect("/admin/merge");
    const qs = new URLSearchParams({ survivor: String(survivor), drop: String(drop), action }).toString();
    res.redirect(`/admin/merge?${qs}`);
});

module.exports = router;
