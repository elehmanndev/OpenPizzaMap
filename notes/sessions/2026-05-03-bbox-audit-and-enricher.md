# 2026-05-03 — Geocode bbox audit v2 + enricher backlog

Two follow-ups from the 2026-05-02 import wave: validate the 913 singleton-city rows the centroid heuristic in `audit-geocodes.js` can't see, and tackle the enricher backlog left over from the 50TP-Excellent + LMP imports.

## Geocode audit v2 — country bbox check

`scripts/audit-geocodes.js` flags rows far from a city centroid, but only when the bucket has ≥2 peers. After 2026-05-02 there were 913 singleton-city buckets — wholesale-wrong rows in those buckets would slip through.

`scripts/audit-geocodes-bbox.js` (new) is the complement: it loads `scripts/country-bboxes.json` (70 country bounding boxes, hand-curated) and flags any row whose lat/lng is outside its country's bbox. Pure DB-side, no external geocoder.

The bbox JSON supports two shapes per country:
- single bbox `[s, w, n, e]`
- list of bboxes `[[s,w,n,e], …]` for non-contiguous territory (United States gets mainland+Alaska+Hawaii + Guam + Puerto Rico)

### First pass results — 4 flagged + 1 unmapped country

| id | claimed country | city | lat,lng | verdict |
|---:|---|---|---|---|
| 1023 | Israel | Chicago | 41.957, -87.757 | **bug** — coords are Chicago IL; country mislabeled in Eater scrape |
| 1065 | Israel | Chicago | 41.912, -87.635 | **bug** — same |
| 1602 | (ES) | Sabadell | 41.551, 2.108 | **bug** — country stored as ISO2 "ES" instead of "Spain" (manual entry) |
| 559 | United States | Honolulu | 21.311, -157.862 | false positive — Hawaii outside the original mainland-only US bbox |
| 590 | United States | East Hagatna | 13.477, 144.762 | false positive — Guam (US territory) |

### Fixes applied

- ids 1023, 1065 → `country = "United States"` (only 2 rows in DB had `country=Israel`, both were Chicago-mislabeled)
- id 1602 → `country = "Spain"`
- US bbox upgraded to multi-bbox: `[18.0, -171.8, 71.5, -66.9]` (mainland + AK + HI), `[13.2, 144.6, 13.7, 145.0]` (Guam), `[17.8, -67.4, 18.6, -65.2]` (Puerto Rico)

Re-ran the audit on all 1,772 active rows (visible + hidden): **0 flagged, 0 unmapped, 0 missing-coords.** Both audit scripts are now clean for the current catalogue.

## LMP hero-image backfill (102 → 101)

While inspecting the canonical example from the enricher backlog memory (Il Piccolo Biondo, Castelldefels), turned out **all 102** of the LMP-imported rows had `heroImageUrl: null`. The scraper's regex looked for absolute URLs with `class="card-img-top"`, but the actual page markup uses *relative* `../html5Upload/...` URLs identified by `alt="Foto producto N"`. Three out of three checked URLs returned 200 from `https://lamejorpizza.es/html5Upload/...` (root-relative), so that's the canonical form.

### Patches

- `scripts/scrape-lamejorpizza.js` — hero regex now tries 4 patterns (relative + absolute, "Foto producto" + card-img-top legacy) and normalises any match to `https://lamejorpizza.es/html5Upload/…`. Future re-runs work.
- `scripts/backfill-lmp-heroes.js` (new) — re-fetches each LMP detail page, runs the corrected matcher, fills DB `heroImageUrl` on rows where it's still null. Idempotent — already-set rows are skipped on subsequent runs. Matches DB rows by normalised name, with chain-prefix fallback (DB "Infraganti" vs LMP "Infraganti Pizza Bar Alicante").

Result: `candidates=102 matched=101 fetched=101 updated=101 no-hero-on-page=0 fetch-fail=0 no-db-match=1`.

The single miss is **Vezzo L'Aljub** (LMP id=439). The scrape JSON has it with `street/city/postalCode/province/community = null` — the LMP detail page parser failed for this venue and the importer dropped it because city was missing. Coords (38.26, -0.72) put it near Elche (Alicante). One-off scraper bug; flagging for follow-up rather than fixing here.

## Enricher backlog — recent imports

Added a small `--since-id N` filter to `scripts/enricher.js` so the overpass and web phases can target the 242 rows imported since 2026-04-30 (id ≥ 1603) without grinding through the older catalogue first. Both phase queries get an `id: { gte: N }` constraint when the flag is present; existing behaviour without the flag is unchanged.

### Overpass phase (OSM via Overpass API, free)

```
node scripts/enricher.js --phase=overpass --since-id=1603
```

`242 candidates → hits=74 miss=168 fail=0 fieldsFilled=149`

30% match rate is reasonable — OSM coverage for pizzerias is patchy outside major cities. Each hit fills any of website/phone/openingHours/styles that OSM has and the DB doesn't.

### Web phase (parses the venue's homepage for schema.org / style keywords)

```
node scripts/enricher.js --phase=web --since-id=1603
```

`53 candidates → ok=7 miss=36 fail=10 hours=1 styles=7`

Modest gain — most LMP venues don't run their own website (Glovo / social-only), and many of the ones that do don't expose schema.org openingHours.

### Search phase — skipped this session

DuckDuckGo HTML scraping is rate-limit-prone. Eric was AFK so I went with the safer overpass + web combo. Worth a dedicated future run.

## Final state of the 242 recent imports

| field | before | after | delta |
|---|---:|---:|---:|
| no hero | 101 | 0 | **-101** |
| no website | 238 | 181 | -57 |
| no phone | 146 | 107 | -39 |
| no openingHours | 242 | 190 | -52 |

## Files touched

- `scripts/audit-geocodes-bbox.js` — new, paired with `scripts/country-bboxes.json`
- `scripts/country-bboxes.json` — new, 70 country bboxes (US is multi-bbox)
- `scripts/backfill-lmp-heroes.js` — new, one-shot to repair the 102 LMP heroes
- `scripts/scrape-lamejorpizza.js` — hero regex fix (4 patterns + URL normalisation)
- `scripts/enricher.js` — `--since-id` flag added to overpass + web phase queries
- `.gitignore` — added `/*-audit.json` (matches the existing `/*-report.json` pattern)
- DB: 3 country-field fixes, 101 heroImageUrl fills, ~150 fields filled by overpass + web phases

## Follow-ups

- **Vezzo L'Aljub** (LMP id=439) — scraper failed to parse address block, importer dropped row. Worth a one-off re-fetch + manual-import path, or a scraper fix for whatever variant markup that page uses.
- **Search phase** — 181 recent rows still lack a websiteUrl. A bounded DDG search run (say 50/session, with backoff on 429s) would fill more, then web phase can extract hours/styles from the discovered URLs.
- **No-hero singletons** in older scraping cohorts — the audit only counted hero gaps in the 2026-04-30+ window. The wider DB likely has more thin rows worth a sweep.
- **TripAdvisor / Google enrichers** — out of scope per budget memory (free-tier rate caps must hold) but a metered run on starred-rating venues could add reviews + photo URLs.
