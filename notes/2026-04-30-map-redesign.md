# 2026-04-30 — Map redesign + visit/favorite + fuzzy search suggest

Vrbo-style split layout for `/map`, persistent visit & favorite per user, search
suggest with city/spot sections. Built on top of the IOPS thumbnail work landed
earlier today (separate note).

## Schema (`prisma db push` against prod DB on Hostinger)

```diff
 model User {
+  visits       Visit[]
+  favorites    Favorite[]
 }
 model Place {
+  visits        Visit[]
+  favorites     Favorite[]
 }
+model Visit {
+  id        Int      @id @default(autoincrement())
+  userId    Int
+  placeId   Int
+  createdAt DateTime @default(now())
+  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
+  place     Place    @relation(fields: [placeId], references: [id], onDelete: Cascade)
+  @@unique([userId, placeId])
+  @@index([placeId])
+}
+model Favorite { ... mirrors Visit + @@index([userId]) }
```

## What shipped

### `/map` rewrite — sidebar split layout

`src/views/map.ejs` + `public/js/map.js` + `public/css/styles.css`:

- **Layout**: 420 px sidebar left, map right (stacks under 900 px).
- **Search bar** with suggest panel that splits results into **Cities** (pizza
  slice icon) and **Spots** (place's hero thumb with outline). Cap 4 cities + 6
  spots so the panel never scrolls. Hidden scrollbar.
- **Sort dropdown**: Popular (default) · Rating · Distance from city · Near me
  · Price ↑ · Price ↓.
- **Style filter**: dropdown with checkboxes (multi-select) showing per-style
  counts. Replaced the chip strip from earlier iteration.
- **Sidebar list** is viewport-bound — it always shows what's visible on the
  map, sorted by the selected criterion. Typing in the search no longer filters
  the sidebar; only suggest. Click a suggestion → `flyToBounds` (city) or
  `setView + openPopup` (spot), and the sidebar updates via `moveend`.
- **Default view**: tries `navigator.geolocation` (zoom 13 + "you are here"
  pulsing dot). Falls back to **Europe-centred view at zoom 4** (`[48, 10]`)
  when denied — better than the previous worldwide fitBounds.
- **Card hover** highlights the corresponding marker (1.25× scale + drop
  shadow). Click flies to it.

### Fuzzy + alias search

- `normalize()` strips diacritics so "munchen" matches "München".
- `SEARCH_ALIASES` map (~30 IT/ES/DE/PT/etc. city pairs) with bidirectional
  entries. Each is OR'd, so "naples" matches a city stored as "Naples" *or*
  "Napoli", without the bug where required-AND caused 0 hits.
- Token-prefix matcher: every query word must be a prefix of some haystack
  word; long tokens (≥5 chars) also do `includes` for typo tolerance.
- **Aliases only apply to city matching**, not spot names — otherwise
  "naples" floods the suggest with every Napoli-named pizzeria worldwide.

### `pickCity` outlier filter

One row in DB (`place 405 — Il Figlio del Presidente`) has city=Naples,
country=Italy but lat/lng of Naples, Florida. Without filtering, clicking the
"Naples" suggestion produced bounds spanning the Atlantic.

Fix: compute median lat/lng of the matched cluster and drop points >0.5°
(~50 km) from it before calling `flyToBounds`. Code-only fix; bad rows in DB
are untouched (4 mis-geocoded Naples rows total — see "Open loops" below).

### Visit + favorite

`POST /api/places/:id/visit` and `POST /api/places/:id/favorite` — both toggle,
session-gated, return new state. `GET /api/places` and `/api/places/:id` now
embed `visitCount`, `viewerVisited`, `viewerFavorited`.

UI:

- **Place page**: `task_alt`-icon "I've been here" pill floating top-right of
  the hero (matches the place-service chip styling). Heart sits inline next
  to the title with a fixed 12 px gap.
- **Sidebar cards on /map**: heart icon top-right of the thumb. Optimistic
  toggle, redirects to `/auth` if not signed in.
- **`/favourites`**: replaced the stub with a grid of cards. Click the heart
  to remove and the card animates out.

### Popular sort

Backed by `visitCount` from the join. Default sort on `/map`. Replaces the
review-count proxy idea — we wait for real check-ins.

## Files touched

```
prisma/schema.prisma                +30  Visit, Favorite models
src/routes/api.places.js            ~80  visit/favorite endpoints + counts
src/routes/pages.js                 ~25  /place + /favourites routes
src/views/map.ejs                   ~30  sidebar shell, suggest, sort, styles
src/views/place.ejs                 ~70  visit/fav buttons + JS toggles
src/views/favourites.ejs            ~40  grid + remove-on-click
public/js/map.js                   ~400  full rewrite of sidebar + suggest
public/css/styles.css              ~400  layout, suggest, fav, visit pill
```

## Open loops

- [ ] **`geoip-country` fallback for default map view** — when browser geoloc
  is denied we fall back to Europe. Add MaxMind GeoLite2 country lookup
  server-side and pass the country code to map.js so it centres on the
  user's country instead. Zero-cost (offline DB, no external API).
- [ ] **Fix mis-geocoded Naples rows** in DB. 4 rows have `city=Naples,
  country=Italy` but lat/lng outside the city: ids `178` (50 Kalò → north
  Italy), `278` (La Caraffa → near Venice), `302` (Antica Pizzeria Da
  Gennaro → Milan), `405` (Il Figlio del Presidente → Naples, FL). The
  outlier filter masks the symptom; data still wrong.
- [ ] **Visit/favorite UI on `/place` for unauth'd users**: currently the
  click hard-redirects to `/auth`. Could swap for a tooltip "Sign in to
  save".

## Verification

- `npx prisma db push --skip-generate` clean against prod DB.
- Local preview server: search "naples" → 1 city (40), 6 spots; click city
  → flyToBounds bbox `14.06, 40.82 → 14.28, 40.93` (correct Napoli proper),
  sidebar shows 38 spots all `Naples, Italy`.
- Console clean across map load, search interactions, visit/fav toggles.
