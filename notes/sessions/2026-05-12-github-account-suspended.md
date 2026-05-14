# 2026-05-12 — GitHub account suspended (post socials-backfill manual run)

## Status: WAITING ON GITHUB SUPPORT — ticket **#4379194** open

## What happened

Within hours of shipping the new socials-backfill workflow (`4555bfc`) and running a single manual exec of `scripts/backfills/backfill-socials-from-website.js` against ~300 venue homepages, the `ericll93` GitHub account was suspended. Banner on login:

> Access to your account has been suspended due to a violation of our Terms of Service. Please contact support for more information.

No email, no specific reason cited. The manual run was the only socials job that fired (cron hadn't hit 03:00 UTC yet).

## Most likely cause

**Cumulative outbound HTTP from GitHub Actions runners**, flagged by GH's abuse heuristics. The socials run was probably the straw, not the load — the loud baseline was:

- `batch-enrich.yml` (every 3h, ~60 places/run)
- `batch-enrich-burn.yml` (hourly :30, ~60 places/run — added 2026-05-10 for GCP credit drain)
- `osm-enrich.yml` (daily)
- `backfill-tripadvisor.yml` (daily, 150 places/run)
- `backfill-socials.yml` (the new one — 300 third-party homepage fetches in one run)

GitHub Actions ToS specifically calls out activity that "places undue burden on a network." Even with polite delays (800ms) and identifying User-Agent, running outbound scrapes-at-scale from their runners trips the heuristic. This is a known sharp edge for hobby projects.

## What was sent to GH Support

Subject: **Appeal: Actions suspension on hobby project (openpizzamap.com)**

Body summarized: non-commercial hobby project, listed every workflow + cadence + rate-limit behavior, offered to remove all Actions crons and move them to Hostinger. Honest and specific — usually the right tone for first-time hobby suspensions.

## Damage assessment

- **Site is still live** — Hostinger keeps serving openpizzamap.com; auto-deploy is push-triggered, no pushes means no deploys, but nothing breaks.
- **Local repo intact** — commits can stack up locally, just can't push.
- **DB untouched** — Hostinger DB is independent of GitHub.
- **Crons are dead** until reinstatement — burn-mode, batch-enrich, all of them. GCP credit drain paused (which is fine, not load-bearing).

## Plan for the moment account is reinstated

1. **Delete `.github/workflows/backfill-socials.yml`** — clearly the trigger by timing, regardless of whether it was the only culprit.
2. **Dial back or delete `batch-enrich-burn.yml`** — hourly cadence is the next-loudest signal. Credit might be drained by then anyway.
3. **Move socials backfill to Hostinger cron** — outbound HTTP to 1,605 pizzeria sites is a normal app-server workload, totally unremarkable from Hostinger. GH Actions is the wrong home for this work; should've been Hostinger from day one.
4. **Possibly move all enrichment crons to Hostinger** — would also eliminate the `DATABASE_URL` secret being needed in GH Actions, simplifying the surface.

## Followups / decisions

- **DO NOT** create a new GitHub account or push from another identity while suspended — GitHub treats that as evasion and reinstatement gets much harder.
- **DO NOT** push anything from the local repo even if a workaround is found (e.g., via another git host). Wait for reinstatement so the cleanup commits land cleanly on the original repo.
- If reinstatement is denied (very unlikely for a first-time hobby case), fallback is GitLab or Codeberg + Hostinger cron — couple hours of work, no data lost.

## Lessons

- **GitHub Actions is for CI of *our* code, not for scraping *other people's* servers.** Even polite scrapes at hobby scale can trip abuse detection if they're frequent.
- Outbound HTTP backfills belong on an app server (Hostinger), not on shared CI infrastructure.
- Each new cron compounds the cumulative outbound-request signal — adding the 5th one is what pushed it over.

## Files referenced

- `.github/workflows/backfill-socials.yml` — to be deleted on reinstatement
- `.github/workflows/batch-enrich-burn.yml` — to be dialed back or deleted
- `scripts/backfills/backfill-socials-from-website.js` — keeps working, just runs from Hostinger cron instead

## Related

- `notes/sessions/2026-05-12-socials-backfill-from-websites.md` — the session that triggered this
- Ticket **#4379194** — GitHub Support
