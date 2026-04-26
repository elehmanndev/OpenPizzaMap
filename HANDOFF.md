# OpenPizzaMap — Session Handoff (2026-04-27)

## Prod state right now

- **1,460 places, 1,363 visible** on the map across **60+ countries** and ~600 cities. (Total grew by 1 over yesterday — Il Figlio di Emiliano added via the new `scrape-venue.js`.)
- **~1,193 self-hosted hero images** at `/uploads/places/{id}.{ext}` — committed to git (~370 MB) so Hostinger deploys don't wipe them.
- API: `https://openpizzamap.com/api/places` — returns the visible set as JSON. **Doesn't yet surface `openingHours` or the new TripAdvisor fields** (schema has them; serializer needs ~10 LOC update).
- Maintenance gate at `/` still in place per Eric's call.

## Schema changes shipped today (2026-04-26 → 2026-04-27)

```diff
 model Place {
+  openingHours  String?     @db.Text       // schema.org weekly format ("Mo-Sa 12:00-23:00") or JSON if structured
+  enrichedAt    DateTime?                  // last successful enrichment pass — used to skip recently-touched rows
+  tripadvisorLocationId   Int?
+  tripadvisorRanking      String?          // e.g. "#95 of 516 Places to Eat in Sabadell"
+  tripadvisorRating       Decimal? @db.Decimal(2,1)
+  tripadvisorReviewCount  Int?
+  tripadvisorUrl          String?          // attribution link required by TA ToS
+  @@index([tripadvisorLocationId])
 }
```

Applied via `npx prisma db push`. DB columns exist; the schema file in git also reflects them.

## What landed today

### 1. Enricher tool — `scripts/enricher.js`

Single-purpose data-quality + enrichment workhorse. Five phases (validate → dedup → overpass → web → search) that can be run together or in isolation. **Full design + run history in [notes/enricher.md](notes/enricher.md).**

Operationally, today's first run:

| Phase | Result |
|---|---|
| validate | 11 collision points found, **85 places hidden** (city-center fallback victims) |
| dedup | **62 duplicate rows merged** (e.g. London 50 Kalò collapsed from 4 rows → 1 with 4 sources) |
| overpass | **353 places matched** in OSM (27% hit rate), **447 fields filled** (websiteUrl + phone + opening_hours + style hints) |
| web | 23 ok / 146 miss / 471 fail across 640 candidates. 11 hours, 12 styles added |
| search | skipped — DDG-discovery, ~20 min, not exercised yet |

Net DB delta:

| Metric | Before | After | Δ |
|---|---|---|---|
| Total visible places | 1,362 | 1,362 | — |
| With opening hours | 0 | 357 | **+357** |
| With websiteUrl | 466 | 848 | **+382** |
| With phone | 723 | 1,160 | **+437** |
| Total Place rows | 1,521 | 1,459 | −62 (dedup) |

### 2. Per-venue scraper — `scripts/scrape-venue.js`

Cold-start companion to the enricher. Given a name + city, fans out across Nominatim + DDG + the venue's official site (incl. WP REST media + contact-page probes) + RestaurantGuru + carta.menu + (optional) TripAdvisor Content API, and reconciles a complete `Place` create record. **Full notes in [notes/scrape-venue-implementation.md](notes/scrape-venue-implementation.md)** plus the original [spec](notes/scrape-venue-spec.md) and [worked example](notes/scrape-venue-sample-il-figlio-di-emiliano.md).

CLI:

```bash
node scripts/scrape-venue.js "<name>" "<city>" [--country XX]
                                                [--insert]
                                                [--out path.json]
                                                [--with-tripadvisor]
```

First end-to-end run (Il Figlio di Emiliano / Sabadell) reproduced the fixture nearly identically — landed as `Place id=1602` with TA enrichment.

### 3. TripAdvisor Content API integration

- Key in `.env` as `TRIPADVISOR_API_KEY`. Gitignored.
- **Domain restriction quirk**: the key requires `Referer: https://www.openpizzamap.com/` exactly. Without `www.` returns 403 "explicit deny". Pinned in `taFetch`. Documented in [notes/scrape-venue-implementation.md](notes/scrape-venue-implementation.md).
- Persistent budget tracker at `scripts/lib/.tripadvisor-budget.json` (gitignored). 4000 calls/month hard cap, 130/day soft cap. `reserve()` increments + persists *before* every TA HTTP call. Status: 7 calls used yesterday, counter rolled to 0 at midnight today. Details in [notes/lib.md](notes/lib.md).
- ToS compliance: cache up to 30 days, never store reviews, always show attribution link via `tripadvisorUrl`. (UI rendering of attribution is a follow-up task.)

### 4. Shared library — `scripts/lib/`

Refactored helpers used by both `enricher.js` and `scrape-venue.js`:

- `scripts/lib/utils.js` — `normalizeName`, `jaroWinkler`, `haversineM`, `fetchWithTimeout`, `slugify`, `parseSchemaOrgFromHtml`, `inferStylesFromText`, `ddgSearch`, `decodeDdgLink`, `plausibleVenueUrl`, `STYLE_PATTERNS`, etc.
- `scripts/lib/tripadvisor-budget.js` — persistent counter with daily/monthly caps.

Full API in [notes/lib.md](notes/lib.md).

### 5. Importer fixes (yesterday's session, already on prod)

`scripts/import-places.js` now does **fill-only-if-null merging** on duplicates instead of `update: {}` no-op. Existing rows get enriched (image, website, phone, address, postal, region) without ever overwriting populated fields. Coords are explicitly NOT touched after first geocode. Added 429-retry-with-backoff to `nominatimLookup` (15s × attempt cooldown, up to 4 tries).

### 6. Michelin scraper — `scripts/scrape-michelin.js`

Scrapes Michelin Guide pizza listings (74 venues, 12 countries, 38 Bib Gourmand + 3 starred). Distinction (`bib`/`1 star`/`2 stars`/`3 stars`) encoded into `PlaceSource.rank` (1/2/3/4). Already imported and visible.

## Source breakdown (current)

| Source | Count | Visibility | Notes |
|---|---|---|---|
| `avpn` | 750+ | auto-flipped visible | AVPN-certified Neapolitan, 60+ countries |
| `eater` | 203 | auto-flipped visible | 13 city pages, US + London |
| `tasteatlas` | 81 | mixed | original seed, 7 pizza styles |
| `thegreat.pizza` | 99 | mixed | original seed |
| `50toppizza` | 230+ | auto-flipped visible | recovered after Nominatim 429 cooldown |
| `michelin` | 74 | auto-flipped visible | NEW today |
| `manual` | 1 | visible | from `scrape-venue.js --insert` (Il Figlio) |
| `tripadvisor` | 1 | n/a (additive source) | tagged on Il Figlio after TA API enrichment |

## Open items / next-session priorities

### High priority

1. **Surface `openingHours` in the API + UI.** `routes/api.js` (or wherever `/api/places` is built) needs `openingHours` added to the JSON serializer. `views/map.ejs` popup card needs an Hours line. ~10 LOC each.
2. **Render TripAdvisor attribution.** ToS requires it anywhere TA data is shown. If we render `tripadvisorRating` / `tripadvisorRanking` on cards, we must include the TA logo + a link to `tripadvisorUrl`.
3. **Run the search phase of the enricher.** Skipped on the first run. ~20 min. Will discover websites for the ~500 places that still have none, then a re-run of `web` extracts hours from those discovered URLs.

### Medium priority

4. **Editing UI on both sides** — Eric's stated priority. Admin needs `admin_styles.ejs` / `admin_style_edit.ejs`, bulk visibility toggle on `admin_places.ejs`. User side needs audit of `add.ejs`, `suggest_edit.ejs`, `me.ejs`.
5. **More data, ES + IT first** — see [memory/project_es_it_sources](../.claude/projects/C--Users-Eric-OpenPizzaMap/memory/project_es_it_sources.md). Repsol → Gambero Rosso → Pizzerías Top Spain.
6. **Visit / review schema** — the project's actual differentiator. Reddit-style reputation + anti-Karen review prompts. See [memory/project_wishlist](../.claude/projects/C--Users-Eric-OpenPizzaMap/memory/project_wishlist.md).

### Lower priority (queued)

7. **Eater international** — probe `vancouver.eater.com`, `montreal.eater.com`, `toronto.eater.com` for `/maps/best-pizza-*`.
8. **The Infatuation** — Next.js `__NEXT_DATA__` shape, ~10 cities × 20 places.
9. **OSM Overpass bulk imports** — biggest single volume play (5000+). Free, OdbL.
10. **CT Pizza Trail** — fills the empty `new-haven` style page.

### Deferred (don't bring up unless Eric asks)

- Replacing the maintenance gate at `/`.
- AI-generated style/city intros (Gemini queued for `descriptionHtml`).
- Reviews / karma / anti-Karen schema (high-value but big lift).
- MapLibre GL + OpenFreeMap migration.
- ISO-2 standardisation of `Place.country` (currently free text).

## Hostinger ops cheat sheet

**Don't run scripts on Hostinger** — Prisma client is broken there (`PANIC: timer has gone away` on every query). Run scripts on your laptop against prod DB instead, and let `git push` propagate code + images to the server.

If/when Prisma is fixed:
```bash
ssh -p 65002 u975898812@92.113.28.98
cd /home/u975898812/domains/openpizzamap.com/nodejs
export PATH=/opt/alt/alt-nodejs22/root/usr/bin:$PATH
export DATABASE_URL='mysql://...'      # NOT in interactive shell env — copy from hPanel
node scripts/<name>.js
```

Hostinger app dir: `/home/u975898812/domains/openpizzamap.com/nodejs`. Node binaries: `/opt/alt/alt-nodejs{18,20,22,24}/root/usr/bin/node`.

**Security debt**: prod DB password and TripAdvisor API key were both pasted into chat history during these sessions. Eric chose not to rotate either. Worth flagging if it bothers him.

## How a new source lands (the pipeline, 2026-04-27 version)

```
1. Scraper (scripts/scrape-<source>.js)              → JSON file at repo root
2. Add entry to SOURCES in scripts/import-places.js + write normalize<Source>
3. node scripts/import-places.js                      # geocodes + upserts (merge-on-dupe)
4. node scripts/seed-styles.js                        # Place.stylesJson → PlaceStyle
5. node scripts/flip-avpn-visible.js                  # flips trusted-source visible
6. node scripts/download-images.js                    # downloads images locally
7. node scripts/enricher.js --skip=search              # validate + dedup + overpass + web
8. git add public/uploads/places/ && git commit       # commit images + script changes
9. git push                                           # Hostinger auto-deploys
```

Or for a single venue (cold start):

```bash
node scripts/scrape-venue.js "Place Name" "City" --country XX --with-tripadvisor --insert
```

Everything runs locally. Hostinger only hosts the deployed app.

## Useful pointers

- Schema: `prisma/schema.prisma`
- Importer: `scripts/import-places.js` (merge-on-dupe; 429-retry; per-source normalizers)
- Enricher: `scripts/enricher.js` (5 phases) — see [notes/enricher.md](notes/enricher.md)
- Per-venue scraper: `scripts/scrape-venue.js` — see [notes/scrape-venue-implementation.md](notes/scrape-venue-implementation.md)
- Bulk scrapers: `scripts/scrape-{avpn,eater,50toppizza,michelin}.js`
- Image downloader: `scripts/download-images.js`
- Trust-flip: `scripts/flip-avpn-visible.js` (accepts source-list arg; `michelin` is in the default trusted list)
- Shared lib: `scripts/lib/utils.js`, `scripts/lib/tripadvisor-budget.js` — see [notes/lib.md](notes/lib.md)
- Map view: `src/views/map.ejs` + `public/js/map.js`
- Style pages: `src/views/styles.ejs`, `src/views/style.ejs`
- Admin views: `src/views/admin_*.ejs`
- Geocode cache: `geocode-cache.json` (committed)
- Scrape outputs at repo root: `avpn-scrape.json`, `eater-scrape.json`, `50toppizza-scrape.json`, `michelin-scrape.json`, `scrape-result.json`, `tasteatlas-*.json`

## Vision (unchanged)

- Community pizza map. Anti-"Karen reviews".
- Plan: curated scrape + user submissions + reddit-style karma.
- **Hard budget:** domain + Hostinger only. No paid APIs/SaaS/tile keys ever — except TripAdvisor Content API's free tier (4000/mo cap), gated behind explicit `--with-tripadvisor`.
