# Setup: Google Maps API for OpenPizzaMap Enrichment

A click-by-click punch list for Eric to enable Places API + Geocoding
on a budget-capped GCP project. Goal: **never spend a cent**, by
setting hard quotas at the free-tier limits Google introduced on
2025-03-01, with a $1 budget alert as the tripwire underneath.

> **Pricing model note:** the old "$200 monthly credit" was retired
> on 2025-03-01. Google now offers **per-SKU monthly free calls**
> (verify at <https://mapsplatform.google.com/pricing/>):
>
> | SKU                                | Free / month | Cost after |
> |------------------------------------|--------------|------------|
> | Places API (New) — Text Search     | 5,000        | $32/1k     |
> | Places API (New) — Place Details Essentials | 10,000 | $5/1k      |
> | Geocoding API                      | 10,000       | $5/1k      |
>
> 5,000 Text Search calls/month ≈ 5,000 fully-resolved place imports
> per month. OpenPizzaMap's actual import rate is ~100–200 places/week,
> so the free tier has ~25× headroom even on busy weeks.

> **Read first:** the architectural background lives in
> [docs/enrichment-pipeline.md](enrichment-pipeline.md). This file is
> only the GCP setup recipe.

---

## 0. What you'll end up with

- A GCP project with **Places API (New)** + **Geocoding API** enabled.
- One restricted API key (HTTP referrers + IP allowlist).
- Hard daily quotas on each API such that **the monthly call total
  cannot exceed the per-SKU free tier**, so the bill stays at $0.
- A budget alert at $1 (yes, one dollar) as a tripwire in case any
  of the above fails (quota edit pending, pricing change, etc.).
- The key pasted into Hostinger env as `GOOGLE_MAPS_API_KEY`.
- The toggle `ENRICHMENT_PROVIDER=google_api` enabled in Hostinger.

Everything below, end-to-end, takes ~25 minutes.

---

## 1. Create or pick the GCP project

If you already have a project for OpenPizzaMap, skip to §2.

1. Go to <https://console.cloud.google.com>.
2. Top bar → click the **project selector** (left of the search bar).
3. **NEW PROJECT** (top right of the modal).
4. Project name: `openpizzamap-enrichment`.
   Project ID will auto-derive — copy it down, you'll need it.
5. Organization / location: leave whatever default Google suggests.
6. **CREATE**. Wait ~30 s.
7. Project selector → pick `openpizzamap-enrichment`.

**Verify billing is attached** (Google requires a billing account on
file even though you stay inside the free tier — without it the
APIs reject all calls):
- Left menu → **Billing**.
- If it says "This project has no billing account": click **LINK A
  BILLING ACCOUNT** and pick yours.

---

## 2. Enable the APIs

1. Left menu → **APIs & Services** → **Library**.
2. Search for `Places API (New)`. Click the result. Click **ENABLE**.
3. Back to Library. Search for `Geocoding API`. Click. **ENABLE**.
4. (Optional, only if we end up using autocomplete on the submission
   form — see [docs/enrichment-pipeline.md §6](enrichment-pipeline.md#6-manual-flow-web-form)):
   search for `Places API`. Note: this is the *legacy* one — only
   enable if Places API (New) doesn't cover Autocomplete in your
   region. Otherwise skip.

You should now see all enabled APIs at **APIs & Services → Enabled
APIs & services**.

---

## 3. Generate the API key

1. Left menu → **APIs & Services** → **Credentials**.
2. Top bar → **+ CREATE CREDENTIALS** → **API key**.
3. Modal shows the new key. **DON'T copy and paste it into the
   browser yet** — restrict it first (next step). Click **EDIT API
   KEY**.

---

## 4. Restrict the key

This is the most important step. An unrestricted key that leaks
(commit, screenshot, browser devtools) is a **direct billing risk**.

### 4a. Application restrictions

You have two options. Pick **one**.

**Option A — single key, dual restrictions** (simpler):

1. Application restrictions → select **HTTP referrers (web sites)**.
2. **ADD AN ITEM** for each:
   - `https://openpizzamap.com/*`
   - `https://*.openpizzamap.com/*`
3. Save.

Caveat: this works for browser-side calls only. Server-side calls from
Hostinger (the importers, the enricher) won't have a `Referer` header
that matches. **For server-side use, do Option B.**

**Option B — two keys, one for browser one for server** (recommended):

1. **First key** (browser) — leave the one you just made. Apply HTTP
   referrer restriction as in Option A. Rename to
   `OpenPizzaMap-Browser`.
2. **Create a second key.** APIs & Services → Credentials → **+ CREATE
   CREDENTIALS** → **API key**. Rename to `OpenPizzaMap-Server`.
3. Application restrictions → select **IP addresses**.
4. Add Hostinger's outbound IP. To find it:
   ```sh
   ssh -p 65002 u975898812@92.113.28.98 'curl -s https://ifconfig.me'
   ```
   Paste that IP into the restriction list. (Hostinger's outbound IP
   has been stable; if it ever changes, the key will start returning
   403 and you re-run the above.)

For now we only need the **server key** — the importers run
server-side. Browser key is for the future autocomplete UX.

### 4b. API restrictions

Both keys, same step:

1. API restrictions → select **Restrict key**.
2. Tick: **Places API (New)** + **Geocoding API**.
3. Untick everything else. (Leaving keys broad is the second-most
   common way they get abused.)
4. **SAVE**.

You should now see your key(s) on the Credentials page with
restrictions listed underneath each.

---

## 5. Set hard daily quotas

This is the layer that **mathematically prevents overspend** even if
the key leaks. The budget alert (§6) is just a notification — quotas
are the actual brake.

### 5a. The math

Google's per-SKU free tier (verify on
<https://mapsplatform.google.com/pricing/> — pricing model changed
2025-03-01):

| API                          | Free / month | Cost after free | Cost per 1 call |
|------------------------------|--------------|-----------------|-----------------|
| Places API (New) Text Search          | 5,000  | $32 / 1k  | $0.032 |
| Places API (New) Place Details Essentials | 10,000 | $5 / 1k  | $0.005 |
| Geocoding API                | 10,000       | $5 / 1k         | $0.005          |

**The plan:** cap each API's daily quota so the *monthly total can
never exceed the free tier*. Then we literally cannot spend money,
no matter what the code does.

Daily caps with a small safety margin (≈ 5 %), assuming a 30-day
month:

| API                | Free / month | Daily cap (free / 30 × 0.95) | Why this cap is enough |
|--------------------|--------------|------------------------------|------------------------|
| Places Text Search | 5,000        | **155**                      | ~155 new place imports/day. Real volume is 100–200/week — 25× headroom. |
| Places Details     | 10,000       | **315**                      | ~2× the Text Search cap, since each place may need 1–2 detail calls. |
| Geocoding          | 10,000       | **315**                      | Mostly a fallback; rarely hit if Places already returns coords. |

If a burst import ever bumps the cap, the API returns 429
(`RESOURCE_EXHAUSTED`) and our pipeline falls back to Playwright (free)
for the rest of the day. No outage, no spend.

> **If you'd rather have more daily headroom and accept some
> spend-risk:** raise the caps to e.g. 300 / 600 / 600 and rely on
> the budget alert (§6). Not recommended — sticking to the free tier
> is the whole point.

### 5b. Apply the quotas

1. Left menu → **IAM & Admin** → **Quotas & System Limits**.
2. In the filter bar, type `Places API (New)`.
3. Find **`Text search requests per day`** (or `Requests per day`
   depending on Google's labelling). Tick the row.
4. Top bar → **EDIT QUOTAS**.
5. Modal: set **New limit = 155**. Reason = "OpenPizzaMap free-tier
   cap". **SUBMIT REQUEST**.
6. Repeat for **`Place Details (Essentials) requests per day`** → set
   to **315**.
7. Filter bar → `Geocoding API`. Find **`Requests per day`** → set to
   **315**.

**Note:** some quotas can be edited instantly; others need Google's
manual approval (24–48 h). If your edit shows "Pending", that's
normal. The default daily quota is *higher* than what you're setting,
so the new (lower) cap takes effect once approved. In the meantime,
the budget alert (next step) is your fallback.

---

## 6. Budget alert at $1

Defensive layer. Quotas should make this never fire — but if a
quota edit hasn't been approved yet, or Google changes pricing, this
is the tripwire.

1. Left menu → **Billing** → **Budgets & alerts**.
2. **CREATE BUDGET**.
3. **Name:** `OpenPizzaMap $1 tripwire`.
4. **Scope:** Projects → tick `openpizzamap-enrichment`. (Don't leave
   it on "All projects" — you'll get noise from other work.)
5. **Amount:** Specified amount → **$1** (one dollar). Yes, really.
6. **Threshold rules:** keep the defaults (50%, 90%, 100%) plus add
   one at **150%** for good measure.
7. **Notifications:** tick **Email alerts to billing admins and
   users**. Make sure your email is on the billing account
   (Billing → Account management → Members).
8. **FINISH**.

If this email ever arrives, **stop the importer immediately** and
investigate. A spend at all means the per-SKU free quota was
already exceeded — i.e. the daily caps from §5 didn't apply (still
pending approval, or a SKU was missed). Hitting $1 still doesn't
hurt, but it's a sign the quota layer needs attention.

---

## 7. Add the key to Hostinger

1. Hostinger hPanel → **Websites** → `openpizzamap.com` → **Advanced**
   → **Environment variables**.
2. Add:
   - `GOOGLE_MAPS_API_KEY` = (paste your **server** key from §4b).
   - `ENRICHMENT_PROVIDER` = `google_api` (only when you're ready to
     flip the switch — leave it at `playwright` until then).
3. **Save**.
4. Restart the Node app:
   - Either click hPanel → **Node.js app** → **Restart**, or
   - SSH and `touch tmp/restart.txt && touch src/app.js`. (See
     [docs/runbook.md](runbook.md) for the full restart recipe.)

For local dev, add the same vars to `.env.local`. **Don't commit the
key.** `.env*` is already in `.gitignore`.

---

## 8. Verify it works

Once the implementation phase is done (see
[docs/enrichment-pipeline.md §12](enrichment-pipeline.md#12-rollout)),
there will be an admin endpoint:

```
GET /api/admin/test-enrichment?name=Sorbillo&city=Naples
```

Hit it with your admin session cookie or admin API key. Expected
response:

```json
{
  "ok": true,
  "provider": "google_api",
  "result": {
    "googlePlaceId": "ChIJ...",
    "canonicalName": "Gino Sorbillo Pizzeria",
    "formattedAddress": "Via dei Tribunali, 32, 80138 Napoli NA, Italy",
    "lat": 40.8512, "lng": 14.2563,
    "rating": 4.4, "ratingCount": 12345
  },
  "callsMade": 1,
  "callsRemainingToday": 99
}
```

**Expected: exactly 1 API call.** If `callsMade > 1` for a previously
seen query, the cache layer is broken — investigate before running
imports.

---

## 9. Troubleshooting

| Symptom                           | Likely cause                              | Fix |
|-----------------------------------|-------------------------------------------|-----|
| `403` `REQUEST_DENIED` with "API not authorized" | Key restrictions don't include Places/Geocoding | Re-check §4b |
| `403` with "referer not allowed"  | Server-side call hitting a referer-restricted key | Use the IP-restricted server key from §4a Option B |
| `403` with "ip not allowed"       | Hostinger outbound IP changed             | Re-run `curl -s https://ifconfig.me` from SSH and update §4a |
| `429` `RESOURCE_EXHAUSTED`        | Daily quota hit                           | Expected. Pipeline falls back to Playwright. Verify in `enrichment.log`. |
| `400` `INVALID_REQUEST`           | Pipeline sent a malformed query           | Check the pipeline's input — usually empty `name` or `city` |
| Budget alert fires at all         | Quotas didn't apply or pricing changed    | **Stop importer.** Check §5b "Pending" status. |
| Endpoint returns `provider: "playwright"` when you set `google_api` | Env var didn't load | Restart Passenger. Check `printenv GOOGLE_MAPS_API_KEY` via SSH. |

---

## 10. When you're done

Tell me ("Eric, I've finished steps 1–7") and I'll proceed with phase
2 of the implementation. Until then the pipeline stays on
`ENRICHMENT_PROVIDER=playwright` (free) and nothing changes for the
existing imports.
