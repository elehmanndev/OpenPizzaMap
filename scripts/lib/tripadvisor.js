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
// Navigation strategy with fallback chain:
//   1. PREFERRED: if caller supplied tripadvisorUrl (from a prior
//      API enrichment), navigate directly. After landing, verify the
//      heading matches our DB name via token overlap. If yes → use.
//      If no → the stored URL is a historical wrong-venue match
//      (old API ranked-by-similarity sometimes mis-matched), fall to (2).
//   2. /UserReviewEdit-d<locationId> direct redirect. Works for ~half
//      of restaurants; others land on a login wall.
//   3. Search by name+city, click the first result whose card text
//      token-overlaps our name. Self-heals wrong stored matches by
//      re-discovering the right locationId.
//
// Returns `locationIdOut` in the result when (3) discovered a different
// locationId than the input, so the caller can update the DB.
async function scrapeTripadvisor(page, { locationId, name, city, tripadvisorUrl }) {
    if (!locationId && !tripadvisorUrl && !name) {
        return { error: "no locationId, url, or name supplied" };
    }

    try {
        let landed = false;
        let finalUrl = null;
        let locationIdOut = locationId;

        // Strategy 1: stored URL
        if (tripadvisorUrl) {
            try {
                await page.goto(tripadvisorUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
                await sleepTa(1500);
                finalUrl = page.url();
                if (/Restaurant_Review/i.test(finalUrl)) {
                    // Verify the heading actually matches our name
                    const heading = await page.evaluate(() => {
                        const h = document.querySelector("h1");
                        return h ? (h.textContent || "").trim() : null;
                    }).catch(() => null);
                    if (taNameMatches(heading, name)) {
                        landed = true;
                    } else {
                        // Wrong venue stored — log and fall through to search
                        console.warn(`[ta] stored URL is wrong venue (heading="${heading}" vs DB="${name}")`);
                    }
                }
            } catch (_) { /* fall through */ }
        }

        // Strategy 2: UserReviewEdit redirect
        if (!landed && locationId) {
            try {
                await page.goto(taRestaurantUrl(locationId), {
                    waitUntil: "domcontentloaded", timeout: 30000,
                });
                await sleepTa(1500);
                finalUrl = page.url();
                if (/Restaurant_Review/i.test(finalUrl)) {
                    const heading = await page.evaluate(() => {
                        const h = document.querySelector("h1");
                        return h ? (h.textContent || "").trim() : null;
                    }).catch(() => null);
                    if (!name || taNameMatches(heading, name)) {
                        landed = true;
                    }
                }
            } catch (_) { /* fall through */ }
        }

        // Strategy 3: search
        if (!landed && name) {
            const q = encodeURIComponent(`${name} ${city || ""}`.trim());
            await page.goto(`https://www.tripadvisor.com/Search?q=${q}`, {
                waitUntil: "domcontentloaded", timeout: 30000,
            });
            await sleepTa(2500);                   // search is JS-heavy
            const href = await pickSearchResult(page, name);
            if (!href) return { error: "search-no-confident-match" };

            await page.goto(href, { waitUntil: "domcontentloaded", timeout: 30000 });
            await sleepTa(2000);
            finalUrl = page.url();
            if (!/Restaurant_Review/i.test(finalUrl)) {
                return { error: `search-fallback-no-review (${finalUrl.slice(0, 80)})` };
            }
            // Extract the locationId from the URL so the caller can update DB
            const m = finalUrl.match(/-d(\d+)-/);
            if (m) locationIdOut = Number(m[1]);
            landed = true;
        }

        if (!landed) {
            return { error: `all-nav-strategies-failed (last url: ${finalUrl})` };
        }
        await sleepTa(500); // extra settle for hydration of rating widget

        const scraped = await page.evaluate(() => {
            const out = {};

            // Rating — h1's sibling has the "4.0 of 5 bubbles" text in
            // aria-label. Multiple selectors as fallbacks for layout drift.
            const ratingEl = document.querySelector('[data-automation*="bubbleRating"], svg[aria-label*="bubbles"], [aria-label*="of 5 bubbles"]');
            if (ratingEl) {
                const al = ratingEl.getAttribute("aria-label") || "";
                const m = al.match(/(\d[.,]\d)\s*of\s*5\s*bubbles/i) || al.match(/(\d[.,]\d)/);
                if (m) out.rating = Number(m[1].replace(",", "."));
            }

            // Review count — typically next to the rating, in text like
            // "5,450 reviews" or a tab labelled "Reviews (5,450)".
            const bodyText = document.body.innerText;
            const countMatch = bodyText.match(/([\d,.\s]+)\s*reviews?\b/i);
            if (countMatch) {
                const n = Number(countMatch[1].replace(/[.,\s]/g, ""));
                if (Number.isFinite(n) && n > 0) out.reviewCount = n;
            }

            // Ranking — "#3 of 567 Restaurants in Rome"
            const rankMatch = bodyText.match(/#(\d+)\s*of\s*[\d,.\s]+\s*[A-Za-z ]+/i);
            if (rankMatch) out.ranking = rankMatch[0].trim();

            // Distribution — the rating filter sidebar renders 5 rows.
            // Each row has the star label + a count. The exact selectors
            // shift between TA's experiments so we use a tolerant strategy:
            // look for elements whose aria-label or nearby text matches
            // "<star count> rating(s)" or similar.
            const distMap = new Map();
            const labelRe = /(\d)\s*star[s]?\s*[:,]?\s*([\d,.\s]+)/i;
            for (const el of document.querySelectorAll("[role='button'], [aria-label]")) {
                const lbl = el.getAttribute("aria-label") || el.textContent || "";
                const m = lbl.match(labelRe);
                if (m) {
                    const stars = Number(m[1]);
                    const count = Number(m[2].replace(/[.,\s]/g, ""));
                    if (stars >= 1 && stars <= 5 && Number.isFinite(count) && !distMap.has(stars)) {
                        distMap.set(stars, count);
                    }
                }
            }
            if (distMap.size === 5) {
                out.distribution = [5,4,3,2,1].map(s => distMap.get(s));
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
    taFetch, taLookup, NAME_MATCH_MIN,            // legacy API path
    findTaLocationId, scrapeTripadvisor,           // new Playwright path
};
