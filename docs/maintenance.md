# Maintenance pipeline

Single endpoint, two schedules, every enrichment job in one place. Lives
in the live Hostinger app worker so cron-job.org only ever needs to ping
one URL.

## Why this exists

GitHub Actions banned `ericll93` on 2026-05-12 for cumulative outbound
HTTP from scheduled workflows
([session notes](../notes/sessions/2026-05-12-github-account-suspended.md)).
The 6 workflows were deleted on 2026-05-15 and the work has been paused
since. Hostinger's Business Node.js app plan does **not** expose cron
(that's the website / cPanel side, not the app side), so we use
[cron-job.org](https://cron-job.org) as the external scheduler — free,
unlimited jobs, no abuse policy against pinging your own server. All
the actual outbound traffic to Google / TripAdvisor / Instagram /
Facebook / Overpass originates from Hostinger, where it's just normal
app-server traffic.

The endpoint at [`POST /api/admin/maintenance`](../src/routes/api.admin.js)
runs the whole pipeline. Fire-and-forget: returns 202 immediately,
status pollable at `/api/admin/maintenance/status`.

## What runs

| Phase | Frequency | Mode: burn / min | Source of truth |
|---|---|---|---|
| `resolve` | every tick | 40 / 20 per tick | [src/services/enrichment/batch.js](../src/services/enrichment/batch.js) |
| `photos` | every tick | 40 / 20 per tick | [src/services/enrichment/batch.js](../src/services/enrichment/batch.js) |
| `reviews` | every tick | 40 / 20 per tick | [scripts/scrapers/scrape-reviews.js](../scripts/scrapers/scrape-reviews.js) |
| `descriptions` | every tick | 40 / 20 per tick | [scripts/enrichment/generate-descriptions.js](../scripts/enrichment/generate-descriptions.js) |
| `osm` | every tick | 20 / 20 per tick | [scripts/enrichment/enrich-osm.js](../scripts/enrichment/enrich-osm.js) |
| `tripadvisor` | 02:xx UTC daily | 150 / 130 | [scripts/enrichment/enrich-tripadvisor.js](../scripts/enrichment/enrich-tripadvisor.js) |
| `socials` | 03:xx UTC daily | 300 / 300 | [scripts/backfills/backfill-socials-from-website.js](../scripts/backfills/backfill-socials-from-website.js) |
| `opmRating` | 04:xx UTC daily | all rows | [scripts/backfills/backfill-opm-rating.js](../scripts/backfills/backfill-opm-rating.js) |
| `clearFallbackDescriptions` | every tick | n/a | inline helper, idempotent |
| `playwrightFallback` | every tick | 20 / 10 per tick | [scripts/enrichment/resolve-via-gmaps.js](../scripts/enrichment/resolve-via-gmaps.js) |

The hour-gated phases mirror the cadence the old GitHub workflows had,
collapsed into one endpoint. cron-job.org pings hourly (burn) or every
3 h (min) and the orchestrator decides which phases to actually run
based on the current UTC hour.

## Daily-limit math (min mode)

Targets every API's free daily allowance with safety margin:

| API | Free daily | Min mode aims for | Margin |
|---|---|---|---|
| Google Places (per-SKU post-March-2025) | ~166/day | 8 ticks × 20 = 160/day | 6/day |
| Gemini (`feedback_gemini_limits.md`) | 1500 RPD | 8 ticks × 20 = 160/day | 1,340/day |
| TripAdvisor (`feedback_tripadvisor_quota.md`) | 133/day cap (4k/mo) | 130/day | 100/mo |
| Overpass (politeness 1 qps) | ~unlimited | 160/day | trivial |

## Burn mode math (12-day GCP credit window)

Eric has ~12 days of GCP credit remaining. Google Places (New) Text
Search + Details together cost ~$30 / 1,000 calls. $200 / $30 × 1,000
= ~6,600 places resolvable. Across 24 hourly ticks × 12 days = 288
ticks → ~23 places/tick of actual API spend. We set burn=40/tick to
absorb cache hits + skipped rows; real billed calls stay inside the
credit window. The provider raises `QuotaExceededError` when the API
returns 429 / billing failure, and the orchestrator stops that phase
cleanly — no runaway spend.

## Install (one-time, takes 5 minutes)

### 1) Pick an admin API key

The endpoint is auth'd by `ADMIN_API_KEYS` (already set on Hostinger;
see [docs/api-keys.md](api-keys.md)). cron-job.org will send it as the
`x-api-key` header — never in the URL.

Pick **one** of the comma-separated keys from `ADMIN_API_KEYS` to give
cron-job.org. Treat it like a password.

### 2) Create two cron-job.org jobs

Sign in at [cron-job.org](https://cron-job.org) → Cronjobs → "Create
cronjob". Fields for each:

#### Job A — burn mode (enable now, disable on day 12 when credit expires)

| Field | Value |
|---|---|
| Title | `OpenPizzaMap — Burn (12 days)` |
| URL | `https://openpizzamap.com/api/admin/maintenance?mode=burn` |
| Request method | `POST` |
| Schedule | Every hour, minute `0` |
| Request headers | `x-api-key: <the key from step 1>` |
| Treat as success | HTTP `200` AND `202` (under "Advanced") |
| Notifications | email on failure (3 consecutive) |

#### Job B — min mode (enable when burn is disabled)

| Field | Value |
|---|---|
| Title | `OpenPizzaMap — Min (free tier sustain)` |
| URL | `https://openpizzamap.com/api/admin/maintenance?mode=min` |
| Request method | `POST` |
| Schedule | Every 3 hours, minute `0` |
| Request headers | `x-api-key: <the key from step 1>` |
| Treat as success | HTTP `200` AND `202` |
| Notifications | email on failure (3 consecutive) |

**Don't enable both simultaneously** — they share the same in-flight
lock, so the second one would just hit 409 Conflict on overlap, but
you'd be paying API quota twice for the same throughput. One mode at a
time.

### 3) Verify

After cron-job.org's first tick (look at its job-history page → must
show `202`):

```sh
curl -H "x-api-key: <key>" https://openpizzamap.com/api/admin/maintenance/status | jq .
```

You should see something like:

```json
{
  "ok": true,
  "running": true,
  "currentRun": { "mode": "burn", "startedAt": 1747567200000, "pid": 1234 },
  "lastRun": null,
  "recentRuns": []
}
```

Wait 5-10 minutes and re-hit `/status` — `running` drops to `false` and
`lastRun.phases` shows per-phase results.

A successful phase looks like one of these (depending on whether it's
in-process or spawned):

```json
{ "name": "resolve", "durationMs": 14302, "ok": true, "enriched": 38, "skipped": 2, "apiCalls": 76, "remaining": 1294 }
{ "name": "osm", "durationMs": 22118, "ok": true, "exitCode": 0, "stdout": "..." }
```

A failure (logged but doesn't abort the chain — next tick retries):

```json
{ "name": "reviews", "durationMs": 4231, "ok": false, "exitCode": 1, "stderr": "..." }
```

## Switching from burn → min on day 12

1. On cron-job.org: disable Job A (toggle off, don't delete — keeps the
   schedule available if you ever need to burn again).
2. Enable Job B.
3. Confirm the next tick comes from Job B and not both:
   ```sh
   curl -H "x-api-key: <key>" https://openpizzamap.com/api/admin/maintenance/status | jq '.lastRun.mode'
   ```

## Tuning

Per-phase limit overrides are accepted as query params, e.g.

```
POST /api/admin/maintenance?mode=burn&resolve=80&photos=80
POST /api/admin/maintenance?mode=min&skip=tripadvisor,socials
POST /api/admin/maintenance?mode=min&force=tripadvisor   # run a daily phase ad-hoc
```

Useful when Eric drops a fresh batch of places to import — bump
`resolve` for a few ticks to chew through them.

## Failure modes & their fixes

| Symptom in `/status` | Likely cause | Fix |
|---|---|---|
| `running: true` for hours | crash mid-run + stale lock | wait 40 min — the lock auto-expires and next tick reclaims it. Or `rm data/cache/maintenance.lock` via SSH. |
| `resolve.quotaHit: true` | Google credit exhausted | expected at end of burn window. Switch to min mode (Job A → off, Job B → on). |
| `descriptions.exitCode: 1` only | Gemini hit RPD or transient blip | next tick retries; check `stderr` if persists. See `feedback_gemini_limits.md` |
| All script-phase exits = null + `error: "Failed to spawn"` | child_process pattern fails on Hostinger | refactor those scripts to export `run()` and call in-process (the same pattern the resolve/photos phases use). |
| `tripadvisor`/`socials`/`opmRating` never run | hour-gate mismatch | confirm cron-job.org is hitting hourly during 02-04 UTC window. Override with `&force=tripadvisor,socials,opmRating` for an ad-hoc run. |

## The Playwright phase has a fallback plan

`playwrightFallback` runs `scripts/enrichment/resolve-via-gmaps.js`,
which drives a real Chromium browser to scrape phone / website / hours
/ rating from the Google Maps place panel — the *only* phase that can
recover the long-tail rows the Places API can't resolve (small-town
venues, name mismatches). Per the 2026-05-09 enricher-backlog notes
this was the phase that broke the most stuck rows during the previous
recovery.

It's the **last** phase in the orchestrator so a Chromium crash never
blocks the other 9 phases from running. If Hostinger shared hosting
doesn't have the required system libs (libnss3, libatk-bridge2.0-0,
fontconfig, etc.), the `/maintenance/status` JSON will show:

```json
{ "name": "playwrightFallback", "ok": false, "exitCode": null, "stderr": "Error: Failed to launch chromium..." }
```

**If that happens** (we'll know within an hour of the first burn-mode
tick), the followup is to move this one phase to Eric's Unraid box —
docker container with Node 20 + Playwright + a copy of the repo,
reading from the same Hostinger MySQL DB. Outbound HTTP from a home IP
is *less* CAPTCHA-prone than Hostinger's datacenter IP, so this would
actually be an upgrade for the Playwright fallback specifically. Every
other phase stays on Hostinger.

## What's intentionally NOT in this pipeline

- **Place imports** (`scripts/importers/import-places.js`) — run
  manually when Eric drops new places. Not on a schedule.

## Related

- [src/routes/api.admin.js](../src/routes/api.admin.js) — the endpoints
- [src/services/maintenance.js](../src/services/maintenance.js) — the orchestrator
- [src/services/enrichment/batch.js](../src/services/enrichment/batch.js) — resolve / photos / clearFallback helpers
- [notes/sessions/2026-05-12-github-account-suspended.md](../notes/sessions/2026-05-12-github-account-suspended.md) — why we're not on GH Actions
- [docs/enrichment-pipeline.md](enrichment-pipeline.md) — the underlying design doc
