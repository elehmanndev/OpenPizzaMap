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

### Search phase — skipped

DuckDuckGo HTML scraping is rate-limit-prone. Decided against running it before checking whether the place-panel scrape on Google Maps could fill the same fields more reliably (it could — see below).

## GMaps resolver: phone + website + hours

The existing `scripts/resolve-via-gmaps.js` already opened the GMaps place panel on each row to read the address — every other field we wanted (phone, website, opening hours) is on the same panel, so reading them was a one-shot extension. Better hit rate than DDG-search-then-parse-the-website, no extra rate-limit surface, and the script's existing pacing + cache infrastructure carried over.

Extended `lookup()` to pull:
- **phone** from `button[data-item-id^="phone:tel:"]` (the data-item-id itself carries the canonical number; aria-label fallback for variants)
- **websiteUrl** from `a[data-item-id="authority"]` (`href` value; skips FB/IG/Google authority links so they don't pollute the field)
- **openingHours** from `[data-item-id="oh"]` aria-label first, with an hours-table fallback for cases where the panel is expanded by default

New flags: `--need-meta` (target visible rows with null phone/website/hours), `--since-id N` (scope), `--limit N` (cap per run). Apply path is fill-only-if-null on the metadata trio — never overwrites existing values. Cache invalidates for entries that pre-date the new field shape (so the 27 ES+PT rows we resolved on 2026-05-02 re-fetch under `--need-meta`).

### Run

```
node scripts/resolve-via-gmaps.js --need-meta --since-id=1603 --apply
```

`211 candidates → 203 resolved, 2 missed, 6 skipped — phone=94 website=147 hours=175`

(212 rather than 242: ~30 of the recent imports already had complete metadata after the overpass+web pass.)

Hours come back as a localised string (`domingo: 12:30–16:0018:30–24:00; lunes: ...`) rather than OSM-strict (`Mo-Fr 11:00-22:00`). Readable in the UI, not strictly parseable. Acceptable for now; a later pass can normalise to OSM format if a downstream consumer needs it.

## Final state of the 242 recent imports

| field | at import | after enricher | after gmaps | total delta |
|---|---:|---:|---:|---:|
| no hero | 101 | 0 | 0 | **-101 (100%)** |
| no website | 238 | 181 | **32** | -206 (87%) |
| no phone | 146 | 107 | **11** | -135 (92%) |
| no openingHours | 242 | 190 | **11** | -231 (95%) |

## Files touched

- `scripts/audit-geocodes-bbox.js` — new, paired with `scripts/country-bboxes.json`
- `scripts/country-bboxes.json` — new, 70 country bboxes (US is multi-bbox)
- `scripts/backfill-lmp-heroes.js` — new, one-shot to repair the 102 LMP heroes
- `scripts/scrape-lamejorpizza.js` — hero regex fix (4 patterns + URL normalisation)
- `scripts/enricher.js` — `--since-id` flag added to overpass + web phase queries
- `scripts/resolve-via-gmaps.js` — pulls phone/website/hours from the place panel; new `--need-meta` / `--since-id` / `--limit` flags
- `.gitignore` — added `/*-audit.json` and `/*-debug.html`
- DB: 3 country-field fixes, 101 heroImageUrl fills, ~150 fields filled by overpass + web, 416 fields filled by gmaps resolver (94 phone + 147 web + 175 hours)

## Follow-ups

- **32 recent rows still missing a website, 11 missing phone, 11 missing hours.** Mostly the GMaps "missed" or "skipped" rows where the place panel didn't load or the venue isn't on Maps. DDG search phase is the next lever for those.
- **Vezzo L'Aljub** (LMP id=439) — scraper failed to parse address block, importer dropped row. Worth a one-off re-fetch + manual-import path, or a scraper fix for whatever variant markup that page uses.
- **Hours format** — GMaps returns a localised "domingo: 12:30–16:00…" string, readable but not OSM-strict. A later normaliser pass can convert to `Mo-Fr 11:00-22:00` style if a downstream consumer (e.g. a structured-hours UI) needs it.
- **Older-cohort enrichment** — `--since-id 1603` scoped this pass to recent imports. Older cohorts (id < 1603) still have ~600 rows missing website + a similar count missing hours. Same `--need-meta` run without `--since-id` would tackle them; ~30-40 min runtime.
- **TripAdvisor / Google enrichers** — out of scope per budget memory (free-tier rate caps must hold) but a metered run on starred-rating venues could add reviews + photo URLs.
