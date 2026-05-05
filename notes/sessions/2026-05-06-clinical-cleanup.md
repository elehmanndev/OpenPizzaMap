# 2026-05-06 — Clinical cleanup: shared script harness + repo organization

## Status: SHIPPED — committed and pushed to main

Eric was burned out from the recurring "script broke in prod, SSH in to diagnose,
fix env path, push" loop. Pushed back on his initial "entire refactor" ask
because the web app and the new enrichment pipeline (shipped 2026-05-04) are
both stable; the actual mess was in the auxiliary scripts. Five-step surgery
instead.

## What changed

### 1. New shared harness — `scripts/lib/bootstrap.js`
Single source of truth for env loading + Prisma client across every script.
Replaces the **seven different** `dotenv.config()` patterns scattered across
30+ scripts (some climbed four directories up, some assumed cwd == repo root,
only `batch-enrich.js` knew about Hostinger's `.builds/config/.env` layout —
which is exactly why commits 9fb2eb8, ed4b30a, 381c28a were all the same
class of bug).

Exports: `prisma`, `ROOT`, `envPath`, `PATHS` (canonical `data/scrapes`,
`data/cache`, `data/reports` dirs auto-created on first import).

Every script now does `const { prisma } = require('../lib/bootstrap')`.

### 2. `scripts/` reorganized into subfolders
Was: 38-file flat dump. Now:
- `scrapers/` — 7 source-fetchers (50 Top, AVPN, Eater, Michelin, etc.)
- `importers/` — `import-places.js`
- `enrichment/` — batch-enrich, enrich-places, generate-descriptions, resolve-via-gmaps
- `audits/` — read-only diagnostics (geocode bbox/centroid, dedup smoke test)
- `backfills/` — 15 one-shot data corrections (images, hero photos, OPM rating, etc.)
- `admin/` — `set-admin-password.js`
- `deploy/` — boot/postinstall hooks (migrate, chmod-prisma-engines, build-asset-version, build-thumbs, build-sitemap, touch-passenger-restart)
- `legacy/` — quarantined `enricher.js`
- `lib/` — bootstrap.js (new), gmaps.js, utils.js, tripadvisor-budget.js

### 3. Legacy enricher quarantined
`scripts/legacy/enricher.js` now exits with a loud deprecation message
unless `LEGACY_ENRICHER_FORCE=1` is set. The new pipeline at
`src/services/enrichment/` + `scripts/enrichment/batch-enrich.js` handles
everything it used to do, with proper Google Places API + cache table.

### 4. Root directory cleaned
Was: 30+ JSON/PNG/HTML/log files dumped at repo root. Moved to:
- `data/scrapes/` — 13 source JSONs
- `data/cache/` — 5 runtime caches (geocode, gmaps, reviews, dedup, reverse-geocode)
- `data/reports/` — 5 audit/error JSONs + 6 debug screenshots + 10 stale logs

`.gitignore` updated: blanket-ignore `data/`, kept legacy root-level patterns
as belt-and-braces for any in-flight tarballs.

### 5. `pages.js` split
- `src/routes/pages.js` — 402 lines, public routes only (incl. sitemap + robots)
- `src/routes/pages.admin.js` — 595 lines, all admin CMS routes
- `src/app.js` mounts both at `/`

Was: 983-line single file mixing public + admin.

### 6. `package.json` + GitHub Actions workflow updated
Every script path in `npm run` scripts and the cron workflow now points to the
new subfolder location. Postinstall chain (`chmod-prisma-engines` → `prisma
generate` → `build-asset-version` → `touch-passenger-restart`) preserved
exactly, just with `scripts/deploy/` prefix.

## Verification

Mechanical checks done in-session (no human review needed — Eric is
non-technical):

- `node -c` syntax check passed on every JS file under `src/` and `scripts/`
- `node -e` smoke test of `bootstrap.js`: env loaded from `.env.local`, ROOT
  resolved correctly, PATHS dirs created, `prisma.place.count()` returned
  **1,772** (matches live DB)
- `node scripts/legacy/enricher.js` exits with deprecation message as expected
- `node src/app.js` reached `app.listen()` successfully — all 25+ routes
  mounted, all middleware loaded, Prisma proxy intact (port 3000 collision
  with the preview server is the only "error", which proves the app got
  fully constructed)

## What is NOT changed (deliberately)

- The web app's actual runtime behaviour. Same routes, same middleware order,
  same DB queries, same auth flow. This is reorganization, not refactor.
- The enrichment pipeline at `src/services/enrichment/` — it's 2 days old and
  shipping rows nightly via cron, no reason to touch it.
- Schema, migrations, seed.
- Test suite (still 3 files for ~3,400 LOC src — separate problem).
- Hostinger deploy config / Passenger restart triggers.

## What this fixes

Eric's 2026-05-06 frustration: "I'm just so fucking sick and tired of having
to fix stuff." Concrete cause was the dev loop with no safety net — every
push was a coin flip because no script ever loaded env the same way. With
bootstrap, that class of bug is structurally impossible: the env path is
resolved by a single file that mirrors `src/app.js` exactly. Future scripts
will use it by default.

## What this does NOT fix (still pending)

1. **Real test coverage.** 3 test files isn't enough. Worth ~1 session.
2. **Pre-push smoke script.** Originally proposed as `npm run smoke` —
   would catch problems locally before the push. Bootstrap closes the
   biggest gap (env path bugs); the smoke script would close the rest
   (engine binaries, DB connectivity, route surface).
3. **Gemini key rotation** — still deferred per memory.
4. **Source-code references to old script paths** in docs/comments. Pure
   documentation drift, no runtime impact. Update incrementally.

## Files changed

- New: `scripts/lib/bootstrap.js`, `src/routes/pages.admin.js`,
  `data/{scrapes,cache,reports}/`
- Moved: 38 scripts into 8 subfolders, 30+ JSONs/images/logs into `data/`
- Edited: every script under `scripts/` (env+prisma replaced with bootstrap),
  `package.json` (paths), `.github/workflows/batch-enrich.yml` (paths),
  `src/app.js` (mount pages.admin), `src/routes/pages.js` (admin block
  removed), `scripts/lib/gmaps.js` (cache path → data/cache/), `.gitignore`
  (blanket-ignore data/)
- Deleted: nothing
