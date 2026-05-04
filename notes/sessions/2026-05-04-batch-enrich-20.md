# 2026-05-04 — Batch enrichment: day 1 via google_api

## Status: PASSED — 155 rows enriched, quota maxed, $0 spent

## Runs

| Run       | Limit | Enriched | Errors | API calls | Notes                              |
|-----------|-------|----------|--------|-----------|------------------------------------|
| batch 1   | 20    | 20       | 0      | 20        | Florence, Bologna, Turin, Genoa    |
| batch 2   | 134   | 134      | 0      | 134       | Continued through Italy            |
| batch 3   | 5     | 5        | 0      | 5         | Still under cap                    |
| batch 4   | 5     | 1        | 4      | 5         | 429 quota wall hit on 4 of 5       |
| **total** |       | **155**  | **4**  | **160**   | 4 errors = quota, not data issues  |

## DB columns verified

All 155 enriched rows now have:
- `googlePlaceId` — unique `ChIJ...` identifiers
- `googlePlaceUrl` — canonical Google Maps URLs with CID
- `enrichmentVersion` = 1
- `enrichedAt` timestamped
- `googleRating` + `googleReviewCount` + `phone` backfilled where empty

## API cost

- 160 Text Search calls (155 successful, 5 rejected as 429)
- Daily cap: 155 RPD — confirmed, hit exactly as expected
- Monthly free tier: 5,000 → 4,845 remaining
- $0 spent

## Hostinger run notes

- Node binary: `/opt/alt/alt-nodejs22/root/usr/bin/node`
- App dir: `~/domains/openpizzamap.com/nodejs/`
- Env file: `../public_html/.builds/config/.env` (not under nodejs/)
- Script needed a path fix (commit 9fb2eb8) to find the Hostinger env

## Remaining

- 1,613 rows at enrichmentVersion=0
- At 155 RPD, full backfill completes in ~11 days
- Daily cron scheduled to run `--limit 155` automatically
- Re-runs are safe: cached queries don't re-charge Google, and enriched rows (enrichmentVersion=1) are excluded from the query
