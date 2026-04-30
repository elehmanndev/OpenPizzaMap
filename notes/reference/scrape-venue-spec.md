# scripts/scrape-venue.js — design

Per-venue companion to the bulk `enricher.js` pipeline. Given a name + city,
fan out across free sources and reconcile a complete `Place` record.

## Why a separate script

`enricher.js` operates on rows that already exist in the DB and fills missing
fields. `scrape-venue.js` handles the prior step: building a row from scratch
when a user/admin says "add this place." Same primitives, different entry
point. Both should eventually share helpers via `scripts/lib/`, but to avoid
collision with the in-flight enricher work, the first cut inlines its own
copies of: `normalizeName`, `jaroWinkler`, `haversineM`, `fetchWithTimeout`,
`parseSchemaOrgFromHtml`, `inferStylesFromText`, `slugify`, `canonCity`,
`dedupKey`, `ddgSearch`, `decodeDdgLink`. Refactor to shared lib once the
other session lands.

## CLI

```
node scripts/scrape-venue.js "<name>" "<city>" [--country ES] [--insert] [--out path.json]
```

- Default: prints reconciled JSON to stdout, drops staged hero JPEG into
  `public/uploads/places/_staging-<slug>.jpg`.
- `--insert`: write directly to DB via Prisma (Place + PlaceSource +
  PlaceStyle), then rename staged hero to `{placeId}.jpg` and update
  `heroImageUrl` to the canonical path.
- `--out path.json`: also persist the reconciled JSON to disk for review.

## Pipeline

1. **Nominatim by name + city** (`/search?q=...&format=json&addressdetails=1`).
   If a hit and the result has `class=amenity|tourism` → take coords + structured
   address (street, postcode, region, country). Cache as `nominatimByName`.
2. **DuckDuckGo HTML search** for `"<name>" <city>` → collect first 8 result
   URLs. Keep only those passing `plausibleVenueUrl(url, name, city)` (reuse
   enricher's reject-list of aggregators, but ALSO keep the aggregator URLs
   in a separate `aggregatorUrls` bucket — RestaurantGuru / TripAdvisor /
   carta.menu are useful for JSON-LD).
3. **Fetch candidate URLs in priority order:**
   - Official site (first non-aggregator hit) → parse JSON-LD + WP media library
     at `/wp-json/wp/v2/media?per_page=30` (works for any WordPress install) →
     also probe `/contacto`, `/contact`, `/reserva`, `/menu`, `/la-carta` for
     `tel:` links + address.
   - RestaurantGuru → JSON-LD (priceRange, aggregateRating, geo, image,
     openingHours).
   - TripAdvisor (likely 403 — best-effort, skip on block).
   - carta.menu (address + hours fallback).
4. **Geocode the address** discovered in step 1 or 3 via Nominatim
   (`/search?q=<full address>`) to verify coords. Flag if Nominatim's coords
   differ from any source by >100m.
5. **Reconcile** with this priority per field:
   - `addressLine`, `postalCode`, `region`: official site → Nominatim → JSON-LD
   - `lat`/`lng`: JSON-LD `geo` → Nominatim by address (cross-check, take
     average if within 50m, else flag)
   - `phone`: any `tel:` link → JSON-LD `telephone` → null (acceptable)
   - `openingHours`: official site (most authoritative) → JSON-LD
     `openingHours` / `openingHoursSpecification`
   - `priceLevel`: map JSON-LD `priceRange` (`$`→1, `$$`→2, `$$$`→3, `$$$$`→4)
   - `websiteUrl`: official site URL
   - `instagramUrl`: any `instagram.com/...` link from official site
   - `stylesJson` + style links: `inferStylesFromText` over JSON-LD
     `servesCuisine` + page text + name
   - `dineIn`/`takeaway`/`delivery`: parse JSON-LD `hasMenu` /
     `acceptsReservations` / aggregator presence (Glovo/JustEat hit → true)
   - `heroImageUrl`: WP `Home1*` / OG `og:image` / JSON-LD `image[0]`
6. **SEO fields** (template-derived, no AI):
   - `seoTitle`: `"{name} — {primaryStyle} Pizza in {city}"` (truncate to 60
     chars; drop the style clause first if too long)
   - `seoDescription`: `"{primaryStyle} pizzeria in {city}{address suffix if
     postcode known}. {one-line cuisine signal from JSON-LD if present}."`
     Cap at 160 chars to leave room before the 200-char schema limit.
7. **Hero download**: stream chosen image to
   `public/uploads/places/_staging-<slug>.jpg`. Verify `Content-Type`
   starts with `image/`. Reject if <50KB (likely a placeholder).
8. **Output**: print one JSON object matching the Prisma `Place` create input
   shape, plus `_meta` block with `sources` (array of `{source, url, fields}`),
   `coordDelta` (meters between sources), `warnings`.

## Reconciliation invariants

- Never overwrite a non-null field with null.
- When two sources disagree on hours, prefer the official site silently;
  add to `_meta.warnings` so an admin can review.
- When coords disagree by >100m, set `lat`/`lng` to the Nominatim-by-address
  result and log a warning — that source is the most likely to point at the
  actual street number.
- If no `name` token (4+ chars) appears in the candidate URL or page title,
  abort with a clear "no confident match" error rather than guess.

## Politeness

- Single-flight per host. 1.5s sleep between requests to the same domain.
- User-Agent: `OpenPizzaMap-scrape-venue/0.1 (eric@openpizzamap.com)` — same
  contact email as the rest of the codebase.
- Respect `robots.txt` for any new domain probed (Nominatim and DDG already
  whitelisted by precedent).

## Test fixture

See `notes/scrape-venue-sample-il-figlio-di-emiliano.md` — full reconciled
record built by hand on 2026-04-26 across all the sources the script will
hit. Use as the regression target for the first implementation.

## Out of scope (for v0)

- `descriptionHtml` — handled later by Gemini integration.
- User-submission validation flow — same primitives but different entry point.
- Auto-OSM-contribution when a venue is missing from OSM.

## TripAdvisor Content API (queued — wire in after v0)

Eric created a TripAdvisor Content API key on 2026-04-26. Free tier is 5000
calls/month; we'll budget to 4000 for safety. Wire in as the **fourth source**
in scrape-venue.js, gated behind `--with-tripadvisor` (or env-presence
auto-detect) so the script still runs for anyone without the key.

### Why it's worth it
- Fills `phone` — the one field consistently missing from official sites
  (confirmed: Il Figlio sample has `phone: null` everywhere except potentially
  TA).
- Adds ranking signal (`"#95 of 497 in Sabadell"`) — useful for a future
  ranking-based sort on the map.
- Provides a license-clean photo fallback when the venue's own site has no
  usable hero.
- Gives us award flags (Travelers' Choice, etc.).

### ToS constraints — bake into the implementation
- **Display obligations**: anywhere TA data is shown, must include the TA
  logo + link to the TA listing + attribution. Decision needed: do we display
  TA data on map cards (and accept the branding) or use it internally only
  (validation + phone backfill)?
- **Caching**: most fields cacheable up to 30 days. Reviews must refresh
  every 24h and full review text cannot be stored long-term — so don't
  ingest reviews into the DB; either skip the reviews endpoint entirely or
  proxy it live.
- **Cannot bulk-mirror their database** — TA data must supplement, not
  replace, our own.

### Per-call budget (1262 places baseline)
| Use | Calls/place | One-time | Monthly |
|---|---|---|---|
| Cross-check name → location_id | 1 (search) | 1262 | — |
| Full details (phone, ranking, hours, awards) | 2 (search + details) | 2524 | — |
| Add 1 photo | 3 (+ photos) | 3786 | — |
| Refresh rating + ranking monthly | 1 (details only) | — | 1262 |

One-shot full enrichment fits in ~3800 calls. Steady-state monthly cost
~1262 leaves ~2700/mo headroom for new places, user submissions, re-checks.

### Hard rate-limit — implement before first call
- Persistent counter in `scripts/lib/tripadvisor-budget.json` (or similar)
  with `{month: "2026-04", calls: 0}`. Every call increments; refuse new
  calls past 4000/month.
- Daily soft-cap of 130 calls so a runaway script can't burn the monthly
  budget in one run.
- Shared across scrape-venue.js and the new enricher phase — both read/write
  the same counter file.

### Schema additions (small additive Prisma migration)
```prisma
model Place {
  // ...
  tripadvisorLocationId   Int?
  tripadvisorRanking      String?              // "#95 of 497"
  tripadvisorRating       Decimal? @db.Decimal(2,1)
  tripadvisorReviewCount  Int?
  tripadvisorUrl          String?              // required link-back
}
```
No new model needed — keep it on `Place` directly. Add an index on
`tripadvisorLocationId` for the monthly refresh phase to look up by id.

### Endpoints to use
- `GET /location/search?searchQuery=<name>&searchAddress=<city>&category=restaurants`
  — find location_id (1 call)
- `GET /location/{location_id}/details` — phone, address, ranking_data,
  rating, num_reviews, awards, web_url, hours (1 call)
- `GET /location/{location_id}/photos?limit=1` — 1 hero candidate (1 call)
- **Skip** `/reviews` — caching forbidden, not worth the complexity for v0.

### New enricher phase: `tripadvisor`
Mirrors the existing phases. Targets: places where `tripadvisorLocationId
IS NOT NULL` and `updatedAt < 30 days ago`. Calls `/details` only, refreshes
rating + ranking + reviewCount. ~1262 calls/mo budgeted.

### `.env` plumbing
- Add `TRIPADVISOR_API_KEY=...` to `.env` (keep out of git).
- Add `TRIPADVISOR_API_KEY=` (blank) to `.env.example` so deploys document
  the optional dependency.
