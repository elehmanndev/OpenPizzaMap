# 2026-05-08 — Enricher queue fix, "0.0" rating bug, Playwright fallback in cron

## Status: SHIPPED — `2c2d6c6` on main, manual workflow run verified GREEN

## TL;DR (for non-technical reading)

Three things shipped today, all related to why the map was showing so many places with no rating.

**Problem 1 — the enrichment cron was stuck.** Every 3 hours the cron tries to fetch ratings/photos/hours for ~20 places that don't have them yet. We had 1,238 places waiting. Turns out the cron was retrying the same broken first-batch every single run for weeks, never reaching newer rows. Cause: when Google's API couldn't find a place, the cron didn't mark it as "tried" so it stayed at the front of the queue forever. Fixed — now failed rows go to the back.

**Problem 2 — most of the map showed "0.0" instead of "—".** A JavaScript quirk: when a place has no rating, the code was accidentally treating "no rating" as "rating of zero". Result: 1,133 of 1,669 visible places (68%) looked like zero-star reviews. One-line fix.

**Problem 3 — even the unsticking didn't help places like Tony's Pizza Solsona.** Some venues genuinely can't be found by Google's text-search API (small towns, accented names, weak indexing). For those, we now fall back to a real browser scraping Google Maps directly. Wired into the GitHub Actions workflow, runs after the API path. Manual test run filled real ratings for 10 small Italian/French places end-to-end.

**About Tony's specifically:** the system worked correctly for it — the Playwright path *did* find the place — but Google itself has no star rating to show (probably <5 reviews). Until a real OPM user reviews it, its card will show "—". That's the system behaving as it should.

---

## What changed

### 1. Queue fix — `3a25336`
- File: `src/routes/api.admin.js`. The `/api/admin/batch-enrich` endpoint now stamps `enrichedAt` on rows where `provider.findPlace()` returns `null`, without bumping `enrichmentVersion`. The row stays in the retry queue but moves to the back.
- Ordering changed from `[isVisible desc, id asc]` to `[isVisible desc, enrichedAt asc nulls first, id asc]`. Untried rows (NULL) go first; among tried rows, oldest-tried come first.
- **Effect**: prior to the fix, every cron run was bouncing on the same ~8 unresolvable rows in the prefix. Manual run after the fix: `enriched=17, skipped=3, remaining=1221` (was 1,238). Queue is actively draining.
- No cost change. GCP project still has hard daily quotas (Text Search 155/day, Place Details 315/day, Geocoding 315/day) so spend stays bound at \$0.

### 2. UI bug — "0.0" instead of "—" — `f47574c`
- File: `public/js/map.js`. The `ratingFor(p)` helper used `Number(r)` on `r` that could be `null`. JavaScript trap: `Number(null) === 0`, and `Number.isFinite(0) === true`, so the guard fell through and returned `0` instead of `null`. Then `ratingLabel()` formatted it as `"0.0"`.
- Fix: bail with `null` before the `Number()` cast.
- **Affected places**: 1,133 of 1,669 visible (68%). Most of the map was showing as zero-star.
- Surfaces affected: map popups (`ppc-rating`), side-panel cards (`msc-rating`).

### 3. Playwright fallback in cron — `2c2d6c6`
- Files: `scripts/lib/gmaps.js`, `scripts/enrichment/resolve-via-gmaps.js`, `.github/workflows/batch-enrich.yml`.
- `lookup()` extended: scrapes `rating` + `reviewCount` from the place panel via `[role="img"][aria-label*="stars"]` and a nearby parens/`reviews`-suffix pattern.
- `resolve-via-gmaps.js` extended: `--need-meta` filter now also matches `googleRating IS NULL`. Writes scraped rating to `googleRating` and `googleReviewCount` (fill-only-if-null). Cache invalidates entries that pre-date the rating extraction.
- Workflow extended: Playwright Chromium cache + install (~30s first run, cache hit on subsequent), gmaps-resolve-cache restore, new step `Playwright fallback (long-tail metadata + ratings)` capped at **10 rows/run** with `continue-on-error: true` so a CAPTCHA or browser flake doesn't fail the cron.
- Throughput: 10 × 8 runs/day = 80 long-tail rows/day. The 1,221 remaining drain in ~15 days.

## Verification — manual workflow run

Triggered via `gh workflow run batch-enrich.yml` after the third commit. Run `25574161394`, completed in 2m25s, all steps green.

- **API enrich**: `enriched=17, skipped=3, remaining=1221, apiCalls=34, quotaHit=false`
- **Playwright fallback**: 10/10 places successfully scraped real ratings + counts. Examples (verified by direct DB read):
  - #48 Mozzabella Street Food → 4.3 / 50 reviews
  - #93 Magnà (Paris) → 4.4 / 915 reviews
  - #138 Pizzeria Speranzella (Naples) → 4.5 / 1,585 reviews
  - #261 Marino (Naples) → 4.5 / 4 reviews
- **Tony's #1909** (resolved manually with `--ids=1909 --apply`): lookup succeeded — found address, phone, website. Rating was `null`. Cache snapshot:
  ```json
  { "title": "Tony's Pizza Solsona", "address": "Carrer d'en Pere Màrtir Colomés...", "rating": null, "reviewCount": null }
  ```
  Meaning: Google Maps doesn't show a star rating for this venue. Not a selector bug.

## Lessons

**Don't oversell a fix.** I shipped the queue fix and framed it as "the 1,238 will drain in ~8 days" — that throughput number was real, but only for *resolvable* rows. Tony's-class places will never resolve via the Google API path. Eric pushed back and was right to. Lesson for future me: when describing what a fix does, lead with what it *doesn't* solve. The queue fix unsticks NEW imports; it doesn't recover already-failed rows.

**`Number(null) === 0` is a JavaScript trap worth remembering.** Combined with `Number.isFinite()` accepting 0 as valid, any guard that runs *after* the cast is broken. Always null-check first. Bit me hard here — bug had been live since the map view shipped.

## Still pending

- **Older-cohort enricher sweep**: still ~600 pre-id-1603 rows thin on website. The cron's queue fix means it'll get to them organically; no manual sweep needed if patient.
- **Vezzo L'Aljub** (LMP id=439): one-off scraper-variant fix to capture the address block.
- **Workflow Node 20 → 24**: GitHub deprecation 2026-06-02. Trivial fix when convenient.

## Commits

- [`3a25336`](https://github.com/ericll93/OpenPizzaMap/commit/3a25336) — queue fix
- [`f47574c`](https://github.com/ericll93/OpenPizzaMap/commit/f47574c) — "—" instead of "0.0"
- [`2c2d6c6`](https://github.com/ericll93/OpenPizzaMap/commit/2c2d6c6) — Playwright fallback in workflow
