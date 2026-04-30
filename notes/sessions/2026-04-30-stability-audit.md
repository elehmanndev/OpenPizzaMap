# 2026-04-30 (PM) — Stability audit + Phase 1/2/3

Trigger: a Vrbo-style /map redesign (`ef63929`) had been deployed earlier in
the day with two new schema models (`Visit`, `Favorite`) but **no migration
file**. Live MySQL didn't have those tables; `/api/places` started 503'ing
because `prisma.visit.groupBy` threw on the missing table; map went empty.
Eric flagged it after the rest of the site looked fine but the map had no
markers.

## Outage recovery

1. Wrote the missing migration as
   `prisma/migrations/20260430210000_add_visit_favorite/migration.sql` (commit
   `ea1aaf0`). Auto-deploy ran `prisma generate` cleanly (postinstall chmod
   from earlier today did its job) but `prisma migrate deploy` was silently
   exiting 0 on failure inside `scripts/migrate.js`, so the app booted
   pointing at a still-broken DB.
2. SSH'd in, hit P3018 (`Visit already exists`) — a previous attempt had
   half-created the table without recording the migration.
3. Recovery: dropped both partials via `prisma db execute`, marked the
   migration as `--rolled-back`, ran `migrate deploy`. Tables created with
   FKs intact. Restart from hPanel reloaded the regenerated Prisma Client.

`/api/places` returned `{ ok: true, places: 1000 }` again. Map repopulated.

## Audit findings (Explore agent — see commit messages for the full diff)

Three classes of issue surfaced — all fixable, none fundamental:

### A. Failure visibility
- `scripts/migrate.js` exited 0 on failure unless `MIGRATE_STRICT=true` was
  set. **This is what cost us 4+ hours.** Now strict by default; opt out via
  `MIGRATE_LENIENT=true` only for explicit recovery.
- No health endpoint. Now `GET /api/health` pings Place + Visit + Favorite
  counts. Returns 200 healthy or 503 unhealthy with errCode/errName. Always
  mounted (in maintenance mode it returns `503 status:maintenance` instead).
- Async route handlers across `src/routes/*` lacked try/catch. Any thrown
  Prisma error became an unhandled rejection that crashed the worker. Added
  `express-async-errors` (top of `src/app.js`) so all async errors reach the
  middleware. Hardened `src/middleware/error.js` to map Prisma error codes:
  P1001/P1002/P1008/P1017 → 503; validation/JSON parse → 400; everything
  else → 500. Logs a structured one-liner (`[err] {...}`) on every 5xx so
  outages are greppable in stderr.log.

### B. Process pressure (Max Processes hitting 120 cap)
Each Passenger worker = Node + Prisma engine = 2 procs ⇒ 120 cap means ~60
effective workers. Saturating that on a small traffic burst was easy
because:
- `/api/places` was unconditionally fetching **1000 rows** with `take:1000`
  and running 3 sequential-then-parallel Prisma queries per request. Now:
  - Anon: cap 200, **1 round-trip**.
  - Auth: cap 500, **2 parallel round-trips** (visit groupBy in parallel
    with one combined raw `UNION` query for visited+favorited flags).
- `/api/places` had no cache headers. Now anon callers (no opm.sid cookie,
  thanks to `saveUninitialized:false`) get
  `Cache-Control: public, max-age=30, s-maxage=60, stale-while-revalidate=300`
  + `Vary: Cookie`. **Cloudflare absorbs the load** — anon traffic hits
  Node once per minute regardless of spike size. Authed callers stay
  `private, no-store`.
- Auto-seed used `execSync` to spawn the seed script, freezing the worker
  for the seed duration on every cold start when DB was empty. Now `spawn`
  with prefixed stdout/stderr streaming.
- Asset-version cache-bust string was computed on every cold worker boot
  by walking `public/{css,js,assets}` (only ~50 files but still
  dozens of syscalls). Now `scripts/build-asset-version.js` writes
  `.builds/asset-version.txt` once at deploy (called from postinstall);
  app reads the file at boot, falls back to live walk only if missing.

### C. Repo hygiene
- 16 tracked scrape/cache JSONs at repo root (`*-scrape.json`,
  `geocode-cache.json`, `tasteatlas-*.json`, etc.) — all regenerable from
  the scripts. Untracked via `git rm --cached`; `.gitignore` now blocks
  the patterns at root only (anchored with `/`) so they don't accidentally
  match nested files of the same name.
- `notes/` flattened into `notes/sessions/` (dated) + `notes/reference/`
  (reusable docs).
- `HANDOFF.md` (2026-04-27 session log) moved to
  `notes/sessions/2026-04-27-handoff.md`. `SMOKE_TESTS.md` and
  `guidelines.md` (API key reference) moved to `docs/`.
- `.builds/` now fully gitignored — both the migrate sentinel and the new
  asset-version manifest are per-host state.

## Commits

- `ea1aaf0` — Visit/Favorite migration (the immediate outage fix).
- `58e13aa` — Phase 1 (strict migrate, async error wrapper, /api/health).
- `47d7cc1` — Phase 2 (HTTP cache, take cap, query collapse, non-blocking
  auto-seed, prebuilt asset manifest).
- (this commit) — Phase 3 (repo cleanup).

## What's still open (Phase 4 candidates)

Not done today, but flagged by the audit:
1. **Sitemap is sync I/O on hot path** (`src/routes/pages.js` — `fs.readFileSync`
   on cache miss blocks the worker). Move to async pre-build with a
   promise-lock against concurrent rebuilds.
2. **Rate limits are in-memory per worker.** Easy bypass by spreading
   requests across spawned workers. Either move to a Prisma-backed store
   or accept and document.
3. **Session secret falls back to `dev-secret-change-me`** — should throw
   on startup in production if `SESSION_SECRET` is unset.
4. **DEV_ADMIN_BYPASS=1** silently grants admin in any env. Add a
   `NODE_ENV !== "production"` guard.
5. **Cookie `secure: false`** even in production. Flip to
   `process.env.NODE_ENV === "production"`.
6. **Composite `[lat, lng]` index** on Place would make bounding-box
   queries faster; currently two separate single-column indexes.
7. **No real error monitoring.** Sentry free tier or a simple webhook on
   `[err]` log lines would let us catch the next outage in minutes, not
   hours. Both are within the "Hostinger + domain only" budget.

## How we ended up here

Three independent decisions stacked badly:
1. The Vrbo redesign commit changed the schema but the author skipped
   `prisma migrate dev` (probably because `db push` had been the local
   workflow earlier in the project — see the Hostinger Prisma runbook).
2. `scripts/migrate.js` was written to be lenient by default specifically
   to *avoid* deploys failing during the IOPS work earlier today. That
   leniency immediately backfired the next deploy.
3. Hostinger's Passenger fronts a generic 503 page when a worker can't
   handle a request, which obscured the real Prisma error in stderr.log
   from the 503 response itself.

None of these are mistakes of judgement in isolation. The lesson is they
need a safety net (the audit fixes), not a postmortem about who screwed
up. The audit fixes catch all three classes the next time they happen.
