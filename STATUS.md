# STATUS — lamejorpizza.es import (in flight)

**Branch**: `claude/awesome-cannon-caebca` (also pushed to `main`)
**Last commit on main**: `a33857f` — *DB cleanups: Castellón normalisation + 7 Sensi city fix*
**Worktree HEAD**: same as `main` until I commit the new files

## Done

- [x] Wrote `scripts/scrape-lamejorpizza.js` (~270 LOC; mirrors 50TP shape, has Spanish address parser, lat/lng from `mapInitPosition`, Playwright awards lookup + Google rating gate)
- [x] Wired `lamejorpizza` shape into `scripts/import-places.js` (SOURCES + dispatch + `normalizeLamejorpizza` returning null on `quality_pass !== true`)
- [x] **Scraper run complete**. Output:
  - `lamejorpizza-scrape.json` (project root) — 141 venues, 96 quality_pass, 45 skipped
  - `lamejorpizza-detail-cache.json` (project root) — re-run cache
  - `notes/sessions/2026-05-02-lamejorpizza-skipped.md` — full skip table for review

### Scraper output breakdown

- 141 total scraped
- award-tier: 3 passed (only Top-3 Spain visible from `ranking.php`; the JS-rendered category sub-pages exposed only those names)
- already-in-DB: 15 silent skips
- needGoogle: 123 → ratings checked
- final pass: **96** (3 award + 93 rating-gate passes)
- final skip: **45** (15 in-db + 30 rating/no-data fails)

## Pending (do in this exact order)

1. Run importer to land 96 passing rows: `cd C:/Users/Eric/OpenPizzaMap && node scripts/import-places.js` (Nominatim NOT needed because each row already has lat/lng; importer fills missing fields only; expect mostly cache hits on existing rows)
2. Identify newly-created Spain rows from this run (`createdAt > <when import started>`)
3. Flip them visible
4. Smoke test: API `/api/places/markers` totals + Spain + Valencia + Sevilla deltas
5. Spot-check 5 random imports (name + coords look right)
6. Commit (scraper + importer edit + STATUS.md + skipped MD + new session note); push to main
7. Update STATUS.md after each milestone, delete it once import + flip + smoke test all done

## Resume command (if dropped here)

```bash
cd C:/Users/Eric/OpenPizzaMap
node scripts/import-places.js
# Then: identify new Spain rows by createdAt window, flip visible, smoke test.
```

## Files modified, NOT committed yet

- `scripts/scrape-lamejorpizza.js` (new)
- `scripts/import-places.js` (modified: new SOURCES entry + dispatch case + normalizeLamejorpizza)
- `STATUS.md` (this file — new)
