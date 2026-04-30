# scripts/scrape-venue.js — implementation notes

Companion to [scrape-venue-spec.md](scrape-venue-spec.md). Captures what
shipped, where the implementation diverges from the spec or fixture, and
operational quirks discovered during the first end-to-end run on
2026-04-26.

Status: **v0 shipped** — both `--insert` and `--with-tripadvisor` paths work.
Test fixture (Il Figlio di Emiliano / Sabadell) reproduces nearly identically.

## CLI

```bash
node scripts/scrape-venue.js "<name>" "<city>" [--country XX]
                                                [--insert]
                                                [--out path.json]
                                                [--with-tripadvisor]
```

- Default: prints reconciled JSON to stdout, drops staged hero JPEG to
  `public/uploads/places/_staging-<slug>.jpg`. No DB writes.
- `--insert`: writes Place + PlaceSource(`manual`) + (optionally
  PlaceSource(`tripadvisor`)) + PlaceStyle rows; renames staging hero to
  `{placeId}.jpg`; sets `heroImageUrl=/uploads/places/{id}.jpg`.
- `--out path.json`: also persists the reconciled JSON to disk.
- `--with-tripadvisor`: enables TripAdvisor Content API enrichment. Auto-
  enabled if `TRIPADVISOR_API_KEY` is in `.env`. Without the key the script
  still produces a working record from free sources alone (sample fixture
  passes without TA).

## Source priority (final)

```
addressLine: official JSON-LD > nominatim-by-name > contact-page heuristic
             > RestaurantGuru > carta.menu                         (noise-stripped)
postalCode:  contact-page regex > official JSON-LD > nominatim-by-name
             > RestaurantGuru > nominatim-by-address
region:      official JSON-LD > RestaurantGuru > nominatim-by-address
             > nominatim-by-name
lat/lng:     primary = first JSON-LD geo (official > RG > carta.menu)
             cross-check Nominatim-by-address; average if within 50m,
             else use Nominatim and warn if delta > 100m.
phone:       contact-page tel: > official JSON-LD > RG > TripAdvisor API
openingHours: official JSON-LD > RG JSON-LD > carta.menu JSON-LD
priceLevel:  official > RG > carta.menu (TA last; sample noted TA's
             $$$$ contradicts the actual menu)
heroImage:   WP Home1*/Hero*/Banner* > og:image > JSON-LD image[0]
             > RG image
```

`fillIfEmpty` semantics throughout: never overwrite a non-null with null.

## Politeness

- Single-flight per host: a `_hostInflight` Map blocks parallel requests to
  the same domain.
- 1.5s minimum between request *starts* on the same host (see
  `_hostLastFetch`).
- User-Agent: `OpenPizzaMap-scrape-venue/0.1 (eric@openpizzamap.com)`.
  Same contact email as the rest of the codebase.

## TripAdvisor Content API quirk — the `www.` requirement

The user's TA key is restricted to `www.openpizzamap.com`. **Both the `www.`
prefix AND the `https://` scheme are required** in the `Referer` header.
Without `www.` the API returns:

```json
{ "Message": "User is not authorized to access this resource with an explicit deny" }
```

Confirmed via direct probe on 2026-04-26:

| Referer header | Result |
|---|---|
| `https://openpizzamap.com` | 403 explicit deny |
| `https://openpizzamap.com/` | 403 explicit deny |
| `openpizzamap.com` | 403 explicit deny |
| _(no Referer)_ | 403 explicit deny |
| `https://www.openpizzamap.com` | **200** |
| `https://www.openpizzamap.com/` | **200** |

`scripts/scrape-venue.js`'s `taFetch` always sets
`Referer: https://www.openpizzamap.com/`. If TA is ever re-keyed for a
different domain the constant in `taFetch` needs to change to match.

## Diff vs Il Figlio fixture

Run on 2026-04-26 with `--with-tripadvisor`:

| Field | Sample | Actual | Notes |
|---|---|---|---|
| name, city, country, slug | match | match | ✓ |
| dineIn, takeaway, status, isVisible | match | match | ✓ |
| addressLine | `Carrer Mare de Déu de les Neus, 6` | same | ✓ |
| postalCode | `08202` | `08202` | ✓ via contact-page regex (`08202, Sabadell`) |
| region | `Catalunya` | `Catalonia` | ≈ Nominatim returned the English form |
| lat | `41.5505361` | `41.5506027` | spec rule averages with Nominatim when ≤50m apart; sample was opinionated and trusted RG outright |
| lng | `2.1077053` | `2.107824` | same reason |
| priceLevel | `2` | `2` | ✓ from RG `$$` |
| stylesJson | `["neapolitan"]` | same | ✓ |
| delivery | `true` | `false` | sample inferred true; we only set true on Glovo/JustEat/Deliveroo URL hits in DDG (none surfaced) |
| phone | `null` | `null` | ✓ TA `details` confirms no phone exists for this venue (uses email only) |
| websiteUrl | `https://ilfigliodiemiliano.com` | with trailing `/` | ≈ cosmetic |
| instagramUrl | match | match | ✓ |
| openingHours | `Mo-Fr 13:00-16:30,19:00-23:30; Sa-Su 13:00-24:00` | RG's per-day form | ≈ official site has no JSON-LD hours; we fell back to RG per spec |
| seoTitle | match | match | ✓ |
| seoDescription | hand-curated 150-char | template `Neapolitan pizzeria in Sabadell (08202).` | ≈ Gemini's job per spec |
| **TA fields** (with `--with-tripadvisor`): | | | |
| tripadvisorLocationId | n/a in sample | `26872499` | new |
| tripadvisorRanking | n/a | `#95 of 516 Places to Eat in Sabadell` | sample mentioned `#95 of 497`; counts drift over time |
| tripadvisorRating | `3.6` | `3.6` | ✓ |
| tripadvisorReviewCount | `46` | `46` | ✓ |
| tripadvisorUrl | the TA listing | matches | ✓ |

## Bugs found and fixed during fixture-testing

1. **Postal regex required pure whitespace before city name.** Real-world
   addresses use `08202, Sabadell` (comma + space). Regex was
   `\b(\d{5})\b(?=\s+[A-Z])`; fix is `(?=[,\s]+[A-ZÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÑ][a-zà-ÿ]+)`
   so the comma is allowed and the city's leading capital can carry an
   accent.

2. **Address noise from aggregators.** carta.menu's JSON-LD `streetAddress`
   was `Carrer Mare De Déu De Les Neus, 6, Sabadell, Catalonia, Spain` —
   the full address as one string. We now strip a trailing
   `, <CITY>...` suffix in `stripAddressNoise()` so the addressLine stays
   clean and Nominatim queries don't double-count the city.

3. **Nominatim-by-address postal/region were dropped in reconciliation.**
   The first cut computed `reconciledPostal` *before* the by-address geocode
   ran. Postal/region from Nominatim's `addressdetails` response now
   backfill if no upstream source had them.

4. **TripAdvisor 403 on the script's first run.** Tracked down to the
   `www.` Referer requirement (see section above). Pinned in
   `taFetch`.

## Out of scope (deferred, per spec)

- `descriptionHtml` — Gemini integration handles this later.
- User-submission validation flow — same primitives, different entry point.
- Auto-OSM-contribution when a venue is missing from OSM.
- Bulk mode — `enricher.js` already handles row-level enrichment for
  existing places. `scrape-venue.js` is single-venue cold-start only.

## TripAdvisor budget — operational

Persistent counter at `scripts/lib/.tripadvisor-budget.json` (gitignored).
Caps:

- **4000 calls/month** (hard cap — TA's free tier is 5000, leaving 1000
  for one-offs).
- **130 calls/day** (soft cap — prevents a runaway script from burning the
  monthly budget in one sitting).

Each TA HTTP call invokes `taBudget.reserve(label)` which increments the
counter and persists *before* firing the request, so a crashed script
doesn't double-spend on retry. Both `--with-tripadvisor` and the (future)
TA enricher phase share the same counter file.

Day/month rollover happens automatically on the first call of a new
day/month. Read-only status:

```bash
node -e "console.log(require('./scripts/lib/tripadvisor-budget').status())"
```

## Worked example — final command for the fixture

```bash
node scripts/scrape-venue.js "Il Figlio di Emiliano" "Sabadell" \
  --country ES \
  --with-tripadvisor \
  --insert
```

Result on 2026-04-26: `[insert] created Place id=1602 slug=il-figlio-di-emiliano-sabadell`,
hero renamed `_staging-...jpg → 1602.jpg`, all TA fields populated, 2
PlaceSource rows (`manual`, `tripadvisor`), 1 PlaceStyle row to
`neapolitan`. ~7 TA API calls consumed (1 search + 1 details + 5
DDG-aggregator pre-checks that 403'd cleanly).
