#!/usr/bin/env node
// Step-by-step diagnostic for the consent → Maps flow. Mirrors the
// logic in findPlaceByName but logs every state transition so we can
// see exactly where the resolver bails on an ES-geolocated IP.
//
// Run on opm-runner:
//   docker exec -it opm-runner node scripts/probes/probe-consent-flow.js

const { chromium } = require("playwright");

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox'],
    });
    const ctx = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        locale: 'en-US',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
    });
    const page = await ctx.newPage();

    console.log("STEP 1 — navigate to maps search URL");
    await page.goto('https://www.google.com/maps/search/Di+Fara+Pizza+Brooklyn?hl=en', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
    });
    console.log("  url after goto:", page.url());
    console.log("  title:", await page.title());

    if (/consent\.google\.com/.test(page.url())) {
        console.log("\nSTEP 2 — on consent wall, finding Accept button");
        const acceptBtn = page.locator(
            'button[jsname="b3VHJd"], button[aria-label="Accept all"]'
        ).first();
        const count = await acceptBtn.count().catch(() => 0);
        console.log("  locator count:", count);
        if (count) {
            const isVisible = await acceptBtn.isVisible().catch(() => false);
            console.log("  isVisible:", isVisible);

            console.log("\nSTEP 3 — force-click + wait for nav");
            const t0 = Date.now();
            const [navResult, clickResult] = await Promise.allSettled([
                page.waitForURL(u => !/consent\.google\.com/.test(u.toString()),
                                { timeout: 15000 }),
                acceptBtn.click({ force: true }),
            ]);
            console.log("  click:", clickResult.status, clickResult.reason?.message || "");
            console.log("  nav:  ", navResult.status, navResult.reason?.message || "");
            console.log("  elapsed:", ((Date.now() - t0) / 1000).toFixed(1), "s");
            console.log("  url after click:", page.url());
        }
    }

    console.log("\nSTEP 4 — wait for h1 OR a.hfpxzc (8s)");
    const t1 = Date.now();
    await Promise.race([
        page.waitForSelector("h1", { timeout: 8000 }).catch(() => null),
        page.waitForSelector("a.hfpxzc", { timeout: 8000 }).catch(() => null),
    ]);
    console.log("  elapsed:", ((Date.now() - t1) / 1000).toFixed(1), "s");
    console.log("  url:", page.url());
    console.log("  h1 count:    ", await page.evaluate(() => document.querySelectorAll('h1').length));
    console.log("  hfpxzc count:", await page.evaluate(() => document.querySelectorAll('a.hfpxzc').length));
    const h1Text = await page.evaluate(() => {
        const h = document.querySelector('h1');
        return h ? h.textContent.trim().slice(0, 80) : null;
    });
    console.log("  h1 text:     ", h1Text);

    console.log("\nSTEP 5 — page body sample (first 200 chars of innerText)");
    const bodySample = await page.evaluate(() => (document.body.innerText || "").slice(0, 200));
    console.log("  ", JSON.stringify(bodySample));

    console.log("\nSTEP 6 — ChIJ extraction (mirrors extractPlaceIdFromPage)");
    console.log("  url:", page.url());
    const url = page.url();
    let urlMatch = null;
    for (const re of [
        /!1s(ChIJ[\w\-_]+)/,
        /!16s.*?(ChIJ[\w\-_]+)/,
        /place_id[:=](ChIJ[\w\-_]+)/,
        /\/data=.*?(ChIJ[\w\-_]+)/,
    ]) {
        const m = re.exec(url);
        if (m) { urlMatch = m[1]; break; }
    }
    console.log("  ChIJ in URL:    ", urlMatch || "NONE");
    const html = await page.content();
    const htmlMatch = /(ChIJ[\w\-_]{20,})/.exec(html);
    console.log("  ChIJ in HTML:   ", htmlMatch ? htmlMatch[1] : "NONE");
    console.log("  HTML length:    ", html.length);
    const chijCount = (html.match(/ChIJ[\w\-_]{20,}/g) || []).length;
    console.log("  ChIJ total hits:", chijCount);

    console.log("\nSTEP 7 — wait 3s for SPA to settle, then re-check");
    await new Promise(r => setTimeout(r, 3000));
    console.log("  url after wait:", page.url());
    const html2 = await page.content();
    const htmlMatch2 = /(ChIJ[\w\-_]{20,})/.exec(html2);
    console.log("  ChIJ in HTML:   ", htmlMatch2 ? htmlMatch2[1] : "NONE");
    const chijCount2 = (html2.match(/ChIJ[\w\-_]{20,}/g) || []).length;
    console.log("  ChIJ total hits:", chijCount2);

    await browser.close();
})().catch((e) => { console.error("ERR:", e); process.exit(1); });
