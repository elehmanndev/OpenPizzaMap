# Unraid maintenance container

The OpenPizzaMap maintenance pipeline runs from a Docker container on
Eric's Unraid box. Hostinger can't host this work itself (see
`notes/sessions/2026-05-17-cloudflare-cdn-setup.md` and follow-up; the
short version: Hostinger's web-worker LVE blocks Chromium, and the user
`crontab` is disabled).

This doc is the setup playbook + the day-to-day "how do I check it's
running" commands.

## Architecture

```
┌────────────────────────────────┐   outbound HTTPS to    ┌──────────────────────────┐
│  Unraid                        │   Google, TripAdvisor, │  Hostinger               │
│                                │   Overpass, IG/FB, …   │                          │
│  Docker container "opm-runner":│ ─────────────────────► │  Express app serves      │
│    Playwright + Node 20        │                        │  openpizzamap.com        │
│    Repo cloned at build time   │                        │                          │
│    Internal hourly loop calls  │   MySQL TCP 3306       │  Hostinger MySQL         │
│    runMaintenance({mode:burn}) │ ─────────────────────► │   (srv1649.hstgr.io,     │
│                                │   (auth via password)  │    `%` whitelisted)      │
└────────────────────────────────┘                        └──────────────────────────┘
```

One container, one process, one set of logs. No cron-job.org, no SSH
tunnel, no split execution. Hostinger MySQL `%`-host whitelist is what
makes the direct connection possible — see the `Hosts remotos MySQL`
panel in hPanel.

## Build the image

On Unraid (via the terminal or any host that can build the image):

```sh
docker build --no-cache -f Dockerfile.unraid -t opm-runner:latest \
  https://github.com/elehmanndev/OpenPizzaMap.git
```

The `--no-cache` ensures `git clone` actually runs (otherwise Docker
caches the layer and you stay on the old commit forever — the most
common "why isn't my new code running" gotcha with this setup).

Image size will be ~2 GB once built (Playwright base + Chromium +
node_modules). One-time cost; rebuilds reuse the base.

## Set up the Unraid template

In Unraid's web UI:

1. **Docker tab** → **Add Container**
2. Fill the template:

| Field | Value |
|---|---|
| Name | `opm-runner` |
| Repository | `opm-runner:latest` (the local image you just built) |
| Network Type | `bridge` |
| Console shell command | `bash` |
| Privileged | OFF |
| Auto-restart | `unless-stopped` |

3. Add these **environment variables** (click "Add another Path, Port,
   Variable, Label or Device" → "Variable"):

| Name | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `mysql://u975898812_OpenPizzaiolo:<PASSWORD>@srv1649.hstgr.io:3306/u975898812_OpenPizzaMap` | Same value as Hostinger's `.env` — pull from there |
| `GOOGLE_MAPS_API_KEY` | `<value>` | From Hostinger `.env` |
| `GEMINI_API_KEY` | `<value>` | From Hostinger `.env` |
| `TRIPADVISOR_API_KEY` | `<value>` | From Hostinger `.env` |
| `RUNNER_MODE` | `burn` | "burn" until GCP credit runs out, then switch to "min" |
| `RUNNER_INTERVAL_MS` | `3600000` | 1 hour between ticks |
| `HOSTINGER_URL` | `https://openpizzamap.com` | Base URL of the live app. Each tick POSTs to `/api/admin/maintenance?only=localizeImages` so the file-writing phase runs on Hostinger's filesystem (the bytes can't land on Unraid). Omit to disable the dispatch. |
| `ADMIN_API_KEY` | `<value>` | First key from Hostinger's `ADMIN_API_KEYS` env. Sent as `x-api-key` header on the localize-images ping. |
| `NODE_ENV` | `production` | |

4. **Volume mount** (optional but recommended — caches survive rebuilds):

| Container path | Host path |
|---|---|
| `/app/data/cache` | `/mnt/user/appdata/opm-runner/cache` |

This keeps `gmaps-resolve-cache.json`, `osm-resolve-cache.json`,
`google-reviews-cache.json`, and `maintenance-status.json` across
container rebuilds. Without it, every rebuild re-scrapes content
we've already paid for.

5. Click **Apply**. Unraid pulls the image and starts the container.

## Verify it's running

```sh
docker logs -f opm-runner
```

Within a few seconds you should see:

```
[runner] starting — mode=burn interval=3600000ms skip=[]
[runner] === tick 1 (mode=burn) ===
```

After ~5 minutes (one full burn tick at burn limits):

```
[runner] tick 1 complete in 264.3s
[runner]   resolve: OK (1247ms) enriched=12 dupes=24
[runner]   photos: OK (8932ms) updated=8
[runner]   reviews: OK (17804ms) saved=40
[runner]   descriptions: OK (164120ms) written=38
[runner]   osm: OK (44312ms) resolved=11
[runner]   tripadvisor: SKIP (not scheduled this hour)
[runner]   socials: SKIP (not scheduled this hour)
[runner]   opmRating: SKIP (not scheduled this hour)
[runner]   clearFallbackDescriptions: OK (7ms) cleared=0
[runner]   playwrightFallback: OK (94221ms) resolved=14
```

If any phase says FAIL, the message in parentheses tells you what
broke. Most common first-run issues:

| Symptom | Likely cause | Fix |
|---|---|---|
| All phases fail with `getaddrinfo ENOTFOUND srv1649.hstgr.io` | Container's DNS isn't resolving | Add `dns: ['1.1.1.1', '8.8.8.8']` to the Unraid template |
| `resolve` fails with `Access denied for user` | Wrong DB password | Re-check `DATABASE_URL` |
| `playwrightFallback` fails with `Executable doesn't exist` | Chromium not in the Playwright image | Image mismatch; rebuild with the exact `v1.59.1-jammy` tag |
| Container exits after one tick | Crash in `runner.js`; check `docker logs` | Paste error into Claude session |

## Switching modes

When the GCP credit window ends (~12 days from 2026-05-17), edit the
container template:

```
RUNNER_MODE: burn → min
RUNNER_INTERVAL_MS: 3600000 → 10800000   # 3 hours
```

Apply. The container restarts automatically with the new env.

## Updating the runner code

When you push new commits to `main`, the container keeps running the
OLD code (it cloned at build time). To pick up changes:

```sh
docker build --no-cache -f Dockerfile.unraid -t opm-runner:latest \
  https://github.com/elehmanndev/OpenPizzaMap.git
docker restart opm-runner
```

Or in the Unraid UI: container's "Update" / "Force update" button.

## Checking enrichment progress

Same audit endpoints as before — still available on Hostinger, just
not used for scheduling:

```powershell
# Coverage watcher — counts of stuck rows and queue depths
Invoke-RestMethod -Uri "https://openpizzamap.com/api/admin/audit/coverage" `
  -Headers @{"x-api-key"="e18eb33d9c88f7005efdefaedda2e79fb2f12726d4d5060a96c41efcdad5d757"} `
  | ConvertTo-Json -Depth 6
```

Trend the `missing` and `stuck` counts day-over-day. They should all
shrink as the runner ticks through the backlog.

## Stopping

```sh
docker stop opm-runner
```

SIGTERM is handled cleanly — the runner finishes the current tick
(no half-applied DB writes) then exits. Worst case the stop hangs for
~5 minutes if a Gemini call is mid-flight.
