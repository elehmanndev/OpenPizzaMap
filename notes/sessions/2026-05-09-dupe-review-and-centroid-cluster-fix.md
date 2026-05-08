# 2026-05-09 — Dupe review (10 merges), gate hypothesis, centroid cluster prioritization

## Status: SHIPPED — `c4ebb50` on main, plus DB-only updates to 64 rows

## TL;DR (for non-technical reading)

**The "0.0 ratings" investigation from yesterday surfaced a wider problem.** Spot-checking a single map card (Tony's Pizza Solsona) led to noticing two "50 Kalò" rows in Naples that were obviously the same restaurant, just imported twice. A scan turned up 61 coord-identical pairs across the DB. We worked through them one-by-one tonight: **10 confirmed duplicates merged, 51 confirmed not-duplicates** (the not-dupes are real different restaurants that got piled up at the same wrong coordinates because of imprecise imports — Notre-Dame Paris had 5 venues stuck on it).

**While reviewing each pair, I learned what signals reliably tell dupes apart from coord-collisions.** Going forward this becomes a tighter import-time gate so future imports stop creating these pairs. Three signals:

1. **Address-line equality (strongest)** — 7/9 confirmed dupes had matching addresses. Centroid-collisions either had different addresses or no address.
2. **Name-token overlap (most reliable)** — 9/9 dupes shared a distinctive ≥4-char token after stripping `pizzeria/antica/by/etc`. Zero of 51 not-dupes did.
3. **Same website host (don't trust alone)** — Faggio and Guillaume Grasso in Paris both had `cafe-g-paris.fr` but Google's Knowledge Graph shows them as separate venues. Sister-brand / shared-group / import-error.

**Gate hypothesis is ready to ship next session.** Wired alongside that, the 64 centroid-stuck venues (Paris Notre-Dame cluster + 6 others) are now at the front of the Playwright cron queue and should scatter to their real coordinates within ~24h.

---

## What changed

### 1. 10 duplicate merges (Eric-confirmed)
- `6d3932d` — #178 ← #421 (50 Kalò di Ciro Salvo → 50 Kalò, Naples). First case, found while debugging Tony's "0.0 review" page.
- `0d9858d` — batch 1 (7 pairs):
  - #1670 ← #335   Pizzeria Gorizia 1916 (Naples) — kept canonical name, inherited ★4.1/2981 from drop
  - #822  ← #919   Prova- (Caracas)
  - #1338 ← #1673  Diego Vitagliano Pizzeria (Naples) — inherited ★4.4/6305
  - #1370 ← #1345  Francesco & Salvatore Salvo (Naples)
  - #1377 ← #1362  Bro. Ciro e Antonio Tutino Pizzeria (Naples)
  - #1444 ← #1408  Pizzeria Panetteria Bosco (Tempio)
  - #1457 ← #1669  Bas & Co (Pesche) — inherited ★4.6/1121
- `7a0d2f1` — 2 more pairs (typo + a flagged-unsure):
  - #1348 ← #241   180 Grammi Pizzeria Romana (Rome) — inherited ★4.4/2039
  - #1373 ← #1359  Antica Friggitoria Masardona Roma (Rome)

Merge logic was a fill-only-if-empty patch followed by `prisma.place.delete` (cascade-deletes child rows). PlaceSource rows with non-conflicting `source` were reassigned to the keeper; PlaceStyle entries deduplicated. Orphan hero files cleaned up.

### 2. Resolver queue ordering — `c4ebb50`
- `scripts/enrichment/resolve-via-gmaps.js` was ordering by `id asc`, which pushed high-id rows (recent imports, where the centroid-stuck Paris/Vienna/Geneva venues sit) to the back of the Playwright sweep — they wouldn't be reached for ~2 weeks.
- Changed to match the API endpoint's order: `[enrichedAt asc nulls first, id asc]`. Now nulling `enrichedAt` on a row promotes it to the front of *both* cron queues.

### 3. Centroid cluster prioritization (DB-only)
- 7 visible coord-clusters with ≥3 venues at identical lat/lng/city/country = 24 rows. All 24 had `enrichedAt` nulled.
- 20 visible clusters with exactly 2 venues = 40 more rows. All confirmed not-dupes from tonight's review. All 40 had `enrichedAt` nulled.
- Total: **64 centroid-stuck venues** at the front of the Playwright queue.
- The resolver's existing 200m drift-gate means re-resolution is safe: genuine same-coord venues stay put, centroid imports get scattered to real addresses.

## Eric's survivor preference (signal for the merge tool)

In 9 of 10 merges Eric kept the **longer / more-canonical name** even when the alternative had richer Google data:

| pair | kept | dropped (had what) | rationale |
|---|---|---|---|
| 178 ← 421 | "50 Kalò" | "50 Kalò di Ciro Salvo" | first-listed; both had 178 had Google data |
| 1670 ← 335 | "Pizzeria Gorizia 1916" | "Pizzeria Gorizia" (★4.1/2981) | canonical name with year; *inherited* the rating |
| 1338 ← 1673 | "Diego Vitagliano Pizzeria" | "10 Diego Vitagliano Pizzeria" (★4.4/6305) | dropped leading "10"; inherited rating |
| 1457 ← 1669 | "Bas & Co" | "Bas" (★4.6/1121) | longer/more-specific; inherited rating |
| 1348 ← 241 | "180 Grammi Pizzeria Romana" | "180g Pizzeria Romana" (★4.4/2039) | written-out vs abbreviated; inherited |
| 1373 ← 1359 | "Antica Friggitoria Masardona Roma" | "Masardona by Cristiano Piccirillo" | heritage form over chef-attribution |

The fill-only patch made these "best-of-both" merges — Eric got the canonical name and the rich Google enrichment.

## Gate hypothesis (ready to implement next session)

In [src/services/enrichment/index.js:96](src/services/enrichment/index.js:96), replace strict name equality with a 2-of-3 signals match. Validates 9/9 dupes caught, 51/51 not-dupes rejected against tonight's data. **Not yet shipped** — Eric to give green light next session.

```js
// today
if (normalizePlaceName(n.name) !== candidateNorm) continue;

// proposed
const sigs = matchSignals(n, candidate);
// sigs = { nameEqual, nameTokenOverlap, addressMatch }
if (!sigs.nameEqual && !sigs.nameTokenOverlap && !sigs.addressMatch) continue;
```

- `nameTokenOverlap` = ≥1 shared token of ≥4 chars after stopword strip (`pizzeria, pizzaria, antica, friggitoria, ristorante, restaurant, trattoria, di, da, do, by, the, le, la, il, el, los, las, e, and, &`)
- `addressMatch` = normalize both (lowercase, strip postcode + country, collapse whitespace), one is contained in the other or they share ≥2 distinctive tokens
- Same-website-host deliberately *not* used as a signal — Faggio + Guillaume Grasso both have `cafe-g-paris.fr` but are different venues per Google KG. Sister-brand false-positive risk too high.

## Verification path (for tomorrow)

```sql
SELECT lat, lng, city, country, COUNT(*) AS n
FROM Place WHERE isVisible = 1
GROUP BY lat, lng, city, country HAVING n >= 2;
```

Expected: drops from 27 clusters tonight (7 of ≥3, 20 of =2) to ≤2 within 1–2 days as the Playwright cron resolves the 64 centroid venues.

```
gh run list --workflow=batch-enrich.yml --limit=3
```

Look for `[resolve]` lines hitting IDs from the centroid set: 176, 179, 1208, 1257, 1266, 1270, 1374, 1380, 1385, 1395, 1412, 1471, 1472, 1475, 1476, 1477, 1481, 1487, 1488, 1493, 1495, 1497, 1513, 1516, 1517, 1523, 1526, 1660, 1685, 1696, 1700, 1705, 1713, 1714, 1716, 1718, 1725, 1732, 1737, 1742, 1748, 1749, 1750, 1754, 1755, 1756, 1758, 1761, 1768, 1797, 1800, 1801, 1804, 1807, 1808, 1809, 1810, 1822, 1824, 1835, 1894, +Vilnius/Madrid pairs.

## Still pending

- **Implement the gate-tightening rule** — proposed above; needs Eric green light. Should also write a one-shot validation script that runs against the historic dupe pairs.
- **Older-cohort enricher sweep** — still ~600 pre-id-1603 rows thin on website. Cron will reach them organically.
- **Vezzo L'Aljub** (LMP id=439) — one-off scraper-variant fix.
- **Workflow Node 20 → 24** — GitHub deprecation 2026-06-02.
- **Worktree cleanup** — `cool-aryabhata-a02b4e` worktree + branch.

## Commits

- [`6d3932d`](https://github.com/ericll93/OpenPizzaMap/commit/6d3932d) — first dupe merge (50 Kalò)
- [`d8acfbb`](https://github.com/ericll93/OpenPizzaMap/commit/d8acfbb) — yesterday's session note (committed today)
- [`0d9858d`](https://github.com/ericll93/OpenPizzaMap/commit/0d9858d) — batch 1 dupe merges (7 pairs)
- [`7a0d2f1`](https://github.com/ericll93/OpenPizzaMap/commit/7a0d2f1) — batch 1 cont (2 pairs)
- [`c4ebb50`](https://github.com/ericll93/OpenPizzaMap/commit/c4ebb50) — resolver queue ordering fix
