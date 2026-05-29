// Shared TripAdvisor Content API client. Extracted from scripts/scrapers/
// scrape-venue.js so both the venue scraper and the new TA enricher share
// the same fetch path, retry behaviour, and budget bookkeeping.
//
// Two endpoints used:
//   /location/search          — find candidate location_ids by name + city
//   /location/{id}/details    — pull rating, reviewCount, ranking, url
//
// Per TA's pricing copy (2026-05-12): "Access search APIs for no charge"
// suggests /location/search is uncounted, while the 5,000/mo free tier
// covers details/photos/reviews. We treat both as billed for budget
// purposes until the dashboard confirms — safer to over-reserve.
//
// Auth: API key is domain-restricted to www.openpizzamap.com. TA
// validates the Referer header server-side; missing the `www.` prefix
// returns 403 ("explicit deny"), confirmed by direct probe 2026-04-26.

const taBudget = require('./tripadvisor-budget');
const { normalizeName, jaroWinkler, fetchWithTimeout } = require('./utils');

const TA_BASE = 'https://api.content.tripadvisor.com/api/v1';
const NAME_MATCH_MIN = 0.7;

async function taFetch(pathname, params = {}) {
    const apiKey = process.env.TRIPADVISOR_API_KEY;
    if (!apiKey) throw new Error('TRIPADVISOR_API_KEY not set');
    // Reserve a budget slot BEFORE the network call; load() rolls month/day.
    const slot = taBudget.reserve(pathname);
    const u = new URL(TA_BASE + pathname);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', apiKey);
    const r = await fetchWithTimeout(u.toString(), {
        accept: 'application/json',
        headers: { 'Referer': 'https://www.openpizzamap.com/' },
    });
    if (!r.ok) throw new Error(`tripadvisor ${pathname} ${r.status} (budget ${slot.calls}/${taBudget.MONTHLY_HARD_CAP})`);
    return await r.json();
}

// Two-call lookup: /location/search then /location/{id}/details.
// Returns { search, details } on a confident name match, null on a miss.
// `address` is the documented param (the older scrape-venue.js used the
// undocumented `searchAddress` which TA silently ignored).
async function taLookup(name, city, country) {
    const params = {
        searchQuery: name,
        category: 'restaurants',
    };
    if (city) params.address = city;
    const j = await taFetch('/location/search', params);
    const candidates = (j && j.data) || [];
    if (!candidates.length) return null;

    const wanted = normalizeName(name);
    let best = null, bestSim = 0;
    for (const c of candidates) {
        const sim = jaroWinkler(wanted, normalizeName(c.name || ''));
        if (sim > bestSim) { bestSim = sim; best = c; }
    }
    if (!best || bestSim < NAME_MATCH_MIN) return null;

    const det = await taFetch(`/location/${best.location_id}/details`);
    return { search: best, details: det, similarity: Math.round(bestSim * 100) / 100 };
}

// ─── Playwright-based scrape (free, no quota) ─────────────────────────────
//
// Added 2026-05-28 as part of the move to opm-runner-does-all-scraping.
// Replaces the paid /location/{id}/details + /reviews API calls with a
// Playwright nav of the public TA restaurant page. WebFetch probe
// confirmed the page renders without bot-protection and exposes:
//   - venue name, rating, review count, address, phone
//   - first 5+ review cards (author, date, rating, text)
//   - photo URLs (dynamic-media-cdn, stable, no signing)
// Per-star distribution requires the JS-mounted rating filter widget
// to render — so we use Playwright (not plain fetch) and wait for it.

const sleepTa = (ms) => new Promise((r) => setTimeout(r, ms));

// CloakBrowser page factory for TA. Stock Playwright (createGmapsPage)
// works on Google's residential-IP path, but TA fingerprints Playwright
// (navigator.webdriver=true + other automation indicators) and serves
// a fully-blank page — observed 2026-05-28 with bodyLen=0, title=
// "tripadvisor.com", no h1/og:title/rating despite networkidle+3s.
//
// CloakBrowser patches the detection layer. NOTE — its API differs
// from playwright:
//   - ESM-only, so we use await import() (require throws
//     ERR_PACKAGE_PATH_NOT_EXPORTED on root require)
//   - exports `.launch()` directly at the top level
//   - browser.newPage() takes the viewport/options directly; no
//     separate context.newContext() step
// Pattern lifted from scripts/admin/probe-gambero-rosso.js which has
// been using cloakbrowser successfully against Cloudflare-gated GR
// pages since 2026-05-21.
async function createTaPage() {
    let cb;
    try {
        cb = await import("cloakbrowser");
    } catch (err) {
        throw new Error("cloakbrowser not installed — opm-runner needs `npm install --no-save cloakbrowser`. " + err.message);
    }

    const browser = await cb.launch({ headless: true });
    const page = await browser.newPage({
        viewport: { width: 1366, height: 768 },
    });
    // Block media + fonts only (bandwidth-only, don't gate rendering).
    // Images NOT blocked — TA's renderer keys off image fetches.
    await page.route("**/*", (route) => {
        const t = route.request().resourceType();
        if (t === "media" || t === "font") return route.abort();
        return route.continue();
    });
    return { browser, page };   // no separate context in cloakbrowser API
}

// Build the canonical restaurant page URL from a known locationId.
// TA's URL pattern includes a region code (g<digits>) we don't always
// have — but TA's UserReviewEdit-d<id> URL redirects to the canonical
// page with all the right segments filled in. We follow the redirect.
function taRestaurantUrl(locationId) {
    return `https://www.tripadvisor.com/UserReviewEdit-d${locationId}`;
}

// Search TA for `name + city`, return the locationId of the first
// restaurant-category hit whose name token-overlaps our query.
// Returns null if no confident match — caller writes -1 sentinel
// so we don't re-search every tick.
async function findTaLocationId(page, { name, city }) {
    const q = encodeURIComponent(`${name} ${city || ""}`.trim());
    await page.goto(`https://www.tripadvisor.com/Search?q=${q}&searchSessionId=&searchNearby=false`, {
        waitUntil: "domcontentloaded", timeout: 30000,
    });
    // Wait for results to populate. TA renders them server-side so
    // domcontentloaded usually carries the links already.
    await sleepTa(1500);

    return await page.evaluate((wantName) => {
        const wantTokens = wantName.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
        // Restaurant pages have URLs like
        //   /Restaurant_Review-g123-d456-Reviews-Foo-Bar.html
        // and live anchors with that href. Pick the first one whose
        // visible text shares ≥1 token (length >=3) with the query name.
        const anchors = document.querySelectorAll('a[href*="/Restaurant_Review-"]');
        for (const a of anchors) {
            const text = (a.textContent || "").toLowerCase();
            const matched = wantTokens.some(t => text.includes(t));
            if (!matched) continue;
            const m = a.href.match(/-d(\d+)-/);
            if (m) return Number(m[1]);
        }
        return null;
    }, name);
}

// Pull the venue's display name from a TA page. The selector list
// is tolerant because TA experiments with their DOM — querySelector("h1")
// alone returned null on the Da_Giacomo page (no h1 element at all,
// or h1 not hydrated by the 1500ms post-load wait).
//
// Fallback chain:
//   1. <h1>
//   2. <meta property="og:title">
//   3. document.title (always present), parsed to drop the standard
//      TA suffix "- Restaurant Reviews & Photos, <city>, <country>"
async function taExtractHeading(page) {
    return page.evaluate(() => {
        const norm = (s) => (s || "").replace(/\s+/g, " ").trim();

        const h1 = document.querySelector("h1");
        if (h1 && h1.textContent && h1.textContent.trim().length > 1) return norm(h1.textContent);

        const og = document.querySelector('meta[property="og:title"]');
        if (og) {
            const v = og.getAttribute("content");
            if (v && v.length > 1) return norm(v);
        }

        // document.title fallback: TA's pattern is
        //   "Venue Name - Restaurant Reviews & Photos - tripadvisor"
        // Drop everything from " - " onward.
        const t = norm(document.title || "");
        if (t) {
            const cut = t.split(/\s+-\s+/)[0];
            if (cut.length > 1) return cut;
        }

        return null;
    }).catch(() => null);
}

// Token-overlap match between a TA page heading and our DB name.
// Used to detect wrong-venue historical matches from the old API
// enricher (e.g. our row "Da Lioniello (Milano)" pointing at a TA
// URL for "Da Giacomo Milano" — different restaurants).
function taNameMatches(heading, name) {
    if (!heading || !name) return false;
    const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
    const ht = new Set(norm(heading).split(" ").filter((t) => t.length >= 3));
    const nt = norm(name).split(" ").filter((t) => t.length >= 3);
    if (!nt.length) return false;
    for (const t of nt) if (ht.has(t)) return true;
    return false;
}

// Pick the first restaurant card from a TA search page that
// matches our query name. The token-overlap requirement avoids
// returning whatever happens to be first when our venue isn't on TA.
async function pickSearchResult(page, name) {
    return page.evaluate((wantName) => {
        const norm = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").trim();
        const wantTokens = norm(wantName).split(/\s+/).filter((t) => t.length >= 3);
        for (const a of document.querySelectorAll('a[href*="/Restaurant_Review-"]')) {
            const linkText = norm(a.textContent || "");
            const matched = wantTokens.some((t) => linkText.includes(t));
            if (matched) return a.href;
        }
        // No token match — return null, caller writes -1 sentinel.
        return null;
    }, name);
}

// Scrape rating, count, reviews, distribution from the canonical
// restaurant page. Returns {} on success (caller decides which fields
// to write), or { error } on a hard failure.
//
// Navigation strategy (post-2026-05-28 rev):
//   1. PREFERRED: if caller supplied tripadvisorUrl, navigate directly.
//      Verify h1 heading token-overlaps our DB name. If yes → use.
//   2. If (1) fails (no URL or wrong-venue heading), call the free TA
//      /location/search API + billed /location/{id}/details API to
//      RESOLVE the canonical web_url. ~28 billed calls/day at our
//      scale, well under the 4000/mo budget. The Playwright search
//      path was abandoned because TA's search results are fully
//      JS-mounted and unreliable to scrape.
//   3. Navigate to that resolved web_url. Heading-verify again.
//
// Returns `locationIdOut` when (2) discovered a different locationId
// than the input — caller writes the new id to DB.
async function scrapeTripadvisor(page, { locationId, name, city, country, tripadvisorUrl }) {
    if (!locationId && !tripadvisorUrl && !name) {
        return { error: "no locationId, url, or name supplied" };
    }

    try {
        let landed = false;
        let finalUrl = null;
        let locationIdOut = locationId;

        // TA's JS hydration is SLOW. The 2026-05-28 diagnostic with 10s
        // wait got full rendered content (bodyLen=22107 with rating,
        // count, ranking visible); with 3.5s wait the same URL was a
        // blank stub. We wait 8s after each nav as the floor.
        const TA_HYDRATE_MS = 8000;

        // Strategy 1: stored URL
        if (tripadvisorUrl) {
            try {
                await page.goto(tripadvisorUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await sleepTa(TA_HYDRATE_MS);
                finalUrl = page.url();
                if (/Restaurant_Review/i.test(finalUrl)) {
                    // Verify the heading actually matches our name
                    const heading = await taExtractHeading(page);
                    if (taNameMatches(heading, name)) {
                        landed = true;
                    } else {
                        // Wrong venue stored — log and fall through to search
                        console.warn(`[ta] stored URL is wrong venue (heading="${heading}" vs DB="${name}")`);
                    }
                }
            } catch (_) { /* fall through */ }
        }

        // Strategy 2: API resolve. /location/search is free + uncounted;
        // /location/{id}/details is billed but gives us the canonical
        // web_url. One billed call per place per refresh cycle = ~830/mo
        // total at our scale, well under the 4000/mo safety cap.
        if (!landed && name) {
            try {
                const lookup = await taLookup(name, city, country);
                if (lookup && lookup.details && lookup.details.web_url) {
                    locationIdOut = Number(lookup.search.location_id) || locationIdOut;
                    const resolvedUrl = lookup.details.web_url;
                    await page.goto(resolvedUrl, {
                        waitUntil: "domcontentloaded", timeout: 30000,
                    });
                    await sleepTa(TA_HYDRATE_MS);
                    finalUrl = page.url();
                    if (/Restaurant_Review/i.test(finalUrl)) {
                        const heading = await taExtractHeading(page);
                        if (!name || taNameMatches(heading, name)) {
                            landed = true;
                        } else {
                            return { error: `api-resolved-wrong-venue (heading="${heading || "null"}" url=${resolvedUrl.slice(0, 80)})` };
                        }
                    }
                } else {
                    return { error: "api-lookup-no-match" };
                }
            } catch (err) {
                // taLookup throws on quota / network / config issues
                return { error: `api-resolve-failed: ${err.message}` };
            }
        }

        if (!landed) {
            return { error: `all-nav-strategies-failed (last url: ${finalUrl})` };
        }

        const scraped = await page.evaluate(() => {
            const out = {};

            // Strategy: text-first extraction. The diagnostic showed
            // body text contains the pattern:
            //   "Cucina Conviviale\nClaimed\nSave\nReview\n4.7\n(1,781 reviews)\n#279 of 2,501 Restaurants..."
            // The rating widget aria-labels we used before either don't
            // exist in TA's modern DOM or get hydrated unpredictably.
            // Plain-text regex on body.innerText is the reliable path.
            const bodyText = document.body.innerText;

            // Rating + count combo: "4.7\n(1,781 reviews)" pattern.
            // Look for a single-digit-dot-digit followed by a parenthesized
            // count of reviews on the next line (or same area).
            const ratingCountMatch = bodyText.match(/(?:^|\n)\s*([1-5][.,]\d)\s*\n?\s*\(([\d,.\s]+)\s*review/i);
            if (ratingCountMatch) {
                out.rating = Number(ratingCountMatch[1].replace(",", "."));
                const n = Number(ratingCountMatch[2].replace(/[.,\s]/g, ""));
                if (Number.isFinite(n) && n > 0) out.reviewCount = n;
            }

            // Rating fallback: aria-label-based, in case text path missed.
            if (out.rating == null) {
                const ratingEl = document.querySelector('[aria-label*="of 5 bubbles" i], [aria-label*="bubbles" i], svg[aria-label*="bubbles" i]');
                if (ratingEl) {
                    const al = ratingEl.getAttribute("aria-label") || "";
                    const m = al.match(/([1-5][.,]\d)/);
                    if (m) out.rating = Number(m[1].replace(",", "."));
                }
            }

            // Count fallback: standalone "N reviews" anywhere in body
            if (out.reviewCount == null) {
                const cm = bodyText.match(/\(?([\d,.\s]+)\s*reviews?\)?/i);
                if (cm) {
                    const n = Number(cm[1].replace(/[.,\s]/g, ""));
                    if (Number.isFinite(n) && n >= 5) out.reviewCount = n;
                }
            }

            // Ranking — "#3 of 567 Restaurants in Rome"
            const rankMatch = bodyText.match(/#(\d[\d,.\s]*)\s*of\s*[\d,.\s]+\s*[A-Za-z ]+/i);
            if (rankMatch) out.ranking = rankMatch[0].trim();

            // Distribution — TA renders 5 rows in a panel (Excellent /
            // Very Good / Average / Poor / Terrible, localized per
            // locale). Inspected via the 2026-05-28 Chrome session on
            // the Spanish Pizzarium Bonci page:
            //   - Panel container class .AugPH (hashed by TA's CSS-in-JS)
            //   - 5 child rows, class .jxnKb
            //   - Each row's textContent is the label+count concatenated:
            //     "Excelente2606", "Bueno1309", "Medio639", "Malo468",
            //     "Pésimo428". Order is always best→worst (5★→1★).
            //
            // Class names will drift between TA experiments. Stable
            // signal is the pattern: 5 sibling DOM nodes, each starting
            // with a localized 5★ bucket label followed by a count.
            //
            // Algorithm:
            //   1. Walk all DOM elements, find one whose textContent
            //      starts with a known localized label for 5★ and has
            //      a number after it (e.g. "Excelente2606").
            //   2. That's our anchor row. Walk to its parent.
            //   3. Read all 5 children of the parent — each should have
            //      a trailing number. Pull the counts in order.
            //   4. Cross-check: sum within 5% of out.reviewCount.
            const FIVE_STAR_LABELS = [
                "Excellent", "Excelente", "Eccellente", "Ausgezeichnet",
                "Excelente",                       // PT
                "Très bon", "Très bien",           // FR (note: 4★ in FR is "Très bon")
            ];
            // Find the anchor row. Tight match: textContent must be
            // exactly "<label><digits>" — no trailing letters. That
            // distinguishes the single row ("Excelente2606") from
            // wrapper elements whose textContent contains all 5 rows
            // concatenated ("Excelente2606Bueno1309Medio639..."), both
            // of which start with the label.
            let panel = null;
            outer:
            for (const el of document.querySelectorAll("div, li")) {
                const t = (el.textContent || "").replace(/\s+/g, "").trim();
                if (t.length > 40) continue;
                for (const label of FIVE_STAR_LABELS) {
                    const cmp = label.replace(/\s+/g, "");
                    if (!t.startsWith(cmp)) continue;
                    const tail = t.slice(cmp.length);
                    // tail must be ONLY digits (with optional thousands
                    // separators). No more letters → this is one row.
                    if (/^[\d.,]+$/.test(tail)) {
                        panel = el.parentElement;
                        break outer;
                    }
                }
            }
            if (panel) {
                const rows = [...panel.children];
                if (rows.length === 5) {
                    const counts = rows.map((row) => {
                        const t = (row.textContent || "").replace(/\s+/g, "");
                        const m = t.match(/([\d.,]+)$/);
                        return m ? Number(m[1].replace(/[.,]/g, "")) : null;
                    });
                    if (counts.every((c) => Number.isFinite(c) && c >= 0)) {
                        const sum = counts.reduce((a, b) => a + b, 0);
                        const driftOk = out.reviewCount == null
                            || (Math.abs(sum - out.reviewCount) / out.reviewCount) < 0.05;
                        if (driftOk) out.distribution = counts;
                    }
                }
            }

            // Review cards — TA renders them inline. Each card has a
            // data-automation attribute we can lean on.
            const reviews = [];
            const cards = document.querySelectorAll('[data-automation="reviewCard"], [data-test-target="HR_CC_CARD"]');
            for (const card of cards) {
                const authorEl = card.querySelector('[data-automation*="author"], [class*="author"]');
                const textEl = card.querySelector('[data-test-target="review-body"], q, [class*="reviewText"]');
                const ratingEl = card.querySelector('[aria-label*="of 5 bubbles"], svg[aria-label*="bubbles"]');
                const dateEl = card.querySelector('[data-test-target="review-date"], [class*="reviewDate"]');
                const review = {
                    author: authorEl ? (authorEl.textContent || "").trim() : "Anonymous",
                    text: textEl ? (textEl.textContent || "").trim() : "",
                    rating: null,
                    relativeTime: dateEl ? (dateEl.textContent || "").trim() : null,
                };
                if (ratingEl) {
                    const al = ratingEl.getAttribute("aria-label") || "";
                    const m = al.match(/(\d[.,]\d)/);
                    if (m) review.rating = Number(m[1].replace(",", "."));
                }
                if (review.text.length >= 30) reviews.push(review);
                if (reviews.length >= 5) break;
            }
            out.reviews = reviews;

            // Photo URLs — TA's media-cdn URLs are stable. Take up to 10.
            const photoUrls = new Set();
            for (const img of document.querySelectorAll('img[src*="dynamic-media-cdn.tripadvisor"]')) {
                const u = img.src;
                if (u && !/photo-l|placeholder|icon/i.test(u)) photoUrls.add(u);
                if (photoUrls.size >= 10) break;
            }
            out.photoUrls = [...photoUrls];

            // Canonical URL — for the attribution link on /place pages.
            out.url = window.location.href;

            return out;
        });

        // Propagate locationIdOut so caller can self-heal a stale stored id.
        if (locationIdOut !== locationId) scraped.locationIdOut = locationIdOut;
        return scraped;
    } catch (err) {
        return { error: err.message };
    }
}

module.exports = {
    taFetch, taLookup, NAME_MATCH_MIN,             // legacy API path
    findTaLocationId, scrapeTripadvisor,           // new scrape path
    createTaPage,                                  // CloakBrowser factory for TA
};
