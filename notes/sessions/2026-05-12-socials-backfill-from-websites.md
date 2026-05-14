# 2026-05-12 — Instagram + Facebook backfill from venue websites

## Status: SHIPPED — `dca66bd` (script + schema) + `4555bfc` (cron) on main

## TL;DR (for non-technical reading)

**Social-link coverage was almost nothing — 6 places out of 1,773 had an Instagram URL (0.3%), zero had Facebook.** Most pizzerias do link their socials, just from their own homepage rather than via any API. So instead of trying to scrape Instagram/Facebook (which aggressively block bots and have unusable APIs for our case), we **fetch each place's website and harvest the social links from the header/footer**. One polite HTTP request per place, no API keys, no ToS issues.

**50-place dry-run hit 66% Instagram and 60% Facebook.** Projecting over the 1,605 places that have a websiteUrl: ~1,060 IG + ~960 FB. Going from 0.3% to ~60% IG coverage in a single drain.

**GitHub Actions cron runs nightly at 03:00 UTC, 300 places/run, ~5 days to drain.** After that it picks up new imports automatically. Free — no API costs.

---

## What changed

### 1. `feat(socials): backfill Instagram + Facebook URLs from venue homepages` — `dca66bd`
- `prisma/schema.prisma:55` — added `facebookUrl String?` (mirrors `instagramUrl`)
- `scripts/backfills/backfill-socials-from-website.js` — new
  - Queues visible places with `websiteUrl` set AND (instagramUrl null OR facebookUrl null)
  - 800ms polite delay, 15s fetch timeout, 1.5MB HTML cap, identifying User-Agent
  - URL normalization with blocklist on non-profile paths:
    - IG blocks `p/`, `reel/`, `tv/`, `explore/`, `accounts/`, `share/`, etc.
    - FB blocks `sharer/`, `dialog/`, `plugins/`, `tr/`, `pages/category/`, etc.
  - Most-frequent-handle wins: if a homepage links the same IG handle 4 times in header+footer+meta, that's the venue's own profile (not a one-off collab mention)
  - Fill-only-if-null per the dedup-merge policy — never overwrites an existing value
  - Skips aggregator-host websites defensively (the import policy excludes them, but legacy rows might have slipped through)

### 2. `ci: daily socials backfill at 300 places/run` — `4555bfc`
- `.github/workflows/backfill-socials.yml` — new
- Daily at **03:00 UTC**, slot is clear of all other crons:
  - `:00` batch-enrich, `:15` osm-enrich, `:30` batch-enrich-burn, `02:30` backfill-tripadvisor
- 300 places × ~800ms = ~4 min runtime; ~5 days to drain the 1,605 backlog
- `workflow_dispatch` enabled for manual triggering
- Only secret needed is `DATABASE_URL` (already in repo secrets)

### 3. Schema pushed to prod
- Local `.env` points at the Hostinger DB, so `prisma db push` ran straight against production
- Added nullable column → no migration on existing rows, no downtime risk
- Schema is now slightly ahead of the deployed code (which doesn't read `facebookUrl` yet) — the safe direction

---

## Status snapshot before this session (what prompted it)

Quick enrichment status check showed:
- **94.8%** of places have `enrichedAt` set (1,680/1,773)
- **93%** have Google ratings, **91%** have hours, **99%** have hero images
- **84%** refreshed in the last 7 days — the 9× credit-burn cron from 2026-05-10 is doing its job
- Two visible gaps: **descriptions at 68%** (Gemini quota bottleneck), and **Instagram at 0.3%**, **Facebook nonexistent**

Eric asked for approaches on socials. Recommended the website-scrape route over IG/FB APIs (require business verification, page-admin auth — useless for public lookup) and direct scraping (bot-blocked, ToS).

---

## Dry-run yield (50 places)

| Field    | Hits | Rate |
|----------|------|------|
| Instagram | 33/50 | 66% |
| Facebook  | 30/50 | 60% |
| Fetch errors (5xx, timeouts, Cloudflare) | 4/50 | 8% |

Realistic ceiling is ~70% per field — the remaining 30% are places whose sites don't link socials, or Cloudflare-protected sites that return a challenge page instead of HTML, or the ~170 places with no website at all.

---

## Followups / decisions punted

- **Re-check rotation.** After the 5-day drain, ~600 places will still have null IG/FB. The cron will re-fetch them every 2 days forever, hammering the same small sites. Clean fix is a `socialsCheckedAt` column (mirrors `osmCheckedAt`) so the queue rotates. Wait and see how the drain goes before adding it — might be cheap enough at 600 fetches/day to leave alone.
- **No display layer yet.** Place pages don't render IG/FB icons. The data will sit in the DB until the place-page template starts consuming it. Pure data work this session.
- **OSM tags pass.** Secondary boost idea mentioned at the start of the session — re-pull `contact:instagram` / `contact:facebook` from OSM for the 1,200+ matched places. Not done; small expected yield (few hundred extras) and the website scrape covers most of the same venues.
- **Bot-blocked tail.** A Playwright fallback (like the gmaps resolver uses) would unblock Cloudflare-challenged sites. Probably not worth the complexity for socials specifically — the no-website tail is more impactful.

---

## Files

- `prisma/schema.prisma:55` — `facebookUrl` column
- `scripts/backfills/backfill-socials-from-website.js` — new (220 lines)
- `.github/workflows/backfill-socials.yml` — new (43 lines)
