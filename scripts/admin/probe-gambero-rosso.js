#!/usr/bin/env node
// Probe: drive ONE Gambero Rosso detail page via CloakBrowser to see
// what photos are available beyond the search-results hero. Per memory
// reference_cloakbrowser, gamberorosso.it sits behind Cloudflare's
// Voxel-AJAX gate that returns 403 to vanilla Playwright + stealth UAs.
// CloakBrowser is the only free workaround.
//
// Run on opm-runner (has cloakbrowser cached in image):
//   docker exec opm-runner node scripts/admin/probe-gambero-rosso.js
//
// If a URL is hard-coded below already works in your locale and the
// page DOM renders to completion, the script lists:
//   - count of <img> tags with venue-looking URLs (vs. logos / CDN icons)
//   - first 10 image URLs found
//   - whether there's a gallery widget / carousel
//   - the title + breadcrumb so we know which venue we hit

const path = require("path");

// Try a few common URL shapes — Gambero Rosso slug patterns vary by
// category. Replace this with a known-good URL from your data if these
// 404. Look at past scraper output (gambero-rosso-scrape.json) for the
// exact detailUrl shape for any of our 987 GR places.
const URLS_TO_PROBE = [
    "https://www.gamberorosso.it/luoghi/locali/pizzeria/rossi-rossi/",
    "https://www.gamberorosso.it/luoghi/locali/pizzeria/i-tigli-3/",
    "https://www.gamberorosso.it/luoghi/locali/pizzeria/seu-pizza-illuminati/",
];

async function loadCloak() {
    const cb = await import("cloakbrowser");
    return cb.launch;
}

(async () => {
    const launch = await loadCloak();
    const browser = await launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    for (const url of URLS_TO_PROBE) {
        console.log("\n=== " + url + " ===");
        try {
            const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
            console.log("status:", res ? res.status() : "no-response");
            if (!res || !res.ok()) continue;

            // Give the lazy-loader a beat to populate any gallery widget.
            await page.waitForTimeout(2500);

            const data = await page.evaluate(() => {
                const title = document.querySelector("h1")?.textContent?.trim().slice(0, 80);
                const breadcrumbs = [...document.querySelectorAll("a")].map((a) => a.textContent?.trim()).filter(Boolean).slice(0, 8);
                // Collect all <img> URLs that look like a venue photo
                // (heuristic: hosted on the site's own CDN / domains,
                // not the WP-theme/plugin assets).
                const imgs = [...document.querySelectorAll("img")]
                    .map((i) => i.currentSrc || i.src || i.getAttribute("data-src"))
                    .filter(Boolean);
                const venue = imgs.filter((u) =>
                    /\.(jpe?g|webp|png|avif)(\?|$)/i.test(u) &&
                    !/\/plugins\/|\/themes\/|logo|placeholder|sprite|icon|grupp|gr-loader/i.test(u)
                );
                // Look for gallery carousels / swiper widgets.
                const galleries = [
                    ...document.querySelectorAll(".swiper, .slick, .gallery, [data-fancybox], .ts-gallery, .ts-slider"),
                ].length;
                // Get __NEXT_DATA__ if present (some pages are JSON-driven).
                const next = document.querySelector("#__NEXT_DATA__");
                return { title, h1: title, imgsTotal: imgs.length, venueImgs: venue.length, venueSample: venue.slice(0, 10), galleries, hasNext: !!next };
            });

            console.log("title:", data.title);
            console.log("img tags total:", data.imgsTotal);
            console.log("venue-shaped imgs:", data.venueImgs);
            console.log("gallery widgets:", data.galleries);
            console.log("first 10 venue URLs:");
            for (const u of data.venueSample) console.log("  " + u);
        } catch (err) {
            console.log("ERROR:", err.message.slice(0, 120));
        }
    }

    await browser.close();
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
