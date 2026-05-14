---
project: openpizzamap
date: 2026-05-13
tags: [session, openpizzamap, ui, seo]
---

# 2026-05-13 — Country + city page rebuild: cards, map widget, sorter, intros, FAQs, ranking overhaul

← back to [[openpizzamap#Status]]

## Status: NOT SHIPPED — working tree dirty, GitHub account `ericll93` still suspended (ticket #4379194). DB-only writes are live; code changes blocked at the push step.

## TL;DR (for non-technical reading)

**Built the missing country and city pages.** `/country/IT` and `/country/IT/city/milan` used to be near-empty placeholder pages — country was 404'ing entirely because the `Country` table was empty. Now they look and behave like a real travel directory (the user pointed at a Trivago favourites screenshot as the reference). Each city card on the country page shows photo + rating + price + style + review count, the city page itself has a map widget, a sort dropdown, paginated cards, hand-written intro copy, and a 10-question FAQ accordion. Same template works for all 71 countries and all their cities.

**Two big algorithm calls.** First: 71 countries seeded into the `Country` table from city codes already present, unblocking `/country/*` for every country. Second: ranked-top-places switched from "highest rated" to "most reviewed with a 4.0 quality floor". The old ranking buried Da Michele (Naples, 52k reviews, 4.3) under a 177-review 4.8 spot nobody's heard of. New ranking surfaces the famous places people actually search for, while the floor keeps mega-popular tourist traps with sub-par averages out.

**SEO copy: hand-written, not AI-slopped.** Italy intro + 10 FAQs (country page) and Milan intro + 10 FAQs (city page). Eric flagged AI tells on the first draft — em dashes, "punches above its weight", "rewriting what looks like" — I scrubbed all of it. Place names removed from intros and FAQs because places churn; only city / style / neighbourhood links remain. **Memory note `feedback_priorities.md` (which said "don't push SEO") deleted at Eric's instruction — that veto is gone.**

## Highlights

### Country page (`/country/IT`)
- **`Country` table seeded with 71 rows** from distinct city `countryCode` values. Script: `scripts/admin/seed-countries.js`, uses `Intl.DisplayNames` for English names + slugified URLs. Idempotent (re-runnable). Before this, every `/country/:code` was a 404.
- **City cards now ship top-3 places** instead of just a name + count. Each top place is a clickable `.map-sidebar-card` with photo, dark rating badge top-left, name, neutral price + style chips, review count, grey chevron CTA.
- **CTA per card** reads "All pizzerias in {city}" (was "View city"), right-aligned.
- **SEO intro + 10 FAQs for Italy** seeded via `scripts/admin/seed-italy-content.js`. Intro has internal links to all 12 city pages, 4 style pages, the global map. No `/place/*` hrefs — places churn, intro doesn't. FAQs are `<details>` / `<summary>` collapsible (question-only by default, expand to read answer). Em-dash-free, neutral phrasing, bold on real search keywords.
- **Intro fold UI**: 3-line clamp + chevron toggle ("Read more" / "Show less"). No card wrapper — sits inline under H1.

### City page (`/country/IT/city/milan`)
- **H1**: "Discover the best pizza in {city}", `clamp(20px, 6.2vw, 32px)` so it stays single-line on mobile across all city names.
- **Mini-map widget**: 140 px tall, Carto `voyager_nolabels` tiles (no city names, no road names — clean background only), centered "Explore the map" pill CTA. Whole card is a link to `/map`.
- **Sort dropdown** reusing the `.map-sort-*` classes from `/map`. 5 options: Popular, Rating, Near me, Price ↑, Price ↓. Four are server-side via `?sort=` query param; **Near me is client-side** (geolocation + Haversine, reorders the current page's cards in the DOM).
- **Paginated cards**, 10 per page (was 50, then 10 per Eric's call). Pagination links preserve the active sort param. Naples now spans 9 pages, Milan 3.
- **Same `.map-sidebar-card` style as the country page** for visual consistency: photo + rating badge, name, price chip, style chip, review count, chevron.
- **"{N} pizzerias indexed" indicator** sits left of the sort dropdown (was a sub-line under H1, moved per Eric's pen-mark).
- **Card spacing bumped 8 → 16 px** for breathing room.
- **Milan intro + 10 FAQs** seeded via `scripts/admin/seed-milan-content.js`. Intro covers history (Neapolitan migration post-WWII), the 2010s gourmet wave, styles present, key neighbourhoods (Brera, Navigli, Porta Romana, Isola, Porta Venezia), booking norms. FAQs cover history, neighbourhoods, contemporary-pizza definition, cost, booking, near-Duomo, gluten-free, pizza al taglio, late-night.

### Place page (`/place/:id`)
- **opmRating badge repositioned** from inline-with-title to absolute top-right of the title card (`.place-rating-badge--pinned`). New CSS rule in `styles.css`. Title gets `padding-right: 56px` to clear the badge.

### Ranking algorithm
- **Country page top-3 picks**: changed from `opmRating DESC, googleReviewCount DESC` → `total_reviews DESC` (Google + TripAdvisor + Yelp), `opmRating` as tiebreaker, with a **4.0+ rating floor** on the best-available rating (`opmRating ?? google ?? tripadvisor ?? yelp`). Below-floor places skipped for top-3 picks but still counted in the "{N} places" header.
- **City page listings**: same algorithm + floor, applied across all places before pagination. Floor places eligible places at the top of every sort; below-floor places follow after.
- **Real impact (Naples)**: Sotto le Stelle (4.77 / 177 reviews) → Da Michele (4.3 / 52k reviews) at the top. Same for Rome (now Bonci / Baffetto / Roscioli), Milan (Sorbillo branch / Marghe / Starita).

### Memory / preferences
- **Deleted `feedback_priorities.md`** ("DO: editing GUI + pulling more data; DON'T push: maintenance gate, SEO, AI intros") per Eric's instruction. SEO and intros are fair game from now on.
- Index `MEMORY.md` updated to remove the deleted entry's link.

## Bug fixes along the way

- **City route was silently dropping legacy rows.** The handler at `src/routes/pages.js` had a `country: code` filter on the place query (`code` = "IT", `Place.country` stores full names like "Italy"), so any row with `cityId: null` and a name-only `city` match was excluded. Removed the bad filter; now the OR of `cityId` or `city` name match works as originally intended.
- **`placeCount` no longer affected by quality floor.** First pass at the floor change accidentally re-used the filtered array for the header count, dropping cities' "{N} places" number. Split into two maps: `buckets` (unfiltered, drives count) and `topByCity` (filtered + sorted, drives top-3). City page also computes count from the full ranked array, not the page slice.
- **Pagination + sort interaction.** Pagination Next/Previous links now append `&sort=X` when a non-default sort is active. Sort changes always send the user back to page 1.

## Files touched

```
M  public/css/styles.css                       — .place-rating-badge--pinned, .place-header position relative
M  src/routes/pages.js                         — /country/:code + /country/:code/city/:slug rewrites
M  src/views/city.ejs                          — full template rewrite
M  src/views/country.ejs                       — intro fold, FAQ accordion, top-3 cards
M  src/views/place.ejs                         — moved opmRating badge to .place-rating-badge--pinned
?? scripts/admin/seed-countries.js             — 71 countries from city codes (idempotent)
?? scripts/admin/seed-italy-content.js         — Italy intro (5 paragraphs) + 10 country FAQs
?? scripts/admin/seed-milan-content.js         — Milan intro (5 paragraphs) + 10 city FAQs
```

## Still pending

- **Can't ship the code.** GitHub account suspended since 2026-05-12 (see `notes/sessions/2026-05-12-github-account-suspended.md`). Working tree is clean-looking but unpushed; Hostinger auto-deploys on push to main so prod hasn't seen any of this yet. DB seeds (countries, Italy content, Milan content) **are** in prod because they run direct against MariaDB.
- **Other cities and other countries.** Template applies to all of them automatically — they just don't have intros / FAQs yet. Next step is per-city / per-country seed scripts copy-pasted from `seed-milan-content.js` / `seed-italy-content.js`. Italy + Spain are top priority per the geo-priorities memo.
- **FAQ structured data (JSON-LD).** Markup is `<details>` / `<summary>`, which Google indexes for FAQ rich snippets but the schema.org `FAQPage` JSON-LD on top would compete harder. Cheap follow-up.
- **`UK` / `GB` country duplicate.** Seed script wrote both because both codes exist in `City`. Cleanest fix: bulk-rewrite `City.countryCode = 'GB'` where `'UK'`, then drop the `UK` country row. Noted in the country-seed session output.
- **Sitemap rebuild.** New country and city pages won't appear in `/sitemap.xml` until the admin "rebuild sitemap" button runs (or `buildSitemapXml` triggers).

## Verification path

```
/country/IT                 → Italy page, 71 countries clickable, 12 city cards with top-3 each
/country/IT/city/milan      → H1 + map + sort dropdown + 10 cards on page 1 of 3 + FAQs
/country/IT/city/naples     → 88 indexed, top-3 are Da Michele, Sorbillo, 50 Kalò (was 0 famous)
/country/IT/city/milan?sort=rating       → top is Mozzafiato 4.8
/country/IT/city/milan?sort=price-asc    → top is a € place
/country/IT/city/milan?page=2            → cards 11–20
```

DB-only changes (live now):
```
Country rows = 71 (was 0)
Country.introHtml for IT set
City.introHtml for Milan set
Faq rows: 10 country (IT) + 10 city (Milan)
```
