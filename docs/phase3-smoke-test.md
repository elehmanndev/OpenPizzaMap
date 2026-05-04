# Phase 3 — Smoke test recipe

After Phase 2 has shipped (commit `84a2a0d`), this is the click-by-click
to flip Eric's setup from `playwright` (free fallback) to `google_api`
(paid-but-capped) and verify the live API call works.

> **Status check first:** confirm
> [docs/setup-google-maps-api.md](setup-google-maps-api.md) §1–§7 are
> done. You should already have:
> - `GOOGLE_MAPS_API_KEY` set in Hostinger env (with the restricted
>   key that has IP=92.113.28.98 + Places + Geocoding only)
> - Hard quotas applied (155/315/315/50×4)
> - $1 budget alert on the project
>
> If any of those is missing, **stop** and finish setup-google-maps-api.md
> first.

---

## Step 1 — Flip the toggle

In Hostinger hPanel:

1. **Websites → openpizzamap.com → Advanced → Environment variables**
2. **+ Add variable** (or edit if it exists):
   - Name: `ENRICHMENT_PROVIDER`
   - Value: `google_api`
3. **Save**.
4. Restart the Node app:
   - hPanel → **Node.js app → Restart**, or
   - SSH: `ssh -p 65002 u975898812@92.113.28.98 "cd ~/domains/openpizzamap.com/public_html && touch tmp/restart.txt && touch src/app.js"`

Wait 60-120s for Passenger to respawn.

---

## Step 2 — Smoke test via the admin endpoint

Hit the verification endpoint with your admin session:

```
GET https://openpizzamap.com/api/admin/test-enrichment?name=Sorbillo&city=Naples&country=Italy
```

Easiest way: log in to the admin panel in your browser first (any
admin page), then paste that URL in the address bar. Browser sends
your session cookie.

**Expected response:**

```json
{
  "ok": true,
  "provider": "google_api",
  "callsMade": 1,
  "verdict": {
    "action": "merge_into" | "insert",
    "providerUsed": "google_api",
    "reasons": [...],
    "resolved": {
      "googlePlaceId": "ChIJ...",
      "canonicalName": "Gino Sorbillo Pizzeria",
      "formattedAddress": "Via dei Tribunali, 32, 80138 Napoli NA, Italy",
      "lat": 40.8512, "lng": 14.2563,
      "rating": 4.4,
      "ratingCount": 12345,
      ...
    },
    "coords": {
      "chosenLat": 40.8512,
      "chosenLng": 14.2563,
      "source": "resolved",
      ...
    },
    "existing": null | { "id": ..., "name": "...", "slug": "..." }
  }
}
```

### Pass criteria

- `provider: "google_api"` — confirms toggle took effect.
- `callsMade: 1` — confirms exactly one API call. If `> 1`, cache layer is broken.
- `verdict.providerUsed: "google_api"` — no fallback to Playwright.
- `verdict.resolved.googlePlaceId` is a string starting with `ChIJ` — that's the canonical Google place ID.
- `verdict.resolved.lat/lng` near `40.85, 14.26` (Naples).

### Cache check

Hit the same URL again. **Expected: `callsMade: 0`** — the second call
is served from `EnrichmentCache`, no API call. If `callsMade: 1` again,
caching is broken.

### Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `provider: "playwright"` | Env var not loaded | Restart didn't take effect — try SSH `touch src/app.js` |
| 403 from upstream + `error: "REQUEST_DENIED"` | Key restrictions wrong | Re-check [setup-google-maps-api.md](setup-google-maps-api.md) §4 |
| 403 + "ip not allowed" | Hostinger outbound IP changed | Re-run `curl -4 ifconfig.me` from SSH and update IP allowlist |
| 429 / `QuotaExceeded` | Daily quota hit (very unlikely on first call) | Check GCP quotas page |
| `callsMade > 1` for cached query | Cache write failed | Check DB connection, EnrichmentCache table exists |

---

## Step 3 — Live import batch (≤20 rows)

Once the smoke test passes, run a small import to validate the
end-to-end flow.

**SSH to Hostinger** and from the app dir:

```sh
node scripts/import-places.js --limit 20
```

You'll need a fresh source JSON in repo root. Easiest: copy one of
the existing scrape-result files to a new name and trim to 20 rows.

Or, more pragmatically, trigger a re-import of an existing source —
the pipeline is idempotent, so it'll mostly hit the dedup gate
(`merge_into`) instead of creating new rows. That's still a useful
test because it exercises:
- 20 × `findPlace` (Google API call, then cached)
- 20 × dedup gate (mostly hits via `googlePlaceId` after the first row
  populates the column on update)
- coord drift detection on rows whose existing coords differ from
  Google's

**Expected output:**

```
[mode] dry-run=false no-geocode=false limit=20
...
[write] cities=N created=A enriched=B untouched=C flagged=D sources=E
```

Where:
- `created` = brand new rows (rare on a re-import)
- `enriched` = rows where the pipeline added `googlePlaceId` or filled missing fields
- `untouched` = rows where the pipeline matched but found nothing new to fill
- `flagged` = rows that hit `manual_review` (coord-drift > 1 km AND no resolved match, etc.) — should be 0 or close to 0 for a known-good source

Watch the console for `[coord-drift]` and `[review]` lines — these are
the bugs we wanted to catch (50 Kalò Piemonte etc.).

---

## Step 4 — Check usage in GCP

Within 24 h, head to **GCP → APIs & Services → Metrics** and filter
to **Places API (New)**.

**Expected:**
- ~21 Text Search calls total (1 smoke test + 20 imports — minus any
  cache hits within the batch).
- Spend: $0.00 (free tier covers up to 5,000/month).

If you see > 50 calls, something's wrong with caching — check the
EnrichmentCache table directly:

```sql
SELECT provider, COUNT(*), MIN(createdAt), MAX(createdAt)
FROM EnrichmentCache
GROUP BY provider;
```

---

## Step 5 — Watch budget alert

You should NOT receive a budget alert email. If you do, **stop
imports immediately** and check:
1. Is `ENRICHMENT_PROVIDER` accidentally pointing at a non-restricted
   key?
2. Did the daily quota edits get applied (vs. still "Pending approval"
   in GCP)?
3. Are there any other GCP services in this project burning quota
   (Gemini)?

---

## Rollback

If anything goes sideways and you want to revert to the free
Playwright path:

1. hPanel → env vars → set `ENRICHMENT_PROVIDER=playwright` (or
   delete the variable entirely; default is playwright).
2. Restart Passenger.
3. Re-hit `/api/admin/test-enrichment` — should return
   `provider: "playwright"`.

No data is lost. Rows already enriched with `googlePlaceId` keep that
field; re-imports will skip the API call entirely (cache hit).

---

## When phase 3 is done

After this recipe completes successfully, OpenPizzaMap is on the
production-grade enrichment pipeline. New imports will:
- Resolve identity via Google Places (canonical names + IDs)
- Catch coord-mislabel bugs before insert (50 Kalò class)
- Dedup via `googlePlaceId` for new rows + bbox+name fallback for legacy

Future phases (separate sessions, see
[docs/enrichment-pipeline.md §10](enrichment-pipeline.md#10-open-questions--future-phases)):
- Description generation from Google reviews
- Periodic refresh of stale rows
- Backfill of the ~1,500 legacy rows
- TripAdvisor full integration if useful
