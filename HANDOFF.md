# OpenPizzaMap — Session Handoff (2026-04-26, end of day)

## Vision recap
- Community pizza map; alternative to thegreat.pizza.
- Anti-"Karen reviews" — protect good places from bad-faith ratings.
- Plan: scrape curated sources + user submissions + reddit-style profile karma.
- **Hard budget:** domain + Hostinger hosting only. No paid APIs, SaaS, or tile keys, ever.

## What changed today (the late session)

### Map is no longer empty
- **167 places live** across 34 cities, 6 countries (IT 113, US 44, FR 9, GB ~, ES, AT). All `isVisible: true`.
- Top cities: Rome 26, Naples 21, NYC 14, Florence 11, Milan 11, Bologna 9, Verona 9, Paris 9, Chicago 8, Catania 7.
- Source breakdown via `PlaceSource`: 99 thegreat.pizza, 68 tasteatlas (one Trianon-style entry collapses two TasteAtlas lists into a single source row, but its `Place.stylesJson` carries both styles).

### Importer landed: `scripts/import-places.js`
- Reads 8 JSON files (`scrape-result.json` + 7 `tasteatlas-*.json`), normalizes per-shape, dedupes by `slugify(name)+'|'+slugify(canonicalCity)`.
- Country/city canonicalization tables baked in (Italia→Italy/IT, Roma→Rome, Wien→Vienna, Regno Unito→GB, etc.). City matching is by canonical English name.
- Geocoding: Nominatim, 1.1s/req, multi-strategy fallback per place (try `addressLine` alone → `addressLine + country` → `head + city + country` → `city + country`). User-Agent set per their TOS.
- Cache file: `geocode-cache.json` (committed, useful for reproducibility — 229 entries currently). Errors → `import-errors.json` (gitignored).
- Idempotent on re-run: slug `name-city` is stable; existing rows are upsert-no-op.
- Flags: `--dry-run`, `--no-geocode`, `--limit N`.

### Bug fixed: map crashed on country names
- `formatAddress` in [public/js/map.js:109](public/js/map.js:109) called `Intl.DisplayNames({type:'region'}).of(p.country)` which throws on non-ISO strings. Both the seed AND every imported row store country as a name (`"Italy"`, `"United States"`), so the popup card never rendered → API errors → markers never drew.
- Fix: only call `.of()` when `p.country` matches `^[A-Za-z]{2}$`.

### Maintenance / housekeeping
- Scratch JSON files deleted (`chicago-extract*.json`, `chicago-raw.json`, `tasteatlas-traditional-italian-raw.json`).
- `.gitignore` now excludes `import-errors.json` and `import-log.txt`.

### Pizza styles became real categories
The bigger structural addition this session.

**Schema (`prisma db push`, additive):**
- New `Style` model — `id, slug (unique, varchar 40), name, shortLabel, introHtml, heroImageUrl, seoTitle, seoDescription, isVisible, sortOrder, createdAt, updatedAt`.
- New `PlaceStyle` join — `(placeId, styleId)` composite PK, cascade on either side. Many-to-many.
- `Place.styles PlaceStyle[]` relation added.

**Taxonomy (12 styles, 11 visible + `italian` deprecated/hidden):**
`neapolitan, romana, contemporanea, ny, new-haven, detroit, chicago, al-taglio, sicilian, apulian, padellino, focaccia-recco`.

Distribution after re-tagging: neapolitan 47, contemporanea 33, ny 20, romana 17, detroit 10, apulian 9, chicago 9, sicilian 7, al-taglio 6, new-haven 5, padellino 4, focaccia-recco 0 (slot reserved). Total 167 PlaceStyle rows / 167 places.

**Migration scripts (in `scripts/`):**
- `seed-styles.js` — upserts the 7 original styles + walks `Place.stylesJson` → creates `PlaceStyle` rows. Idempotent.
- `tag-thegreat-styles.js` — first-pass heuristic for the 99 untagged thegreat.pizza places (city + name regex; default `italian`).
- `retag-italian-specific.js` — adds the 6 new styles, walks every place currently `italian`, replaces with regional/specific tag (Rome → romana, Catania/Palermo → sicilian, Bari/Lecce → apulian, Turin → padellino, Genoa → neapolitan, Florence/Bologna/Milan/Verona → contemporanea, with per-ID overrides). Hides `italian` style at end.

**Routes / API:**
- `GET /styles` — index page listing all visible styles + place counts. Card grid.
- `GET /style/:slug` — landing page for one style: title, intro, list of places. Mirrors `/country/:code/city/:slug` pattern.
- `GET /api/places?style=<slug>` — filters places by style relation.
- `/api/places` and `/api/places/:id` now also include a flat `styles[]` array on each place: `[{ slug, name, shortLabel }, ...]`. Take limit bumped 200 → 1000.

**UI:**
- Map popup card now shows clickable green chips per style (e.g. `[Neapolitan]`) under the address line, linking to `/style/<slug>`. CSS in `public/css/styles.css` (`.ppc-styles`, `.ppc-style-chip`).
- `summaryFor` simplified — style is now in the chip, no longer in the prose summary.

**EJS views added:**
- `src/views/styles.ejs` — index.
- `src/views/style.ejs` — single style.

**Known minor follow-ups specific to styles:**
- No admin CMS yet for editing `Style.introHtml`, `seoTitle`, `seoDescription`, `heroImageUrl`. Mirrors City CMS; ~30-min follow-up.
- A few `sortOrder` collisions (e.g. al-taglio + romana both at 3) make the index alphabetic-as-tiebreaker. Tweak when it matters.
- Verona modern spots (i Tigli, Saporè) all currently `contemporanea`. Could split out `gourmet`/`degustazione` later.
- `Place.stylesJson` column kept as denormalized cache; can be dropped once nothing reads it (map.js still falls back to it but only if `p.styles` is empty).

## Known issues / debt

### Address display is ugly for some imports
Popup address rows for thegreat.pizza imports often double-print the city/postal because the raw `addressLine` already contains them, e.g.:
```
Via Alessandro Scarlatti, 84, 80129 Napoli NA, 80141 Naples NA, Italy
```
Pre-existing display logic in `formatAddress` joins `addressLine + cityLine + country` with no de-dup. Worth a small rewrite of `formatAddress` to detect when `addressLine` already contains the postal/city tokens.

### Country stored as name, not ISO code
Schema-wise `Place.country` is free text and we now have a mix of `"Italy"`, `"United States"`, etc. Nothing else uses it for routing (city→country via `City.countryCode`), but it's inconsistent with `City.countryCode` and creates the `Intl.DisplayNames` footgun. If we standardise: also rewrite the seed Sorbillo row and rerun importer (idempotent — won't dup).

### 26 ungeocoded places
Full list in `import-errors.json`. Mostly TasteAtlas Italian small-town entries with sparse street data (e.g. `"Via Cesare Sersale"` no number). Options:
- Hand-fix obvious ones in Prisma Studio.
- Add a TasteAtlas detail-page scrape pass (the slug → detail page may have lat/lng or richer address).
- Try Nominatim with the place name as a "named POI" search (`q=Trianon Naples Italy`, `featuretype=settlement`).

### `prisma db push` vs migrations
Schema diverged from migration history (NewsletterSignup + PlaceSource were `db push`-ed). Hostinger's MariaDB user can't create the shadow DB `migrate dev` needs. Either get a DDL-capable user, or keep evolving via `db push`.

## What's still pending from before today

### Product
- **Replace maintenance gate at `/`** — landing actively turns away visitors while `/map` works *and* now has real data. A landing with map peek + CTA would unblock SEO + traffic. Eric still wants maintenance for now, but the gate is more wasteful than it was 24h ago.
- **Imagery sourcing** for places without `heroImageUrl` — TasteAtlas-only imports are missing them. Mapillary (free w/ key), Wikimedia Commons, manual upload all on the table.
- **AI summary inference** — Gemini free tier or Groq for `descriptionHtml` generation at moderation time. Hallucination risk → only feed structured facts, allow admin edit.
- **MapLibre GL + OpenFreeMap** migration for vector tiles (custom water color, Outfit font on labels). Bigger refactor, deferred.

### Data quality next steps
- **Fix the popup address de-duplication** (cleanup item above).
- **Standardise `Place.country`** to ISO2 (decision: do it or leave alone).
- **Backfill the 26 missed geocodes**.
- **Style CMS** — admin views to edit Style intro/SEO/hero (mirrors `admin_city_edit.ejs`). The 11 visible styles all have empty intro HTML right now.
- **Per-place style refinement** — current tags came from heuristics; user-suggested edits via existing submission flow could let the community correct them.

### Reviews / karma
- Schema still not extended. Reddit-style karma + anti-Karen design rules still unspecified.

## Useful pointers
- Layout: `src/views/layout.ejs`
- Map view: `src/views/map.ejs` + `public/js/map.js`
- Auth view: `src/views/auth.ejs`
- Maintenance: `src/views/maintenance.ejs`
- Places API: `src/routes/api.places.js`
- Auth API: `src/routes/api.auth.js`
- Notify API: `src/routes/api.notify.js`
- Email service: `src/services/email.js`
- Schema: `prisma/schema.prisma`
- Page routes (incl. /style, /styles, /city, /country): `src/routes/pages.js`
- Style index view: `src/views/styles.ejs`
- Single-style view: `src/views/style.ejs`
- **Importer: `scripts/import-places.js`** — re-runnable; reads cache, won't re-hit Nominatim or duplicate rows.
- **Style migration: `scripts/seed-styles.js`** + **`scripts/tag-thegreat-styles.js`** + **`scripts/retag-italian-specific.js`** — run in that order on a fresh DB.
- **Errors file: `import-errors.json`** at repo root (gitignored) — review-and-fix list.
- **Cache file: `geocode-cache.json`** at repo root (committed) — 229 query→coord entries.

## Auth + maintenance landing reference (unchanged, here for continuity)

### Auth — single magic-link flow
- One entry: **`/auth`** (email + Google OAuth). Old routes (`/login`, `/register`, `/forgot`, `/reset`, `/set-password`) all 301 to `/auth`.
- Token TTL 30 min, sha256-hashed at rest. Magic-link copy diverges for new vs returning.
- Email template: brand green CTA, no decorative bar, no outer cream panel.

### Maintenance landing (`/`)
- Animated pizza-slice background, collision-detected, 9–18s float loop, `prefers-reduced-motion` respected.
- Card: warm off-white (`#fdfaf3`), green outline, green-tinted shadow.
- Pill email form → POST `/api/notify` → upserts `NewsletterSignup` (`email` unique, `source = "maintenance"`).

### Map (`/map`)
- Three Leaflet raster basemaps in top-right layer picker: Voyager (default), Positron, Esri Satellite.
- Marker cluster group (leaflet.markercluster). Pizza emoji 🍕 markers scale with zoom (22px → 56px).
- Place card popup: hero image with rating chip overlay, name, directions link, summary, full-width green CTA to the place profile.
- Loads from `/api/places` (no params → returns all `status=active, isVisible=true`).
