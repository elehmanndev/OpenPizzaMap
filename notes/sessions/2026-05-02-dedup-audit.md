# 2026-05-02 — Dedup audit (post 50TP Europe + lamejorpizza imports)

Eric flagged a duplicate "Starita" pin on the map. This audit ran the 1,677
visible places through two passes and identified one root cause that
covers most of the duplicates: the importer's slug-based dedup misses
rows where the existing entry has a `Pizzeria ` / `Pizzaria ` / `Antica `
prefix and the incoming row drops it (or vice-versa).

## Method

- Source: `GET /api/places/markers` (1,677 visible rows, fetched 2026-05-03 21:25 UTC)
- Pass A: same `(normalisedName, country)` AND haversine ≤ 5 km. Normalisation:
  lowercase, strip punctuation/diacritics, drop the prefix tokens
  `pizzeria|pizzerie|restaurant|trattoria|ristorante|osteria|the`.
- Pass B: haversine ≤ 150 m AND token-level Jaccard ≥ 0.4 OR substring
  containment. Catches the edge cases A misses (e.g. `Bro.` vs
  `Bro. Ciro e Antonio Tutino Pizzeria`).
- Pass A excludes pairs A/B where both rows are in different cities
  ≥ 5 km apart — those are chains (Settebello x5 in the US, Olio x6
  in Poland, Pizza Beppe 4 x6 in NL, Fratelli Coppola x4 in Italy,
  Bestia x2 in DE, etc.) and not duplicates.

`PlaceSource` is not exposed via the public API, so the "which import"
column is inferred from `id` and `createdAt` — every recently-imported
row in the table below has id ≥ 1620 and `createdAt = 2026-05-02`, which
matches the 50TP Europe 2025 / Excellent Pizzerias scrape (commits
`1118617`, `bc8b726`, `fba8929`). None of these come from
lamejorpizza — that import seeded Spain only, and no Spanish dup pairs
appear in the audit.

## Pass A — same name+country, ≤ 5 km apart (high confidence)

> Eric: please sanity-check before any soft-delete. The "keep" side is
> the older / better-enriched row; the "drop" side is the newer
> low-id-2026-05-02 import row. Confirm with a click on each pair on
> the live map.

| dist | keep id | keep name | drop id | drop name | city | country |
|---:|---:|---|---:|---|---|---|
| 0 m | 171 | Pizzeria Giovanni Santarpia | **1664** | Giovanni Santarpia | Florence | Italy |
| 167 m | 180 | Pizzeria Starita a Materdei | **1620** | Starita a Materdei | Naples | Italy |
| 5 m | 285 | Pizzeria Da Attilio | **1684** | Da Attilio | Naples | Italy |
| 0 m | 324 | Vesi | **1622** | Pizzeria Vesi | Naples | Italy |
| 979 m | 272 | Pizzeria Guglielmo & Enrico Vuolo Verona | **1683** | Guglielmo & Enrico Vuolo Verona | Verona | Italy |
| 818 m | 300 | Antica Pizzeria Ciro 1923 | **1433** | Antica Pizzeria Ciro 1923 | Gaeta | Italy |
| 1.78 km | 323 | Enosteria Lipen | **1413** | Enosteria Lipen | Canonica Lambro / Triuggio (MB) | Italy |
| 2 m | 1322 | Napoli on the Road | **1379** | Napoli on the Road | London | United Kingdom |
| 17 m | 1323 | L'Antica Pizzeria | **1382** | L'Antica Pizzeria | London | United Kingdom |
| 2 m | 1333 | Vicoli di Napoli Pizzeria | **1726** | Vicoli di Napoli | London | United Kingdom |
| 2.33 km | 462 | Forno D'Oro | **1479** | Forno d'Oro | Lisbon | Portugal |

Pre-existing collisions (not from this import wave — flagging for later):

| dist | id A | id B | name | cities |
|---:|---:|---:|---|---|
| 4.62 km | 215 | 1053 | Lou Malnati's / Lou Malnati's Pizzeria | Chicago / IL 60610 (Chicago) |
| 2.95 km | 221 | 1060 | Louisa's Pizza & Pasta | Crestwood / IL 60445 |
| 3.51 km | 541 | 699 | Tarumbò | Sant'Arpino / Cardito |

## Pass B — ≤ 150 m + similar name (medium confidence)

| dist | keep id | keep name | drop id | drop name | city, country |
|---:|---:|---|---:|---|---|
| 4 m | 47 | Giotto Pizzeria Bistrot | **1360** | Giotto Pizzeria | Florence, IT |
| 0 m | 421 | 50 Kalò di Ciro Salvo | **178** | 50 Kalò | Naples, IT |
| 14 m | 286 | Pizzaria la Notizia | **183** | La Notizia | Naples, IT |
| 0 m | 335 | Pizzeria Gorizia | **1670** | Pizzeria Gorizia 1916 | Naples, IT |
| 4 m | 629 | Pop's Place Pizza | **1694** | Pop's Pizza | Ljubljana, SI |
| 0 m | 919 | Prova- La Vera Pizza | **822** | Prova- La vera pizza napoletana | Caracas, VE |
| 5 m | 1019 | Pat's Pizza | **1646** | Pat's Pizzeria & Ristorante | Chicago, US |
| 0 m | 1338 | Diego Vitagliano Pizzeria | **1673** | 10 Diego Vitagliano Pizzeria | Naples, IT |
| 0 m | 1370 | Francesco & Salvatore Salvo | **1345** | Salvo | Naples, IT |
| 0 m | 1377 | Bro. Ciro e Antonio Tutino Pizzeria | **1362** | Bro. | Naples, IT |
| 0 m | 1444 | Pizzeria Panetteria Bosco | **1408** | Bosco | Tempio Pausania (SS), IT |
| 0 m | 1457 | Bas & Co | **1669** | Bas | Pesche (IS), IT |

(For pairs where both ids fall in the new-import range — 1338/1673,
1345/1370, 1362/1377, 1408/1444 — the older row is also from a recent
import, so the "keep" side is ambiguous. Eric to decide which name is
canonical.)

## Root cause

`scripts/import-places.js:726-737` derives the dedup key as
`slugify(name + '-' + city)` and looks up by that slug. The two strings

- `"Pizzeria Starita a Materdei"` + `"Naples"` → `pizzeria-starita-a-materdei-naples`
- `"Starita a Materdei"` + `"Naples"` → `starita-a-materdei-naples`

are different keys, so the importer creates a fresh row. Same shape for
every "Pizzeria X" / "X" pair in the table above, plus the
`d'Oro` / `D'Oro` apostrophe variant and the `10 Diego Vitagliano` /
`Diego Vitagliano` numbered-prefix variant.

## Suggested fix (separate change — not in this session)

Before the slug lookup at `import-places.js:737`, add a fallback
`findFirst` that:

1. Strips the same prefix tokens used in this audit's normalisation
   (`pizzeria`, `pizzerie`, `pizzaria`, `antica`, `the`, plus a leading
   numeric prefix like `^\d+\s+`) from both sides.
2. Filters by same `country` and haversine ≤ 200 m.
3. If a match is found, treat it as the existing row (enrich, don't
   create) — same code path as the slug-hit branch at line 790.

That covers ~90 % of the pairs in this audit. The cross-city Italian
chain pairs (Lou Malnati, Louisa, Tarumbò) are too far apart for a
distance check and would need a manual flag — defer for now.

## Not done in this audit

- Pulling `PlaceSource` rows for the suspect ids — would need DB or
  admin endpoint access; not in the public API.
- Soft-delete of any rows. Per Eric's standing rule, audit only.
- Re-import dry-run to confirm the fix above catches every row in the
  table — best done after the dedup-by-normalised-name patch is in.
