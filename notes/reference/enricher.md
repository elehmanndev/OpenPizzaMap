# scripts/enricher.js — design + operational notes

The enricher is OpenPizzaMap's data-quality workhorse. It runs over rows
that already exist in the DB and fills missing fields — the opposite of
[scrape-venue.js](scrape-venue-implementation.md), which adds rows from
scratch.

## Phases (run sequentially; each can be skipped or run in isolation)

```bash
node scripts/enricher.js                       # all phases
node scripts/enricher.js --phase=validate
node scripts/enricher.js --phase=dedup
node scripts/enricher.js --phase=overpass --limit 50
node scripts/enricher.js --skip=search         # all except search
```

`--phase=NAME` runs one phase. `--skip=a,b` runs all except those.
`--limit N` caps each phase to N rows for testing.

### 1. validate

Identifies places stuck on **city-center fallback coords** — multiple
unrelated venues stacked at the same exact `lat,lng`. Hides them
(`isVisible=false`) until they get a real address.

How: groups all rows by `(lat,lng)` string-key. Any coord shared by ≥3
unrelated places is flagged as a fallback hit. We don't try to fix the
coord — just hide the row so the map stops lying.

The bug this fixes was introduced by `geocodeQueries()` in
`scripts/import-places.js`, which used `[city, country]` as the last
geocode strategy when a street address didn't resolve. Nominatim returned
the city centroid for every such fallback, stacking dozens of pizzerias
on one pin (e.g. 25 venues at exactly `40.8358846, 14.2487679` for
Naples).

First run on 2026-04-26 found **11 collision points across 11 cities**
(Naples 25, Rome 21, Milan 7, Florence 6, London 6, Caserta 4,
Copenhagen 4, Aversa 3, Cagliari 3, Brussels 3, Helsinki 3) — **85
visible places hidden.**

### 2. dedup

Finds and merges nearby duplicates: any pair of places within 100m AND
with normalized-name similarity (Jaro-Winkler) ≥ 0.85 are unioned into
one canonical row.

How:
- Index every place into a ~110m grid (`Math.round(lat*1000), Math.round(lng*1000)`).
- For each cell, compare every place against every place in the same +
  8-neighbour cells.
- Build connected components via union-find on pairs that pass both
  tests.
- For each cluster (size ≥ 2), pick canonical = highest source-count
  (ties → lowest id), then merge:
  - **Fill-only-if-null** patch on `addressLine`, `region`, `postalCode`,
    `phone`, `websiteUrl`, `heroImageUrl`, `openingHours`.
  - **Union** styles via `stylesJson` and `PlaceStyle` rows.
  - **Move** all loser `PlaceSource` rows onto canonical (upsert).
  - **Delete** loser `Place` rows. Cascades clean up `PlaceStyle` /
    `PlaceSource`.
  - Coords on canonical are NEVER overwritten — once geocoded, they stay.

First run found **62 merge clusters**, deleting 62 duplicate rows. The
case that motivated the design was 50 Kalò: scattered across 7 rows
(Naples × 2, London × 4, Rome × 1) because each scraper spelled the name
differently — `50 Kalò` vs `50 Kalò di Ciro Salvo` vs `50 Kalò (Londra)`
vs `50 Kalò di Ciro Salvo Pizzeria London`. After dedup, London became
**one row with 4 sources merged** (avpn + 50toppizza/rank-3 +
eater/rank-9 + thegreat.pizza), full address/phone/website/image,
neapolitan style. See HANDOFF.md for the full case study.

### 3. overpass

Per-place query to the OpenStreetMap Overpass API to fill missing
`websiteUrl`, `phone`, `opening_hours`, and cuisine-derived styles.

Query (issued POST to one of three endpoints with failover):

```
[out:json][timeout:20];
(node(around:600,LAT,LNG)[amenity~"restaurant|fast_food|cafe|bar|pub"];
 way(around:600,LAT,LNG)[amenity~"restaurant|fast_food|cafe|bar|pub"];);
out tags center;
```

The matcher (`pickOsmMatch`) accepts a candidate if either:

- (a) Jaro-Winkler ≥ 0.7 on full normalized names, OR
- (b) The **first** 4+ char token of the venue name appears verbatim in
  the candidate's normalized name.

Requiring the *first* token guards against false positives where the
venue happens to share a generic word with a neighbour ("Salvatore alla
Riviera" matching "Gran bar Riviera" because both contain "riviera").
The first distinguishing token is almost always the brand/owner/proper
noun — Mattozzi, Sorbillo, Kalò, Ciro.

Free-tier Overpass; no key. Polite delay 1.2s/request, 600m radius
catches AVPN coords that drift by ~300-500m from the true storefront.

### Matcher iterations on 2026-04-26

| Version | Radius | Threshold | Hit rate (15 famous Naples AVPN) | Notes |
|---|---|---|---|---|
| v0 (initial) | 250m | JW ≥ 0.7 | **0%** | Coords drift exceeded radius; threshold too strict |
| v1 (looser) | 500m | JW ≥ 0.7 OR any-token-hit | 73% (11/15) | False positive: "Riviera" matched a generic neighbour |
| v2 (current) | 600m | JW ≥ 0.7 OR FIRST-token-hit | 73% (11/15), no false positive | The "first significant token" heuristic |

Full bulk-run hit rate on 2026-04-26: **353/1314 = 27%**, **447 fields
filled** (websiteUrl + phone + opening_hours + style hints), **0
failures**. Florence's long tail of obscure venues runs at near-0%
because OSM doesn't have them; famous Naples / Tokyo / NYC venues
hit much higher.

### 4. web

For places that already have a `websiteUrl` but are missing
`openingHours` or styles, fetch the homepage and parse:

- `<script type="application/ld+json">` Restaurant / FoodEstablishment /
  LocalBusiness blocks
- `openingHours` strings + `openingHoursSpecification` arrays
- `servesCuisine` for style inference
- Plaintext keyword scan for style names ("Neapolitan", "Detroit",
  etc.)

First run: 640 candidates → 23 ok / 146 miss (no schema.org) / 471 fail
(HTTP errors, TLS errors, geo-blocks, dead sites). 11 places gained
hours, 12 gained styles. Low yield because small-restaurant homepages
are operationally fragile — most don't have JSON-LD, many are
unreachable.

### 5. search

For places with NO `websiteUrl`, run a polite DuckDuckGo HTML search
(`html.duckduckgo.com/html/?q=...`) and adopt the first non-aggregator
result that contains a name token. Then the next enricher run's `web`
phase can extract hours/style from the discovered URL.

Pace: 2.5s/request. 500+ candidates × 2.5s ≈ 20 minutes. DDG sometimes
serves a CAPTCHA page if pushed too hard — back off and retry next day.
Skipped on the 2026-04-26 first run; not yet exercised.

## Operational state on prod (2026-04-27)

Database after running validate + dedup + overpass + web:

| Metric | Before | After | Δ |
|---|---|---|---|
| Total visible places | 1,362 | 1,362 | — |
| With opening hours | 0 | 357 | **+357** |
| With websiteUrl | 466 | 848 | **+382** |
| With phone | 723 | 1,160 | **+437** |
| `enrichedAt` set | 0 | 444 | — |
| Total Place rows | 1,521 | 1,459 | **−62** (dedup) |

The API at `/api/places` doesn't surface `openingHours` yet — the field
is in the DB but not in the JSON serializer. Place card UI also doesn't
render hours. Both are small follow-up tasks (probably ~10 LOC each in
`routes/api.js` + `views/map.ejs`).

## Reusing the helpers

All cross-script helpers live in [scripts/lib/utils.js](../scripts/lib/utils.js).
See [lib.md](lib.md) for the API.

## Known limitations

- **Web phase fail rate ~73%** on first run. Many small-restaurant homepages
  are unreachable or lack JSON-LD. Consider adding Wikidata SPARQL as a
  fourth tier between `overpass` and `web`.
- **OSM matcher false negatives** when the venue uses a different name in
  OSM than in our DB. e.g. "Pizzeria Trianon da Ciro" → "Pizzeria
  Trianon" (matches), but "Alba" → ??? (no match — too short to find a
  distinguishing token).
- **No re-run idempotency tracking** beyond `enrichedAt`. A re-run will
  re-query OSM/web for any place still missing fields, which is fine for
  Overpass but slow for the search phase.
