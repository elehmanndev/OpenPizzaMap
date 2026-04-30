# 2026-04-27 — Place page UI overhaul + admin edit expansion

Session goal: while enricher runs in background, polish the **public place page**
(`/place/:id`) and the **admin place edit form** (`/admin/places/:id`). Test target
was `place 1602` — Il Figlio di Emiliano, Sabadell.

## What shipped (code changes only — no schema migration done)

### Public place page (`src/views/place.ejs`)

- **Hero image** at the top, full-bleed (`/uploads/places/<id>.jpg`).
- **Header card** lifted over the bottom of the hero, contains:
  - Title + address
  - Pill row: price (€€ filled, €€ faded), pizza style chip(s), service icons
  - Black square **9.7 OPM rating badge** on the right (mirrors the map card style).
    Currently hardcoded — replace once `Place.opmRating` exists.
- **Opening hours** section, parsed and **collapsed** ("Mon–Fri 13:00–17:00, 19:00–23:00",
  "Sat–Sun 13:00–00:00"). Today-highlight removed (no timezone data yet).
- **Description** card. Falls back to Lorem Ipsum placeholder when `descriptionHtml`
  is null — to be filled by Gemini later.
- **Action buttons** with proper icons: Website (globe), Instagram (brand SVG),
  Directions (`directions`), Phone (`call`). Renders only when each URL exists.
- **Reviews** section with multi-platform tiles. Sorted by normalized rating desc,
  then review count. Currently:
  - TripAdvisor — read from existing `tripadvisor*` columns
  - Google — **hardcoded for place id=1602 only** (rating 4.5, 2852 reviews,
    scraped via Playwright on 2026-04-26). Look for the `place.id === 1602` block.
- **"Are you the owner? — Claim this place"** CTA card (monetization-ready).
  Button currently routes to `/place/:id/suggest-edit` as a placeholder.
- **Service pills** (5 chosen): Dine-in, Takeaway, Delivery, Reservations,
  Outdoor seating. Reservations + Outdoor seating are **forced on** as
  placeholders since the schema columns don't exist yet (TODO comment in source).

### Admin place edit (`src/views/admin_place_edit.ejs`, `src/routes/pages.js`)

- Form expanded from 4 fields (slug, hero, visible, description) to **all** Place
  fields the enricher writes: name, address line, city, region, postal, country,
  lat/lng, website, instagram, google maps, phone, price level, dine-in/takeaway/
  delivery, opening hours, styles (multi-checkbox + mirror to legacy `stylesJson`),
  hero, description (Quill), SEO title/description, visibility.
- TripAdvisor block surfaced read-only.
- POST handler updates Place + replaces PlaceStyle rows in a transaction.
- Visual: green-accented sectioned form (`.admin-section` cards), sticky **Save
  changes** bar at bottom, pizza-pattern background suppressed via
  `bodyClass: "admin-page"`.

### Dev environment plumbing

- `src/middleware/auth.js`: `requireAdmin` now bypasses the role check when
  `DEV_ADMIN_BYPASS=1` and synthesizes a session admin user. Hostinger reads
  `.builds/config/.env`, so this never triggers in prod. Var is set in
  `.env.local` (gitignored).
- `src/app.js`: added `app.use("/uploads", express.static(...))` so
  `/uploads/places/<id>.jpg` resolves in dev (prod's web server already handled it).
- `src/views/layout.ejs`: upgraded Material Symbols Rounded font URL to the
  variable-axis version (`opsz,wght,FILL,GRAD@…`) so we can force `FILL=0` and
  `wght=300` for thinner outline icons.

### CSS additions (`public/css/styles.css`)

All scoped to `.admin-page` and `.place-page` — no impact on other views:

- `.admin-section`, `.admin-form`, `.field`, `.field-grid`, `.style-chips`,
  `.admin-actions` (sticky), `.admin-readonly`, plus Quill border overrides.
- `.place-hero`, `.place-shell`, `.place-header`, `.place-rating-badge`,
  `.place-meta`, `.place-price` (with `__on` / `__off` halves), `.place-style-chip`
  (now span, neutral-style), `.place-service` (with `__svg` for inline SVGs),
  `.place-hours__list/row/day/ranges`, `.place-reviews__grid/place-review`,
  `.place-actions/place-action` (`--instagram` brand-color hover),
  `.place-claim` (gold disc + linear-gradient bg), `.place-faq`, `.place-footer`.
- All four header pills (price, style, service ×2) unified to
  `padding: 7px 14px`, `font-size: 13px`, `font-weight: 500`, `line-height: 1.2`,
  same background/border. Heights match within 0.5px.

### Custom inline SVGs

- **Instagram brand** icon — official simple-icons path. In `place.ejs` action button.
- **Pizza-box stack** — three staggered closed boxes for Takeaway. After two
  failed iterations (open-box version too busy, tight-stack version too crowded).
  In `place.ejs` services block.

## What's hardcoded / faked and needs real data

| UI element                        | What's faked                          | How to make it real                                        |
| --------------------------------- | ------------------------------------- | ---------------------------------------------------------- |
| 9.7 OPM badge                     | Hardcoded constant                    | Add `Place.opmRating` + compute fn (see plan below)         |
| Google review tile                | Inline `if (place.id === 1602)` block | Add `googleRating` / `googleReviewCount` / `googleUrl`     |
| Reservations service pill         | Always rendered                       | Add `Place.reservations` Boolean, gate on it               |
| Outdoor seating service pill      | Always rendered                       | Add `Place.outdoorSeating` Boolean, gate on it             |
| Description fallback              | Lorem ipsum                           | Gemini-generated `descriptionHtml`                          |
| "Claim this place" CTA            | Routes to `/suggest-edit`             | Build claim flow + `Place.claimedByUserId`                  |

## Schema plan (proposed, not applied)

Adding to `model Place`:

```prisma
// Multi-platform reviews
googleRating       Decimal?  @db.Decimal(2,1)
googleReviewCount  Int?
googleUrl          String?
yelpRating         Decimal?  @db.Decimal(2,1)
yelpReviewCount    Int?
yelpUrl            String?

// New service flags
reservations       Boolean   @default(false)
outdoorSeating     Boolean   @default(false)

// OpenPizzaMap composite score
opmRating          Decimal?  @db.Decimal(3,1)
opmRatingSource    String?   @db.VarChar(20)   // "external" | "community" | "blend"
```

Optional / future:
```prisma
timezone             String?                       // IANA tz, only if "open now" returns
claimedByUserId      Int?                          // ties to User for Claim flow
descriptionSource    String?   @db.VarChar(20)   // "gemini" | "manual" | "scrape"
descriptionUpdatedAt DateTime?
```

All nullable / defaulted → safe additive `prisma db push` on Hostinger.

## Pipeline plan (after schema)

Order of work — each step un-fakes one of the rows in the table above:

1. **Push schema columns** (one Prisma migration).
2. **Admin checkboxes** for `reservations` and `outdoorSeating` so we can
   populate by hand for hero places. Should take 5 minutes inside
   `admin_place_edit.ejs` + the POST handler.
3. **Google enricher phase**. Playwright nav to `https://www.google.com/search?q="<name> <city>" pizza`,
   extract the right-rail `aggregateRating` panel. Cache 30+ days. Fills
   `googleRating` / `googleReviewCount` / `googleUrl`. Then drop the hardcoded
   `place.id === 1602` block from `place.ejs`.
4. **OPM rating function**. Pure fn of stored fields:
   - normalize each platform to /10
   - weighted avg by `sqrt(reviewCount)` so volume matters
   - clamp 1.0–10.0, 1 decimal
   - call after any source-rating change; later blend in community Visit/Review score
   - replace `9.7` literal with `place.opmRating ?? '—'`.
5. **Gemini description generator**. Script that takes `(name, city, styles, rating snippet)`
   → 2-paragraph `descriptionHtml`. Run once per place; store source + timestamp;
   skip placeholders.
6. **Amenities scraper**. TripAdvisor's "Amenities" block lists outdoor seating
   and reservations; OSM Overpass tags (`outdoor_seating=yes`, `reservation=*`)
   as fallback. Fills `reservations` / `outdoorSeating`.
7. **Yelp** — last priority, ES/IT coverage is thin; same shape as Google.

## Open design questions for next session

- **Claim this place** flow: who does it go to? Email a verification link to the
  domain in `websiteUrl`? Manual review? Stripe later for paid claim tier?
- **Composite rating formula**: where does the OPM community score (Visit/Review
  loop from `project_wishlist.md`) plug in once it exists? Maybe 70% external /
  30% community when both present, all-external otherwise.
- **Timezone**: enricher could compute via `tz-lookup` (npm, ~120kb static data
  table) once if we ever revive "open now". For now skipped per Eric.

## Files touched this session

- `src/views/place.ejs` — full rewrite
- `src/views/admin_place_edit.ejs` — full rewrite
- `src/views/layout.ejs` — Material Symbols variable font URL
- `src/routes/pages.js` — `GET /admin/places/:id` includes styles + allStyles;
  `POST /admin/places/:id` accepts all Place fields and replaces PlaceStyle rows;
  `GET /place/:id` includes styles join
- `src/middleware/auth.js` — `DEV_ADMIN_BYPASS` escape hatch
- `src/app.js` — `/uploads` static mount
- `public/css/styles.css` — admin + place page styles appended
- `.env.local` — `DEV_ADMIN_BYPASS="1"` (gitignored)
