# SEO Roadmap — Learnings from goto-where.com

**Status:** Plan only · drafted 2026-05-24 · no code changes yet
**Trigger:** Competitive teardown of [goto-where.com](https://goto-where.com) (~561k MAU per [SimilarWeb](https://www.similarweb.com/website/goto-where.com/), 75.4% organic, content-farm directory pulling ad revenue from AI-laundered Google Places data).

## 0 · Governing principle: automate everything per-place

**No per-place manual SEO work — ever.** Goto-Where shipped 300k pages because every page was derived from a template + scraped data + LLM batch. We can't compete with their volume by hand-writing titles and descriptions for 1,800 places, and we *especially* can't compete as we expand into IT/ES and beyond.

Every SEO surface in this roadmap is delivered through one of four automation paths:

1. **Render-time templates** — title, meta description, JSON-LD, breadcrumbs, internal cross-links. Derived from `Place + City + Country + Style + Faq` fields at request time. Zero per-place upkeep. Adding a new place → it gets the full SEO treatment on its first request.

2. **DB-driven generation** — sitemap, hub pages (country/city/style), RSS feed, top-N lists. All driven by Prisma queries against `isVisible=true` rows. Adding a new place or flipping `isVisible` → sitemap updates next build; hub pages update on next request.

3. **Enricher pipeline (cron)** — AI review summary, Google rating refresh, photo gallery (Track 2), opening hours, social URLs. Scheduled on the opm-runner Unraid box (`reference_opm_runner`). Touches any row that's stale, missing, or recently changed. Independent of human effort.

4. **One-shot backfills via `/api/admin/maintenance`** — initial slug backfill, initial AI summary backfill, initial JSON-LD adoption. Run once, then steady-state automation takes over. Per `feedback_hostinger_prisma_cli_panic`, never via bare CLI.

**Manual work — strictly bounded:**
- `Place.seoTitle` / `Place.seoDescription` — admin override fields that exist for the 1-in-100 case where the auto-generated copy is wrong. Empty by default. The auto-generator does the work for the other 99.
- `Place.descriptionHtml` — long-form editorial copy. Empty by default. The "Pizza Lovers say" AI summary fills the visible-content gap on every page even when this is blank.
- `Country.introHtml` / `City.introHtml` / `Style.introHtml` — one-shot editorial hubs (~30 docs total once IT/ES is fully covered). Written by Eric or LLM-drafted-then-Eric-edited. Hand-written copy is *acceptable* here because the cardinality is low and it's high-value SEO real estate.
- FAQs — `Faq` rows with scope=place/city/country/global. Manual but rare; ~20 global + ~5 per top city.

**The test:** if a new pizzeria is added through the chat intake at `/add-your-spot`, does it ship with a complete SEO-optimized page *the moment* the enrichment cron finishes? If yes, the system is automated. If anything in this roadmap requires Eric to log in and write copy per place, it's mis-designed and we fix the design.

---

## 1 · What we learned from them

### 1.1 Hard facts (verified)

- **Scale**: ~300k venues across 6 gzipped sitemaps; ~15–25k pizza-specific via `/categories/pizza-restaurant.html?page=N` (pagination caps ~300).
- **Traffic**: 561k monthly visits (April 2026), global rank #76,853, category rank #417 (Food & Drink > Restaurants).
- **Traffic mix**: **75.41% organic search**, ~zero paid/social, 45% US / 10% CA / 5% UK.
- **Engagement**: 3.54 pages/visit, 1:19 dwell, 37.6% bounce.
- **Top organic keywords** (SimilarWeb): `stop 20 diner`, `foolish frog`, `rol san`, `seaside donuts bakery menu`, `lang van`. **All branded, all tiny restaurants with no own website.** Not category queries.
- **Hosting**: Cloudflare front, PHP/CodeIgniter backend (`data-ci-pagination-page` giveaway), Namecheap registrar, static CDN at `static.goto-where.com`.

### 1.2 Their actual game

Their 75% organic traffic isn't from ranking on "best pizza in NYC". It's from being **the second-best Google result for the names of hundreds of thousands of small restaurants that don't have their own SEO presence**. Restaurant has no website → Google needs to show *something* below the local-pack card → goto-where.com is right there with an exact-match title.

### 1.3 Their tech composition

- **Subdomain-per-venue** — each restaurant lives at `<slug>.goto-where.com`. Google distributes E-A-T at the subdomain level, so they effectively have 300k mini-sites cross-linking → compounding authority.
- **Title formula**: `{Name} — {AI tagline} in {City}` — captures branded + cuisine + geo intent in one tag.
- **Meta description** — formula-driven, mentions name + neighborhood + signature items + occasion.
- **Real Google data laundered through AI**:
  - Ratings + review counts: scraped from Google, **real**.
  - Opening hours: scraped from Google, **real**.
  - "Review highlights" paragraph: AI summary of scraped reviews, plausible but unique-content.
  - Reviews cards (with reviewer name, date): real scraped Google reviews.
  - Menus + descriptions + menu photos: **AI-hallucinated** (title literally says "Menu Suggestions", prices have zero `.99` endings, photos named `<id>gw-menu-highlight-N.jpg`).
- **20 internal cross-links per page** → 3.54 pages/visit, spreads PageRank.
- **NO JSON-LD / no schema.org markup anywhere** — they leave gold-star rich snippets on the table.
- **NO bot defense beyond UA filter** — a Chrome UA string bypasses Cloudflare cleanly.

### 1.4 Estimated cost-to-build (theirs)

| Component | Method | Likely cost |
|---|---|---|
| 300k venue scrape (name + address + phone + 1 photo) | Apify compass or direct Places API | $500–2,000 |
| 250k AI descriptions + 250k AI "menus" | Gemini Flash / gpt-4o-mini batch | $250–1,000 |
| 250k AI menu-highlight images | SDXL/Flux on rented GPU | $100–500 |
| Hosting | Hostinger-class shared + Cloudflare free | <$50/mo |
| Domain + registration | Namecheap | <$15 |
| **Total all-in** | | **~$1k–3k one-shot, then AdSense revenue** |

Not "thousands on scraping". A weekend project budgeted aggressively.

---

## 2 · Self-grilling — resolved decisions

Each row is a decision branch I worked through against the actual codebase (`prisma/schema.prisma`, `src/views/*.ejs`, `src/routes/pages.js`, `src/services/sitemap.js`).

| # | Question | Decision | Reasoning |
|---|---|---|---|
| 1 | Subdomain-per-place like them? | **No** | Subdomain SEO benefit is a moat that needs 50k+ entities. At 1,800 places it's premature, costs cert/DNS overhead, dilutes brand. Path-based slugs rank fine for branded queries when title/meta/JSON-LD are tight. |
| 2 | Route `/place/:id` or `/place/:slug`? | **Switch to `:slug`, 301 from `:id`** | `Place.slug` is already `@unique` in schema, just unused in routing. Branded query matching wants the name in the URL. Old `/place/123` URLs are already indexed; 301 redirects preserve link equity. |
| 3 | Backfill missing slugs? | **One-shot script using `src/services/slugify.js`** | `Place.slug` is nullable today. Run via `/api/admin/maintenance` per `feedback_hostinger_prisma_cli_panic` — bare Node + Prisma crashes on Hostinger. |
| 4 | Title formula? | **`{name} — {style} pizzeria in {city}, {country} · Rated {googleRating}`** with graceful fallbacks | Captures branded ("Sorbillo"), geo ("Naples pizza"), and trust ("4.6 rating") in one line. `Place.seoTitle` overrides if admin set. |
| 5 | Meta description formula? | **`{name}, {addressLine}, {city}. {bestStyleLabel} pizza. {googleRating}★ from {googleReviewCount} Google reviews. Hours, photos, directions.`** | Real, factual, packed with relevance signals. `Place.seoDescription` overrides if admin set. |
| 6 | JSON-LD types on place page? | **Restaurant + AggregateRating + OpeningHoursSpecification + GeoCoordinates + BreadcrumbList + FAQPage (when faqs)** | Unlocks star-rating rich snippets in SERPs (CTR roughly doubles). All data already in the schema. |
| 7 | Which rating powers `AggregateRating`? | **`googleRating` if present, else `opmRating / 2`** | Google rating is the most credible signal for the snippet engine. Our composite `opmRating` is /10 — convert to /5 when used. Attribute properly in `Review` `author` field. |
| 8 | Store Google review *texts* on Place model? | **No — only ratings + counts persist** | Google ToS forbids long-term caching of review bodies (24h limit historically; relaxed but still gray). Schema already correctly stores only `googleRating + googleReviewCount + googleUrl`. The Track 2 Playwright probe confirms we can scrape texts on demand, summarize, store **only the summary** + drop the texts. |
| 9 | "Pizza Lovers say" AI summary — fields? | **Two new fields: `Place.aiReviewSummary Text?` + `Place.aiReviewSummaryAt DateTime?`** | Regenerate when `googleReviewCount` changes by >10% OR every 6 months. Cache hit rate should be >95% steady-state. |
| 10 | "Pizza Lovers say" — generation pipeline? | **Enricher phase + Gemini Flash, no external service** | Reuse Track 2 Playwright session to scrape ~10 latest Google reviews, send to Gemini Flash with strict no-invent prompt, store `aiReviewSummary`. Budget: 1,800 places × ~3k tokens in / 300 out = ~$0.30 first pass, ~$0.05/month steady-state. Respects `feedback_gemini_limits` (well under 1500 RPD cap). |
| 11 | "Other pizzerias in {city}" block — count + sort? | **8 entries, ordered by `opmRating DESC`, exclude current, fallback to country when city has <8** | Reusable Prisma query, server-rendered, no JS. Mirrors Goto-Where's 10-link "More places in NYC" pattern. |
| 12 | Hub page taxonomy — add `/region`? | **No, country + city only** | Region (Lazio, Andalusia) ranks for niche queries only. `Place.region` column exists for future use but unused in routes today. Premature. |
| 13 | Style hubs already exist (`/style/:slug`) — keep? | **Yes, link prominently from city + country hubs** | Style/cuisine pages (Neapolitan, Roman, Sicilian) catch "Neapolitan pizza Madrid" type queries. Schema has `Style.seoTitle/seoDescription` ready. Just need internal-link mesh. |
| 14 | Current URL scheme `/country/:code/city/:slug`? | **Keep, do not migrate to `/places/...`** | Existing URLs are indexed; changing scheme would need 301s across the board and reset crawl reputation. The scheme is fine — Google doesn't care if it's `/country/IT/city/rome`. **My earlier proposal `/places/italy/rome` was wrong** — don't fix what works. |
| 15 | Add `<meta name="description">` to layout? | **Yes — globally in `layout.ejs`** | Currently absent. Every page should accept a `description` variable, fall back to a tagline. |
| 16 | Open Graph / Twitter cards? | **Yes — `og:title`, `og:description`, `og:image`, `og:url`, `og:type`** | Same data flows from `seoTitle/seoDescription/heroImageUrl`. Twitter cards a nice-to-have but cheap. Important for share previews when users post a pizzeria to WhatsApp/Telegram. |
| 17 | `<html lang>` attribute? | **`en` default, per-page override** | Currently bare `<html>`. Set `en` globally. Future: per-country override for IT/ES landing pages if we add localized copy. |
| 18 | Canonical link? | **Yes, every page** | Prevents duplicate-URL dilution. Critical when both `/place/123` and `/place/sorbillo-naples` exist post-migration. |
| 19 | Breadcrumb UI on place pages? | **Yes — `Home › Italy › Rome › Sorbillo`** | Both visual and BreadcrumbList JSON-LD. Rich snippet upgrade + cleaner UX. |
| 20 | Sitemap — split or single? | **Single, current implementation is fine** | <2k URLs total. Multi-shard is only beneficial above ~50k URLs. Current sitemap already dynamic + `<lastmod>` + DB-driven. |
| 21 | Add `/style/:slug` and `/styles` to sitemap? | **Yes** | Currently absent from `src/services/sitemap.js`. One-line additions. |
| 22 | `noindex` on admin / dev paths? | **Yes — `robots.txt` block + per-page `<meta robots="noindex">`** | `/admin/*`, `/auth`, `/me`, `/dev/*` should not be crawled. Verify current robots.txt. |
| 23 | RSS feed for new places? | **Yes — `/feed.xml` with the 20 most recently added places** | Google still uses RSS for fast discovery. Cheap to ship (~30 lines). Bonus: third-party RSS readers re-syndicate, creating backlinks. |
| 24 | AdSense like them? | **Defer — set up the account, do not place tags until >10k MAU** | AdSense pays us; doesn't cost. But aesthetics matter pre-traffic; ads on a thin site hurt trust. Add once organic >10k MAU stabilizes. |
| 25 | "Claim this place" — keep? | **Yes — already exists in `place.ejs:444–453`, currently routes to `/place/:id/suggest-edit`** | The pattern works at any scale because it's just a contact funnel. No verification system needed yet. |
| 26 | Photo gallery vs SEO sequencing? | **SEO first, gallery (Track 2) parallel** | Track 2 is gated on Playwright tuning. SEO work doesn't block on photos — `heroImageUrl` is sufficient for `og:image` and JSON-LD `image`. When Track 2 ships, gallery layouts + `ImageObject` JSON-LD slot in cleanly. |
| 27 | Risk: Google ToS on review attribution? | **Mitigate via on-page citation + link-out** | Every section using Google-derived data carries "Source: Google Maps" with a link to `googleUrl`. Existing "Other ratings" section already does this. Extend to AI summary: "Summarized from {N} Google reviews · Source: Google Maps". |
| 28 | Risk: Hostinger Prisma CLI panic on backfills? | **All backfills via `/api/admin/maintenance`** | Per `feedback_hostinger_prisma_cli_panic`. Slug backfill, AI summary backfill, sitemap rebuild all dispatch as maintenance tasks, not bare Node scripts. |
| 29 | Risk: Gemini quota burn during AI summary backfill? | **Cap at 50/hour with retry-backoff** | `feedback_gemini_limits` — 1500 RPD free cap. 1,800 places at 50/hour = 36 hours wall-clock, well within budget. |
| 30 | Success metrics? | **GSC weekly: total impressions, total clicks, indexed pages, per-page CTR. Analytics: pages/visit, bounce rate. Target: 20-50k MAU within 6 months from SEO work alone.** | `gsc-mcp` already wired up. Weekly cron review of GSC numbers. |

---

## 3 · The gaps, mapped to files

Concrete delta vs. what's already in the repo:

### 3.1 `src/views/layout.ejs` — currently 156 lines, missing almost all SEO `<head>` content

| Need | Current state | Action |
|---|---|---|
| `<html lang="en">` | bare `<html>` | add attribute |
| `<meta name="description">` | absent | accept `description` variable |
| `<meta name="robots">` | absent | per-page override (noindex on admin) |
| `<link rel="canonical">` | absent | accept `canonicalUrl` variable |
| `og:title / og:description / og:image / og:url / og:type` | absent | 5 lines |
| Twitter card tags | absent | 4 lines |
| `<script type="application/ld+json">` slot | absent | accept `jsonLd` variable (array of objects to stringify) |
| Theme color, favicon (if missing) | unknown | audit |

### 3.2 `src/views/place.ejs` — currently 521 lines, missing JSON-LD + internal linking + AI summary section

| Need | Current state | Action |
|---|---|---|
| `Restaurant` JSON-LD | absent | emit from `place` data — name, address, geo, phone, openingHours, image, priceRange |
| `AggregateRating` JSON-LD | absent | from `googleRating + googleReviewCount` |
| `BreadcrumbList` JSON-LD | absent | Home › Country › City › Place |
| `FAQPage` JSON-LD | FAQs render but no schema | wrap existing `place.faqs` |
| Breadcrumb UI nav | absent | new `<nav class="breadcrumb">` block |
| "Other pizzerias in {city}" | absent | new section, 8 cards |
| "Pizza Lovers say" AI summary | placeholder Lorem in `descriptionHtml` | new section using `place.aiReviewSummary` |
| `heroImageUrl` → `og:image` | hero shown but not in head | wire through render context |

### 3.3 `src/views/city.ejs` + `country.ejs` + `style.ejs` — partial; need JSON-LD + cross-linking

| Need | Action |
|---|---|
| `ItemList` JSON-LD enumerating top places | emit from place list passed by route |
| `BreadcrumbList` JSON-LD | one upstream hop each |
| Cross-links | city → other cities in country; country → cities + styles; style → cities |
| `og:image` from `heroImageUrl` | wire through |

### 3.4 `src/routes/pages.js` — needs route additions + data threading

| Need | Action |
|---|---|
| `/place/:slug` route | new — preferred path, with `Place.findUnique({where:{slug}})` |
| `/place/:id` → `/place/:slug` 301 | keep numeric route, redirect when slug exists |
| Place route loads "other in city" set | new Prisma query, 8 rows, exclude current, ordered by opmRating |
| Place route loads breadcrumb data | already has `cityRef`; add country lookup |
| All hub routes thread `description`, `canonicalUrl`, `og*`, `jsonLd` to view | wrapper helper in `src/services/seo.js` (new) |

### 3.5 `prisma/schema.prisma` — additions

```prisma
model Place {
  // ... existing
  aiReviewSummary    String?   @db.Text
  aiReviewSummaryAt  DateTime?
}
```

Single migration. `Place.slug` already exists and is unique — no schema change needed for slug routing.

### 3.6 `src/services/sitemap.js` — already excellent, two small adds

- Add `/style/:slug` entries (one per visible Style)
- Add `/styles` index
- Once slug routing ships: switch place URL emission from `/place/${place.id}` to `/place/${place.slug || place.id}`

### 3.7 New file: `src/services/seo.js`

Central helper. Single export `buildSeoContext({ entity, type })` returns `{ title, description, canonicalUrl, ogImage, jsonLd }`. Every route calls it, every view receives consistent SEO blob.

### 3.8 `public/robots.txt`

Audit current content. Verify `Disallow: /admin/`, `Disallow: /auth`, `Disallow: /me`, `Disallow: /api/`. Confirm `Sitemap:` line points to live sitemap.

---

## 4 · Phased rollout

### Phase 1 — Head + Title + JSON-LD on place page (1 session, ~half-day)

**Goal:** every place page emits proper title/meta/og/canonical/Restaurant+AggregateRating JSON-LD.
**Files:** `src/views/layout.ejs`, `src/views/place.ejs`, `src/routes/pages.js` (place route), new `src/services/seo.js`.
**Risk:** very low. No DB changes, no URL changes, pure additive `<head>` content.
**Validation:** Google Rich Results Test against the new page. Confirm Restaurant + AggregateRating + BreadcrumbList all parse clean.

### Phase 2 — Slug routing (1 session, ~half-day)

**Goal:** `/place/sorbillo-naples` works; `/place/123` 301s when slug exists.
**Files:** `src/routes/pages.js` (new route + redirect), `src/services/sitemap.js` (emit slug URLs), one-shot slug backfill via `/api/admin/maintenance`.
**Risk:** medium. Wrong redirect logic can break existing crawled URLs. Test on a worktree against real DB snapshot before deploy.
**Validation:** GSC URL Inspection on 5 existing `/place/:id` URLs to confirm 301 → slug, slug returns 200, canonical resolves cleanly.

### Phase 3 — Hub pages JSON-LD + internal cross-linking (1 session, ~half-day)

**Goal:** city/country/style pages get `ItemList` + `BreadcrumbList`; place page gets "Other pizzerias in {city}" block.
**Files:** `src/views/city.ejs`, `country.ejs`, `style.ejs`, `place.ejs`, route handlers for additional Prisma queries.
**Risk:** low. Additive.
**Validation:** click trail — homepage → country → city → place → other place. Confirm no dead links, breadcrumbs make sense.

### Phase 4 — "Pizza Lovers say" AI summary (1–2 sessions)

**Goal:** each place page shows a 3–4 sentence summary distilled from Google reviews, labeled "Pizza Lovers say".
**Files:** schema migration (2 new fields), new enricher phase, `src/views/place.ejs` rendering, admin override field in `admin_place_edit.ejs`.
**Risk:** medium. New Gemini integration, Playwright review-scrape addition, ToS attribution discipline.
**Validation:** generate on 10 sample places, eyeball quality, check for hallucinations. Cap at 50/hour during backfill. Track Gemini quota burn.

### Phase 5 — Sitemap + robots + GSC discipline (1 session, ~2 hours)

**Goal:** `/style/:slug` URLs in sitemap, robots.txt audited, sitemap resubmitted to GSC, RSS feed at `/feed.xml`.
**Files:** `src/services/sitemap.js`, `public/robots.txt`, new RSS handler in `src/routes/pages.js`.
**Risk:** very low.
**Validation:** GSC sitemap report shows new URLs ingested; RSS feed validates in W3C feed validator.

### Phase 6 — Photo gallery (Track 2)

**Gated on Track 2 backend work.** Once shipped:
- Gallery JS component (carousel + lightbox)
- `og:image` upgrades to gallery position 1
- `ImageObject[]` added to Restaurant JSON-LD

### Phase 7 — Polish & monitoring (ongoing)

- Weekly GSC review (impressions trend, top queries, indexing coverage)
- Per-quarter: hand-audit 5 lowest-CTR pages, improve titles/descriptions
- Backlink campaign per `project_backlink_queue` (Reddit, OSM wiki, Wikipedia)
- AdSense once >10k MAU stabilizes

---

## 5 · Explicit non-goals

To prevent scope creep, these things we are **not** doing despite Goto-Where having them:

1. **Subdomain-per-venue architecture.** Premature at our scale. Revisit only if we cross 50k places.
2. **Hallucinated menus, descriptions, or photos.** Long-term reputation suicide. The Lorem ipsum placeholder in `place.ejs` should be replaced with real content (AI summary of reviews, owner-submitted, hand-curated by Eric) — never invented dishes.
3. **30+ generic categories.** We are pizza-focused. Topical concentration is our edge under Google's helpful-content updates.
4. **Bulk import of their data.** `feedback_exclusive_list` says no. Their names/addresses are Google Places one-hop-laundered anyway — we can hit Google directly.
5. **Aggressive Cloudflare CDN tweaks beyond what's in `project_cloudflare_setup`.** Existing setup is fine.

---

## 6 · Realistic outcome forecast

Not a sales pitch. Honest projection:

- **Month 1**: phase 1–3 ship; GSC starts re-crawling. Impressions on existing indexed pages likely up 30–60% from rich-snippet eligibility. CTR up due to gold stars in SERPs. No new traffic floors yet.
- **Month 2–3**: phase 4 ships; per-page content gets substantive. Long-tail branded queries start ranking. Probably 5–15k MAU.
- **Month 4–6**: backlinks (per `project_backlink_queue`) start accumulating; aggregate domain authority rises; city/style hubs begin ranking for geo queries. 20–50k MAU range realistic.
- **Year 1+**: ceiling determined by total place count + backlink quality. To get within an order of magnitude of Goto-Where's 561k MAU we'd need ~30–50k curated places **and** real domain authority. Both are multi-year.

The thing we will never beat them on is volume. The thing we will beat them on is **per-page quality + topical focus + community signal**. That's the long-run play.

---

## 7 · Open questions (for Eric)

These can be answered later; not blocking on phase 1.

- **Q1: AdSense account.** Set up now (so we're approved when traffic justifies tags) or wait? Recommend: set up now, defer tag placement.
- **Q2: Cookie banner for EU traffic.** Once Analytics + AdSense are live, we need CMP. Iubenda free tier or a self-hosted minimal banner? Recommend: defer until AdSense ships.
- **Q3: Localized landing copy** for IT/ES (Italian and Spanish translations of country/city hub `introHtml`). Big SEO lift for local-language queries, but adds editorial work. Recommend: park behind phase 5, decide when MAU justifies.
- **Q4: Public-facing "About Eric" page** with a face and a story. Google's E-E-A-T weighs creator authority heavily, especially post-2023 helpful-content updates. Recommend: low-priority but high-impact, ship in phase 7.

---

## 8 · Automation map — what runs how, and when

The roadmap delivers every SEO surface through one of the four automation paths from §0. This table is the single audit view: every row is something Google sees on our pages, mapped to the mechanism that produces it, the trigger that updates it, and what manual effort it ever requires (steady-state — initial implementation is excluded).

| SEO surface | Mechanism | Trigger | Steady-state manual work |
|---|---|---|---|
| `<title>` | Render-time template (`src/services/seo.js`) | Every page render | None — fallback to `Place.seoTitle` if admin overrode |
| `<meta name="description">` | Render-time template | Every page render | None — fallback to `Place.seoDescription` if admin overrode |
| `<link rel="canonical">` | Render-time template, derives from slug | Every page render | None |
| `<html lang>` | Layout default `en`; per-page override variable | Every page render | None |
| `og:title / og:description / og:url` | Render-time template (same source as `<title>` etc.) | Every page render | None |
| `og:image` | `place.heroImageUrl` (or `city/country/style.heroImageUrl`) | Every page render | None — Track 2 will keep `heroImageUrl` auto-populated |
| `Restaurant` JSON-LD | Render-time emit from existing DB fields | Every place page render | None |
| `AggregateRating` JSON-LD | Render-time, prefers `googleRating`, falls back to `opmRating/2` | Every place page render | None |
| `OpeningHoursSpecification` JSON-LD | Render-time, parses `Place.openingHours` via existing multilingual parser | Every place page render | None — parser already handles 6 languages |
| `GeoCoordinates` JSON-LD | Render-time from `Place.lat/lng` | Every place page render | None |
| `BreadcrumbList` JSON-LD | Render-time from country/city relations | Every page render | None |
| `FAQPage` JSON-LD | Render-time wraps `place.faqs` | Pages with FAQs | Only when adding new FAQ rows — rare (~20 global, ~5 per top city) |
| `ItemList` JSON-LD on hubs | Render-time from top-N place query | Every hub render | None |
| "Other pizzerias in {city}" block | Render-time Prisma query, 8 rows, opmRating DESC, excludes current | Every place page render | None |
| Breadcrumb UI | Render-time from country/city relations | Every page render | None |
| Footer top-5 countries / cities / styles | Render-time aggregation, cached 1h | Every page render | None |
| URL slug (`/place/{slug}`) | `slugify(name + city)` at row creation | New place insert + initial backfill | None — collision handled by `@unique` constraint + counter suffix |
| Sitemap entries | DB query, current implementation already excellent | `npm run sitemap:build` on every deploy + nightly cron | None |
| Sitemap `<lastmod>` | `Place.updatedAt` (already wired) | DB write to place row | None |
| RSS feed | DB query for 20 most recently added places, served fresh each request | Every `/feed.xml` request | None |
| robots.txt | Static file in `public/robots.txt`, audited once | Static | None — re-audit only when adding new admin routes |
| GSC sitemap submission | One-shot per environment via `gsc-mcp` | After URL scheme change | None steady-state |
| "Pizza Lovers say" AI summary | Enricher phase: Playwright scrape → Gemini Flash batch → `Place.aiReviewSummary` | Cron — every 10min, picks rows where `aiReviewSummaryAt` is null OR older than 6mo OR `googleReviewCount` drifted >10% | None |
| Google rating refresh | Existing enricher (Track 2 Playwright probe path) | Cron — yearly per place | None |
| Photo gallery (Track 2) | Existing Track 2 design — Playwright scrape + Hostinger download | Cron — yearly per place, position 1 promoted to `heroImageUrl` | None — admin can pin a different hero via existing tooling |
| Country / City / Style hub pages exist | DB-driven routes already shipped (`/country/:code`, `/country/:code/city/:slug`, `/style/:slug`) | DB row insert with `isVisible=true` | One-shot: write 1 paragraph `introHtml` per IT/ES hub (~30 docs total). LLM-draftable. |
| Country / City / Style hub `seoTitle/seoDescription` | Render-time template with admin override fields | Every hub render | None — overrides are escape hatch |
| Place enrichment (address, hours, social URLs, etc.) | Existing enricher cron (memory: `project_enricher_backlog`) | Cron — 10-min cadence, picks stale rows | None |
| "Claim this place" / "Suggest an edit" funnel | Existing UI (`place.ejs:444–453`) + admin moderation queue (`/admin/submissions`) | User-initiated → admin review | Eric triages submissions — already part of existing curation work, no SEO-specific add |
| AdSense (deferred) | Static script tag, once enabled | Once-off setup | None — Google handles ad inventory |

**Read this table top-to-bottom and you should be able to answer: "If we add a new pizzeria tomorrow, what work does Eric do to get it ranking?" Answer: zero, beyond approving the submission via the existing moderation queue.**

### 8.1 Automated cadences (what runs without anyone pressing a button)

| Job | Cadence | What it touches |
|---|---|---|
| Enricher: place address/hours/socials | Every 10 min, picks stale | Active places where `enrichedAt` older than refresh threshold |
| Enricher: Google rating refresh | Yearly per place | All visible places |
| Enricher: AI review summary | Every 10 min, picks stale | Places where `aiReviewSummaryAt` null, >6mo, or review count drifted >10% |
| Enricher: photo gallery (Track 2 once shipped) | Yearly per place | All visible places |
| Sitemap rebuild | On every deploy + nightly | All visible rows |
| Hub page top-N cache invalidation | On place insert/update | Affected city/country |
| GSC monitoring | Weekly read via `gsc-mcp` (manual or scheduled) | Impressions, top queries, indexing coverage |

### 8.2 The one-shot list (run once, then automation takes over)

These are the only things that take real human time, and each runs exactly once:

1. **Slug backfill** — populate `Place.slug` for any null rows. ~5 min compute, dispatch via `/api/admin/maintenance`.
2. **AI summary first-pass backfill** — generate `aiReviewSummary` for all 1,800 places. ~36 hours wall-clock at 50/hour (Gemini quota safe). Dispatch via `/api/admin/maintenance`.
3. **GSC re-submission** — submit updated sitemap to GSC, request indexing for top hub pages. ~10 min via `gsc-mcp`.
4. **`introHtml` for IT/ES hubs** — write or LLM-draft + Eric-edit ~30 country/city/style intros. Once-only editorial work.
5. **Code phases 1–5** — actual implementation work, ~5 sessions total.

After all five are complete, the system is fully automated. New places → full SEO pages auto-generated. New reviews → summaries auto-refresh. New cities reached → hub pages auto-appear when `isVisible=true` is flipped.

### 8.3 Where automation explicitly does NOT apply

To be honest about the boundary:

- **Backlink campaign** (`project_backlink_queue`) — Reddit posts, OSM wiki edits, GitHub stars, Wikipedia external links. These are inherently human-driven trust-building. They're outside this roadmap's scope but are the long-run lever that lifts the whole site's domain authority.
- **`Country.introHtml` / `City.introHtml`** — see above; cardinality is low enough that hand-curation is fine, and Google heavily rewards real editorial copy on hub pages.
- **Curation calls** — which places to import, which submissions to approve. This *is* the product (`feedback_exclusive_list`) and shouldn't be automated.

### 8.4 SQL vs Gemini split — prose vs. structure

A common mistake when building automated SEO is to route too much through the LLM. Our rule:

> **Gemini writes the prose. SQL picks the targets.**

Every Gemini-generated string is generated **once**, **cached in the DB**, and **read like any other column at render time**. No synchronous LLM call ever sits in the request path.

#### Layer A — Link structure (SQL only, no LLM)

These are *which* places/cities/styles get linked from where. Deterministic, fast, hallucination-proof.

| Block | Query (logical) | Where it renders |
|---|---|---|
| "Other pizzerias in {city}" | top 8 by `opmRating DESC` in same city, exclude current | bottom of every place page |
| "Top {style} pizzerias" | top 8 by `opmRating DESC` joined on `PlaceStyle` | bottom of style-tagged places + style hub |
| "Other cities in {country}" | top 8 by `placeCount DESC` in same country, exclude current | country + city hubs |
| "Styles found in {city}" | `DISTINCT styles GROUP BY style ORDER BY COUNT DESC` for that city | city hub |
| Footer top-5 (countries / cities / styles) | top 5 by `placeCount` globally | every page footer |
| Place-page breadcrumb | `place → city → country` via existing relations | every place page |

**Why no Gemini here:**
- Determinism (Google rewards consistent link structure; LLM picks vary run-to-run)
- Cost (would run on every render)
- Inputs are already perfect (`opmRating`, `placeCount`, `styleId` are exactly the right ranking signals)
- Hallucination risk (Gemini might "recommend" a place we don't have, or skip the best one)

#### Layer B — Prose around link blocks + hub intros (Gemini, cached in DB)

This is where Gemini earns its keep. The *links* come from Layer A; Gemini writes the surrounding sentences that frame *why* this link block exists.

| Surface | Field | Generation cadence | Cost (one-shot) |
|---|---|---|---|
| Country intro paragraph (~150 words) | `Country.introHtml` | One-shot per country, ~15 hubs for IT+ES+expansion | ~$0.05 |
| City intro paragraph (~150 words) | `City.introHtml` | One-shot per visible city, ~50 hubs for IT+ES | ~$0.20 |
| Style intro paragraph (~150 words) | `Style.introHtml` | One-shot per style, ~10 styles | ~$0.05 |
| Cross-link block blurb (1-2 sentences above "Other pizzerias in {city}") | `City.crosslinkBlurb` (new field) | One-shot per city; refresh when top-5 ordering materially shifts | ~$0.02 |
| Cross-link block blurb for styles | `Style.crosslinkBlurb` (new field) | One-shot per style | ~$0.01 |
| "Pizza Lovers say" — review summary | `Place.aiReviewSummary` | Per-place, regenerate when review count drifts >10% or older than 6 months | ~$0.30 first pass |
| Optional `descriptionHtml` filler (replaces Lorem ipsum) | `Place.descriptionHtml` | One-shot per place; admin override | ~$0.30 first pass |

**Total Gemini budget across the lifetime of automated copy generation: under $1.** Well inside `feedback_gemini_limits` (1500 RPD cap — first pass paces at 50/hour over ~36 hours wall-clock).

#### Grounding pattern (mandatory for every prose-generation call)

To prevent the hallucinated-history failure mode (`"Rome's pizza scene dates back to the 1800s when..."`), every prompt follows this skeleton:

```
ROLE: You are writing the [intro paragraph | review summary | cross-link blurb]
      for a pizza directory's [city | place | style] page.

FACTS (do not invent beyond these):
  [structured data block — names, counts, styles, neighborhoods, ratings]

WRITE:
  - [N] words, [N] paragraphs
  - Voice: warm, informed, local-friend-pointing-the-way
  - Must reference: [specific factual hooks from the data]

BANNED VOCABULARY:
  "best", "amazing", "must-visit", "hidden gem", "authentic",
  "iconic", "legendary", "famous for" (unless quoting a review verbatim)

OUTPUT: HTML, paragraph tags only, no headings, no lists.
```

The banned-vocabulary list is the cheapest single quality lever. It alone removes ~80% of the "AI slop" smell. Combined with the grounding facts, the output reads like a copyedited travel-guide sidebar — exactly what Google's helpful-content updates reward.

#### Admin override at every layer

Every Gemini-generated field has an admin-editable counterpart in the existing admin UI:
- `Country/City/Style/Page.introHtml` → already editable in `admin_*_edit.ejs` views
- `Place.aiReviewSummary` + `Place.descriptionHtml` → add to `admin_place_edit.ejs`
- `City/Style.crosslinkBlurb` → add to existing edit views

The escape hatch matters: if Gemini misfires on Rome's intro and Eric notices, he edits the row in admin, and that text is now sticky. Future regenerations skip places/hubs where the field was admin-touched (track via an `..._editedAt` timestamp).

### 8.5 Rank-badge data lineage (TripAdvisor-style "#1 of N" badges)

Each badge style is a SQL aggregation against existing data — same automation principle as everything else in §8.4 (SQL picks the targets, Gemini writes the prose). But the *credibility* of each badge depends on the underlying data being trustworthy. Day-one not all four badge scopes are honest enough to ship.

**Audit done 2026-05-24** (from the code, not the DB — DB was running the social backfill cron):

#### City rank · `#1 of 8 in Caiazzo`

- **Source:** `Place.cityId` OR `Place.city` name match (mirrors the city-route OR-fallback)
- **Coverage:** reliable today
- **Ranking score:** `opmRating DESC` with `googleReviewCount DESC` tiebreak
- **Display gate:** `cityPlaceCount >= 3` AND `myRank <= 20` OR `myRank/total <= 0.10`
- **Status:** ✅ **Ship in Phase 1**

#### Country rank · `#12 of 1,298 in Italy`

- **Source:** `Place.country` literal match
- **Coverage:** excellent — populated on every row
- **Ranking score:** same Bayesian-blended `opmRating`
- **Display gate:** `myRank <= 50` OR `myRank/total <= 0.05`
- **Status:** ✅ **Ship in Phase 1**

#### Province / region rank · `#1 in Provincia di Caserta`

- **Source:** `Place.region` literal match
- **Coverage today:** ~0%. Confirmed via grep — the enricher pipeline (`src/services/enrichment/batch.js:90-101`) writes `enrichedAt / googlePlaceId / googlePlaceUrl / enrichmentVersion / phone / websiteUrl / openingHours / googleRating / googleReviewCount / heroImageUrl`. **It does not touch `region`.** The only writes to `Place.region` are admin UI + chat submissions + dedup-merge preservation.
- **Unblocks when:** enricher patch lands — 3 lines to extract `administrative_area_level_2` from Google Places `address_components` and add it to the `patch` object in `batch.js`. Backfill from cached `EnrichmentCache.responseJson` where possible (free); fresh API calls for the rest.
- **Status:** ⏸ **Defer to Phase 4** (alongside AI review summary — same enricher pipeline pattern)

#### Style rank · `#3 of 84 Contemporary pizzerias`

- **Source:** `PlaceStyle` join
- **Coverage today:** uneven. Confirmed via grep — three write paths exist (`pages.admin.js:318` bulk-tag, `pages.admin.js:429` per-place edit, `api.chat.js:722` chat intake) and one merge transfer (`scripts/legacy/enricher.js:769`). **No enrichment service writes styles.** New chat-intake submissions get 1 style; bulk-imported scrape rows get 0 unless admin curated.
- **Implication:** even where styles ARE tagged, the denominator silently lies — "#3 of 84 Contemporary" means "of 84 *tagged*", not the true universe.
- **Unblocks when:** Gemini classifier enricher pass lands — one-shot per place, prompted with `name + city + country + Google categories + first ~10 review excerpts`, returns up to 2 styles from our taxonomy with a confidence floor (never guess). Cost: ~$0.10 for all 1,800 places first pass, ~$0.01/month steady-state.
- **Status:** ⏸ **Defer to Phase 4** (new automation row in §8 once it ships)

#### Display gates (apply to every badge)

```
City rank:    show if  cityPlaceCount >= 3
              AND      myOpmRating IS NOT NULL
              AND      myRank <= 20  OR  myRank/total <= 0.10

Country rank: show if  myRank <= 50  OR  myRank/total <= 0.05

Region rank:  show if  Place.region IS NOT NULL
              AND      regionMemberCount >= 10
              AND      myRank <= 20  OR  myRank/total <= 0.10

Style rank:   show if  styleMemberCount >= 20
              AND      myRank <= 20  OR  myRank/total <= 0.10
```

The `styleMemberCount >= 20` gate is critical — it ensures a style badge is only shown when the denominator is meaningful. As Gemini style-classification fills the tag database, more styles will cross the threshold and more badges will unlock automatically. No code change needed at the badge layer — it's a data-quality threshold, not a feature flag.

#### `PlaceRank` cache table

Nightly cron computes all four scopes for every place via window-function queries. Stores in a small new table:

```prisma
model PlaceRank {
  placeId       Int
  scope         String   // "city" | "region" | "country" | "style:<slug>"
  rank          Int
  total         Int
  computedAt    DateTime @default(now())
  place         Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
  @@id([placeId, scope])
  @@index([scope, rank])
}
```

~1,800 places × ~4 scopes per place = ~7,200 rows steady-state. Recomputed nightly via maintenance dispatch. Render-time just `findMany` against this table keyed by `placeId`, applies the display gates, renders the badges. Sub-10ms per page.

#### Roadmap consequence

This audit changes nothing about the existing phase structure — it just tightens which badges go live in which phase:

- **Phase 1** (head + JSON-LD on place page) adds city + country badges. They're already reliable.
- **Phase 4** (AI review summary) gains two sibling tasks: the enricher `region` write-patch (3 lines + backfill from cache) and the Gemini style classifier (one new prompt + 1,800-call one-shot, ~$0.10).
- **Once Phase 4 ships,** region + style badges light up automatically — no further code change at the badge layer because they're gated by data quality, not by feature flags.

## 9 · Profile-side addendum · visit-date capture

Surfaced 2026-05-24 while prototyping the profile redesign (`docs/preview-profile-badges.html`). Out of scope for goto-where.com SEO work but underpins two profile surfaces that the redesign relies on — the **passport stamps** (Visited section) and the **review cards** (My reviews section). Without this change both date displays read "when you clicked save", not "when you actually visited". For a stamp/review metaphor that's wrong: a passport stamp records the entry date, not the filing date.

### Schema delta — two nullable columns

```prisma
model Visit {
  id         Int      @id @default(autoincrement())
  userId     Int
  placeId    Int
  createdAt  DateTime @default(now())     // existing — when the row was logged
  visitedAt  DateTime?                     // NEW — month-precision visit date
  // ... existing relations ...
}

model Review {
  id         Int      @id @default(autoincrement())
  placeId    Int
  userId     Int
  pizza      Float
  local      Float
  servicio   Float
  precio     Float
  comment    String?  @db.VarChar(500)
  createdAt  DateTime @default(now())     // existing — when the review was saved
  updatedAt  DateTime @updatedAt           // existing
  visitedAt  DateTime?                     // NEW — month-precision visit date
  // ... existing relations ...
}
```

Both nullable. Legacy rows (Eric's existing 5 visits + 5 reviews, plus anyone else's) stay valid until backfilled. Display logic uses `visitedAt ?? createdAt` as a fallback so the UI never shows a blank date.

### UX capture points

**1. Review modal (`src/views/place.ejs` line ~471).** Already collects pizza/local/servicio/precio scores + price level + comment. One new field added at the top of `<form data-review-form>`:

```html
<label class="review-modal__visit-wrap">
  <span class="review-row__label">When did you visit?</span>
  <input type="month" name="visitedAt" data-review-visit required
         min="2010-01" max="<%= currentYearMonth %>" />
</label>
```

`<input type="month">` yields `YYYY-MM` strings — month precision exactly. Browser-native picker, no JS calendar library. Required, validated server-side.

**2. "Mark as visited" flow.** Today the favourite/visited toggle is a single tap (see `place.ejs:265` for the favourite handler). For the visit action specifically, intercept the tap and open a tiny inline picker — default `currentMonth`, two clicks to confirm. Keeps the friction minimal: one extra confirm, not a full form.

**3. Edit-date link on existing profile cards.** Each stamp and review card on `/me` gets a small "Edit date" affordance:

```
[Stamp: Caiazzo · MAY 2026]   Pepe in Grani · Edit date
```

Tap → tiny month-picker overlay → save. POSTs to `/api/places/{id}/visit` or `/api/reviews/{id}` with the new `visitedAt`. Server validates same constraints as the review modal.

### Display logic

```js
const displayDate = visit.visitedAt ?? visit.createdAt;
// Stamps:  format as "MAY·2026"
// Reviews: format as "May 2026"
```

Both stamps and review cards use the existing date formatters in `me.ejs:11-13` and `me.ejs:26-30`. Wrap them in a `visitOrCreated(row)` helper, single source of truth.

### Backfill for existing rows

Two options, depending on appetite:

- **Self-serve** (recommended): the "Edit date" link on each profile card lets you (and any other user with logged visits/reviews) backfill at their own pace. Zero migration code. New visits get correct dates from day one; old ones improve as people touch them.
- **Bulk admin**: a one-shot endpoint at `/api/admin/maintenance/backfill-visit-dates` that takes a CSV (`visitId, visitedAt`) or a `userId, defaultMonth` and stamps rows. Useful only if a specific user has many visits to backfill at once.

Eric specifically said he'll edit his 5+5 entries — self-serve handles this cleanly. No bulk migration needed unless we hit a scale where that changes.

### Why this isn't just cosmetic

Three downstream effects beyond the stamp/card display:

1. **Time-based discovery features later** ("Pizzerias visited in 2026", "Pizza tour map by year", "Most-visited month") need real visit dates, not registration dates. Capturing now means we have data to enable them in a year.
2. **Rank-badge fairness** — the rank computation uses `Review.createdAt` for tiebreakers and freshness signals. Real visit dates make those signals less noisy (a review written today about a visit five years ago shouldn't tiebreak the same way as a fresh visit).
3. **Stamp credibility on the visible profile** — the entire passport metaphor assumes the date is real-world. Without `visitedAt`, the metaphor breaks the moment a user logs a place a year after eating there.

### Roadmap placement

Treat as a **Phase 1 sibling** — small, additive, no SEO dependency. Ships before the rank-badge work in Phase 4 so the dates that feed the ranks are correct. No risk to existing rows because both columns are nullable.

**Effort:** ~half-day total.
- Schema migration: 5 min (two columns)
- Review modal field + server validation: ~30 min
- Visit picker overlay: ~30 min
- Edit-date affordance on profile: ~1h
- Display helper + tests: ~30 min
- Deploy via standard flow (no maintenance dispatch needed — pure additive)

## 10 · References

- [SimilarWeb — goto-where.com](https://www.similarweb.com/website/goto-where.com/)
- [Goto-Where pizza category — pagination sample](https://goto-where.com/categories/pizza-restaurant.html)
- [Sample venue page — Pizzazz NYC](https://pizzazz.goto-where.com/)
- [Sample menu page — confirms "(Menu Suggestions)" disclaimer](https://pizzazz.goto-where.com/menu)
- Internal memory:
  - `feedback_exclusive_list` — no bulk imports
  - `feedback_hostinger_prisma_cli_panic` — backfills via `/api/admin/maintenance`
  - `feedback_gemini_limits` — 1500 RPD cap
  - `feedback_lh3_url_ttl` — photo TTL handling
  - `feedback_mobile_first` — 375px first
  - `project_track2_photos_plan` — gallery sequencing
  - `project_backlink_queue` — backlink tactics queued
  - `project_cloudflare_setup` — CDN config
