#!/usr/bin/env node
// Feasibility probe for Track 2 (Playwright-based Google Maps scraper).
//
// For 10 sample places from the DB, drives Playwright to Google Maps via
// place_id and captures:
//   - field-level extraction quality (compared against what Google API
//     stored in the DB)
//   - whether place_id can be reliably re-derived from the URL
//   - photo carousel scrape: how many lh3 URLs per place
//   - CAPTCHA hits across the run
//
// Output: JSON to stdout. No DB writes. Safe to run repeatedly.

const { chromium } = require("playwright");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const SAMPLE_SIZE = 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pickSample() {
    const all = await prisma.place.findMany({
        where: {
            isVisible: true,
            googlePlaceId: { not: null },
        },
        select: {
            id: true, name: true, city: true, country: true,
            googlePlaceId: true, googleMapsUrl: true, googlePlaceUrl: true,
            googleRating: true, googleReviewCount: true,
            phone: true, websiteUrl: true, openingHours: true,
            lat: true, lng: true, addressLine: true,
            heroImageUrl: true,
        },
        orderBy: { id: "asc" },
    });
    if (all.length < SAMPLE_SIZE) return all;
    // Spread across the id range
    const step = Math.floor(all.length / SAMPLE_SIZE);
    const picked = [];
    for (let i = 0; i < SAMPLE_SIZE; i++) picked.push(all[i * step]);
    return picked;
}

async function makeBrowser() {
    const browser = await chromium.launch({
        headless: true,
        args: ["--disable-gpu", "--no-sandbox"],
    });
    const context = await browser.newContext({
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        locale: "en-US",
        extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });
    await context.addCookies([
        { name: "CONSENT", value: "YES+cb", domain: ".google.com", path: "/" },
        { name: "SOCS", value: "CAESHAgBEhJnd3NfMjAyMzA3MDQtMF9SQzIaAmVuIAEaBgiAqIaqBg", domain: ".google.com", path: "/" },
    ]);
    const page = await context.newPage();
    return { browser, page };
}

async function dismissConsent(page) {
    // Try several locale variants of the Accept button.
    const selectors = [
        'button[aria-label*="Accept"]',
        'button[aria-label*="Acepto"]',
        'button[aria-label*="Aceptar"]',
        'button[aria-label*="Akzeptieren"]',
        'button[aria-label*="Accetta"]',
        'button[aria-label*="Accepter"]',
        'form[action*="consent"] button',
    ];
    for (const sel of selectors) {
        const btn = await page.$(sel).catch(() => null);
        if (btn) {
            await btn.click().catch(() => {});
            await sleep(800);
            return true;
        }
    }
    return false;
}

async function detectCaptcha(page) {
    const html = await page.content().catch(() => "");
    return /\/sorry\/index|recaptcha|unusual\s+traffic|automated\s+queries/i.test(html);
}

async function scrapePlaceByPlaceId(page, googlePlaceId) {
    const url = `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(googlePlaceId)}&hl=en`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsent(page);
    // After consent click, Google reloads. Wait for the place panel again.
    await page.waitForSelector('h1, button[data-item-id="address"]', { timeout: 15000 }).catch(() => null);
    const navMs = Date.now() - t0;

    if (await detectCaptcha(page)) {
        return { captcha: true, navMs };
    }

    const currentUrl = page.url();
    // Try several patterns for place_id in URL or page state.
    let placeIdFromUrl = null;
    for (const re of [
        /!1s(ChIJ[\w\-_]+)/,
        /!16s.*?(ChIJ[\w\-_]+)/,
        /place_id[:=](ChIJ[\w\-_]+)/,
        /\/data=.*?(ChIJ[\w\-_]+)/,
    ]) {
        const m = re.exec(currentUrl);
        if (m) { placeIdFromUrl = m[1]; break; }
    }
    // Fallback: scrape from page HTML (Google embeds it in the data blob).
    if (!placeIdFromUrl) {
        const html = await page.content().catch(() => "");
        const m = /(ChIJ[\w\-_]{20,})/g.exec(html);
        if (m) placeIdFromUrl = m[1];
    }

    const data = await page.evaluate(() => {
        const out = {};
        out.titleText = (document.querySelector("h1")?.textContent || "").trim() || null;
        out.address = (document.querySelector('button[data-item-id="address"]')?.textContent || "").trim() || null;
        out.phone = null;
        const phoneBtn = document.querySelector('button[data-item-id^="phone"]');
        if (phoneBtn) {
            const m = (phoneBtn.getAttribute("data-item-id") || "").match(/phone:tel:(.+)$/);
            if (m) out.phone = m[1].trim();
        }
        const webA = document.querySelector('a[data-item-id="authority"]');
        out.websiteUrl = webA?.href || null;

        // Rating
        const ratingEl = document.querySelector('[role="img"][aria-label*="star" i]');
        if (ratingEl) {
            const al = ratingEl.getAttribute("aria-label") || "";
            const m = al.match(/(\d+(?:[.,]\d+)?)\s*stars?/i);
            if (m) out.rating = parseFloat(m[1].replace(",", "."));
        }
        // Review count
        if (out.rating != null && ratingEl) {
            let scope = ratingEl;
            for (let i = 0; i < 4 && scope; i++) {
                const t = (scope.textContent || "").replace(/\s+/g, " ");
                let mm = t.match(/\(?\s*(\d{1,3}(?:[.,]\d{3})*|\d+)\s*\)?\s*(?:reviews?|reseñas?|recensioni|avis|bewertungen|opiniones)/i);
                if (!mm) mm = t.match(/\(\s*(\d{1,3}(?:[.,]\d{3})+|\d{2,})\s*\)/);
                if (mm) {
                    out.reviewCount = parseInt(mm[1].replace(/[.,]/g, ""), 10);
                    break;
                }
                scope = scope.parentElement;
            }
        }

        // Opening hours (best-effort, short form)
        const hoursBtn = document.querySelector('[data-item-id="oh"]');
        if (hoursBtn) {
            const aria = hoursBtn.getAttribute("aria-label") || "";
            if (aria.length > 30) out.openingHoursShort = aria.replace(/\s+/g, " ").trim().slice(0, 200);
        }
        return out;
    });

    return {
        captcha: false,
        navMs,
        currentUrl,
        placeIdFromUrl,
        data,
    };
}

async function scrapePhotos(page) {
    // Click the Photos tab. Google Maps uses a button with aria-label
    // like "Photo of <Place Name>" for the hero image, and a separate
    // button labeled "See photos" or a tab in the panel header. The
    // selector pattern we use here covers all observed variants.
    const tabClicked = await page.evaluate(() => {
        // 1. Try buttons with aria-label starting with "Photo"
        for (const btn of document.querySelectorAll("button")) {
            const aria = btn.getAttribute("aria-label") || "";
            if (/^(See|See all|Show)\s+photo/i.test(aria) || /^photos?$/i.test(aria)) {
                btn.click();
                return { found: true, via: "aria", label: aria.slice(0, 60) };
            }
        }
        // 2. Try the hero image itself (clicking it usually opens the gallery)
        for (const img of document.querySelectorAll("button img, button div[role=img]")) {
            const btn = img.closest("button");
            const aria = btn?.getAttribute("aria-label") || "";
            if (/^photo\s+of/i.test(aria)) {
                btn.click();
                return { found: true, via: "hero", label: aria.slice(0, 60) };
            }
        }
        // 3. Try buttons whose visible text is "Photos"
        for (const btn of document.querySelectorAll("button")) {
            const t = (btn.textContent || "").trim();
            if (/^photos?$/i.test(t)) {
                btn.click();
                return { found: true, via: "text", label: t };
            }
        }
        return { found: false };
    }).catch(() => ({ found: false }));

    if (!tabClicked.found) return { tabFound: false, photoUrls: [], tabDetect: tabClicked };

    // Wait for photo grid to render
    await sleep(2000);
    // Scroll the panel to load more thumbs
    for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
            const feed = document.querySelector('[role="main"] [role="feed"], [role="main"]');
            if (feed) feed.scrollBy(0, 800);
        }).catch(() => {});
        await sleep(800);
    }

    // Extract photo URLs from background-image styles and <img> srcs
    const photoUrls = await page.evaluate(() => {
        const urls = new Set();
        // 1. <img> tags with lh3 srcs
        for (const img of document.querySelectorAll("img")) {
            const src = img.src || "";
            if (/lh3\.googleusercontent\.com/.test(src) && /place|photo|p\//.test(src)) {
                urls.add(src);
            }
        }
        // 2. background-image: url(...) on divs
        for (const el of document.querySelectorAll('[style*="background-image"]')) {
            const m = (el.getAttribute("style") || "").match(/url\(["']?(https?:[^"')]+)["']?\)/);
            if (m && /lh3\.googleusercontent\.com/.test(m[1])) {
                urls.add(m[1]);
            }
        }
        return [...urls];
    }).catch(() => []);

    return { tabFound: true, photoUrls, tabDetect: tabClicked };
}

async function main() {
    const sample = await pickSample();
    console.error(`[probe] picked ${sample.length} places`);

    const { browser, page } = await makeBrowser();
    const results = [];
    let captchasHit = 0;

    for (const p of sample) {
        console.error(`[probe] ${p.id} "${p.name}" (${p.city})`);
        let scrape, photos;
        try {
            scrape = await scrapePlaceByPlaceId(page, p.googlePlaceId);
            if (scrape.captcha) {
                captchasHit++;
                photos = { tabFound: false, photoUrls: [], skipped: "captcha" };
            } else {
                photos = await scrapePhotos(page);
            }
        } catch (err) {
            scrape = { error: err.message };
            photos = { error: "skipped (scrape failed)" };
        }

        // Compare scraped fields against DB values
        const cmp = {};
        if (scrape && scrape.data) {
            cmp.name = {
                db: p.name, scraped: scrape.data.titleText,
                match: !!(scrape.data.titleText && scrape.data.titleText.toLowerCase().includes(p.name.toLowerCase().slice(0, 8))),
            };
            cmp.address = {
                db: p.addressLine || null, scraped: scrape.data.address,
                bothPresent: !!(p.addressLine && scrape.data.address),
            };
            cmp.phone = {
                db: p.phone, scraped: scrape.data.phone,
                match: (p.phone || null) === (scrape.data.phone || null),
            };
            cmp.website = {
                db: p.websiteUrl, scraped: scrape.data.websiteUrl,
                bothPresent: !!(p.websiteUrl && scrape.data.websiteUrl),
            };
            cmp.rating = {
                db: p.googleRating == null ? null : Number(p.googleRating),
                scraped: scrape.data.rating || null,
                close: p.googleRating != null && scrape.data.rating != null
                    ? Math.abs(Number(p.googleRating) - scrape.data.rating) < 0.2
                    : null,
            };
            cmp.reviewCount = {
                db: p.googleReviewCount, scraped: scrape.data.reviewCount || null,
                close: p.googleReviewCount != null && scrape.data.reviewCount != null
                    ? Math.abs(p.googleReviewCount - scrape.data.reviewCount) / Math.max(p.googleReviewCount, 1) < 0.25
                    : null,
            };
            cmp.placeId = {
                db: p.googlePlaceId, fromUrl: scrape.placeIdFromUrl,
                match: p.googlePlaceId === scrape.placeIdFromUrl,
            };
        }

        results.push({
            id: p.id,
            name: p.name,
            city: p.city,
            country: p.country,
            navMs: scrape?.navMs,
            captcha: !!(scrape && scrape.captcha),
            error: scrape?.error || null,
            currentUrl: scrape?.currentUrl || null,
            placeIdRecovered: scrape?.placeIdFromUrl || null,
            photoCount: photos?.photoUrls?.length || 0,
            photosTabFound: !!photos?.tabFound,
            photosTabDetect: photos?.tabDetect || null,
            firstPhotoUrl: photos?.photoUrls?.[0] || null,
            cmp,
        });

        // Take a screenshot of the first place for debugging.
        if (results.length === 1) {
            await page.screenshot({ path: "/tmp/probe-debug-1.png", fullPage: false }).catch(() => {});
        }

        // Polite delay between places
        await sleep(2500);
    }

    await browser.close();
    await prisma.$disconnect();

    // Summary
    const summary = {
        total: results.length,
        captchasHit,
        meanNavMs: Math.round(
            results.filter(r => r.navMs).reduce((a, r) => a + r.navMs, 0)
            / Math.max(1, results.filter(r => r.navMs).length)
        ),
        placeIdRecoveryRate: results.filter(r => r.cmp?.placeId?.match).length / results.length,
        nameMatchRate: results.filter(r => r.cmp?.name?.match).length / results.length,
        ratingCloseRate: results.filter(r => r.cmp?.rating?.close === true).length
            / Math.max(1, results.filter(r => r.cmp?.rating?.close !== null).length),
        reviewCountCloseRate: results.filter(r => r.cmp?.reviewCount?.close === true).length
            / Math.max(1, results.filter(r => r.cmp?.reviewCount?.close !== null).length),
        phoneMatchRate: results.filter(r => r.cmp?.phone?.match).length / results.length,
        websiteBothPresentRate: results.filter(r => r.cmp?.website?.bothPresent).length / results.length,
        meanPhotoCount: results.reduce((a, r) => a + (r.photoCount || 0), 0) / results.length,
        placesWithFivePlusPhotos: results.filter(r => (r.photoCount || 0) >= 5).length,
    };

    console.log(JSON.stringify({
        generatedAt: new Date().toISOString(),
        summary,
        results,
    }, null, 2));
}

main().catch((err) => {
    console.error("[probe] crashed:", err);
    process.exit(1);
});
