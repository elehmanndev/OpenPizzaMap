# 2026-05-02 — LMP skip review: 6 false-negatives flipped

The 2026-05-02 LMP scrape passed 96 of 141 venues through the rating gate (≥4.3★ × ≥100 Google reviews). Of the 26 rating-gate failures, six were judgement-call false negatives — high quality, low review *volume* — and the LMP-championship signal is itself strong enough to override the volume threshold for those.

## Override criteria

- ≥4.5★ regardless of review count (small/new venues with strong ratings)
- ≥4.3★ with ≥25 reviews (meets the rating bar, just thin volume)
- chain consistency (one Trozzo location had no rating but its sibling locations are 4.8★ × 13 / × 23, all in the LMP)

The remaining 20 rating-gate failures are genuine quality fails (≤4.2★ with high volume = popular but mediocre, or ≤3.8★ outright) and stay skipped.

## The six

| LMP id | name | city | rating | reviews | DB id |
|---:|---|---|---:|---:|---:|
| 405 | Toxo Pizzería | Las Torres de Cotillas | 4.9 | 81 | 1924 |
| 312 | Trozzo Alba de Tormes | Alba de Tormes | 4.8 | 13 | 1922 |
| 313 | Trozzo Plasencia | Plasencia | 4.8 | 23 | 1927 |
| 374 | Gula | Villacañas | 4.6 | 89 | 1923 |
| 431 | Garden Gastrobar | Pola de Laviana | 4.3 | 44 | 1926 |
| 311 | Trozzo Guijuelo | Guijuelo | — | 93 | 1925 |

## Mechanism

`lamejorpizza-scrape.json` is the source of truth — the importer (`scripts/import-places.js`, `normalizeLamejorpizza`) returns `null` for any record where `quality_pass !== true`, so flipping the flag is the entire override mechanism. Each of the six rows was edited in place: `quality_pass: true` and `quality_reason: "override: LMP-championship + <orig reason>"` so the override is auditable in the JSON.

`node scripts/import-places.js` then reported `created=6 enriched=0 untouched=1732 sources=1953` — exactly the six new rows, no incidental changes elsewhere.

## Garden Gastrobar coord fix

The LMP detail page for Garden Gastrobar served `mapInitPosition = { lat: 40.412224, lng: -3.703925 }` — that's Madrid Puerta del Sol, not Pola de Laviana (Asturias is ~43.27°N, -5.56°W). The detail page presumably defaulted to a Madrid map view when the venue's real coordinates failed to resolve.

Nominatim couldn't find the exact street ("Calle Libertad 31, Pola de Laviana") but did resolve the town centroid to `43.2508, -5.5648`. Updated row id=1926 in place. Town-centroid is acceptable for a thin row; can be refined later by `resolve-via-gmaps.js`.

## Visibility flip

All six flipped `isVisible: true` straight away — they passed the override review, no need for a second pass. Spain is top priority per project memory; getting them on the map is the point.

API `/api/places/markers` should now return **1,471 visible places** (was 1,465 after the 2026-05-02 ES+PT import).

## Files touched

- `lamejorpizza-scrape.json` — 6 records flipped (quality_pass + quality_reason), passes count moved 96 → 102.
- DB: 6 rows created (ids 1922–1927), one row's lat/lng patched (id 1926).

## Follow-ups

- **20 quality-fail rows stay skipped.** Worth re-scoring if a rating shifts above 4.3★ + 100 reviews on a future re-run.
- **Garden Gastrobar street-level coord** — Nominatim couldn't resolve the address; town centroid will do until the next geocoder pass.
- **City casing** — "alba de Tormes" / "Las Torres de cotillas" came through with mixed casing. Consistent with other LMP rows; can be batch-normalised with a separate cleanup pass.
- **141 LMP scrape — only 102 imported.** The 15 already-in-DB silent skips are correct; the no-Google-data row (id 420 Pizzeria Gnomo) and the 1 lone "gate fail" cases are still in skip limbo and could use a spot-check if Spain coverage matters.
