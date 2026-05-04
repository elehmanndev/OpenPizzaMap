# 2026-05-04 — Enrichment pipeline design + GCP setup

Two-fer day. **Phase 1**: design doc and Google Cloud Platform setup punchlist for a new identity-resolution pipeline that fixes the import-quality issues that have piled up over the last week. **Phase 2** (implementation): not started — gated on Eric's review of the design.

## Why this refactor

Today's bulk imports keep producing low-quality rows. Concrete incidents from the past week that motivated this:

- **50 Kalò (Naples)** — coords landed in Piemonte, ~178 km off. Source had bad lat/lng and nothing cross-checked.
- **7 Sensi (Lanzarote)** — `city = "Las Palmas"` (the province, not the actual town).
- **Pizzeria Starita a Materdei** — duplicated until [c935e4c](../../scripts/import-places.js) added prefix-strip + 200 m Haversine fallback. That's a symptom-patch, not identity.
- **Castellón / Castellón de la Plana** — same city, duplicates created.
- **Sevilla centroid pile-up** — multiple unrelated venues pinned to centre of Sevilla because the geocoder fell back to "city centre".
- **Generic descriptions** — sources hand us marketing copy, we pass it through.

Common thread: we optimised for import volume, with verification scripts ([audit-geocodes.js](../../scripts/audit-geocodes.js), [fix-seville-centroids.js](../../scripts/fix-seville-centroids.js), [dedup-apply-high-confidence.js](../../scripts/dedup-apply-high-confidence.js)) running *after* damage is done. There was no single step that asked "does this venue exist, is it really at coord Y, what's its canonical name?" before the row hits `Place`.

## What was decided

A single function `enrichAndValidate(rawPlace)` that runs every raw place — from importer or web form — through 7 cribas before the DB sees it: Source → Identity Resolution (provider) → Cross-source corroboration → Quality gate → Dedup → Coord sanity → Persist + audit. Provider is pluggable: Playwright (default, free, existing [scripts/lib/gmaps.js](../../scripts/lib/gmaps.js)), Google API (env-toggled, paid), TripAdvisor (stub). Dedup gate uses `googlePlaceId` as canonical identity, with the existing slug + name+coord fallbacks layered underneath.

Schema: 3 new columns on `Place` (`googlePlaceId @unique`, `googlePlaceUrl`, `enrichmentVersion`). All nullable — no break to existing flow.

## Docs landed

- [docs/enrichment-pipeline.md](../../docs/enrichment-pipeline.md) — design doc. Problem, goals, non-goals (no legacy migration in this phase), 7 pipeline steps with fallbacks, provider abstraction, schema impact, manual-flow integration into [api.submissions.js](../../src/routes/api.submissions.js), fallback rules table, testing strategy with E2E fixture against the bad cases above, 4-phase rollout.
- [docs/setup-google-maps-api.md](../../docs/setup-google-maps-api.md) — click-by-click GCP punchlist. Project setup, key restrictions (IP + API allowlist), hard daily quotas calibrated to stay inside the per-SKU free tier, $1 budget alert tripwire, Hostinger env wiring, troubleshooting.

Commits: [f02c450](https://github.com/ericll93/OpenPizzaMap/commit/f02c450) (initial), [12ec68d](https://github.com/ericll93/OpenPizzaMap/commit/12ec68d) (pricing fix — see below).

## Pricing model fix

First version of the doc assumed Google's old "$200/month free credit" model. **That was retired 2025-03-01**. Verified directly with WebFetch on `mapsplatform.google.com/pricing/`:

> "Starting March 1, 2025, we have replaced the USD $200 monthly credit with free monthly calls per SKU."

Real per-SKU free tier:

| SKU                                | Free / month | Cost after | Daily cap chosen |
|------------------------------------|--------------|------------|------------------|
| Places API (New) — Text Search     | 5,000        | $32/1k     | **155**          |
| Places API (New) — Place Details Essentials | 10,000 | $5/1k      | **315**          |
| Geocoding API                      | 10,000       | $5/1k      | **315** (v3) / **50** (each v4) |

Daily caps = `monthly_free / 30 × 0.95`. Math: at 100% utilisation of the daily cap × 30 days, monthly total stays inside the free tier with ~5% margin. **Spend is mathematically impossible** as long as the caps are enforced; if a burst exceeds them, Google returns 429 and the pipeline falls back to Playwright (free) for the rest of the day.

Net effect: more headroom than the old $200 model would have allowed (~5,000 imports/month free vs ~3,000 under the old credit allocation we'd designed).

## GCP setup walkthrough (live with Eric)

Done step-by-step today. Final state:

- **Project**: reused existing `openpizzamap` (which already had Gemini API). Eric chose option B (single project) over option A (separate Maps project) for simpler ops.
- **APIs enabled**: Places API (New), Geocoding API.
- **API key**: new dedicated `Openpizzamap Maps API Key` with:
  - Application restriction = IP addresses, allowlist `92.113.28.98` (Hostinger outbound IPv4, fetched live via SSH `curl -4 ifconfig.me`).
  - API restrictions = Places API (New) + Geocoding API only, everything else unticked.
- **Hard quotas**:
  - `SearchTextRequest per day` → 155
  - `GetPlaceRequest per day` → 315
  - `Geocoding v3 requests per day` → 315
  - `Geocoding v4 GeocodeAddress / GeocodeLocation / GeocodePlace / SearchDestinations per day` → 50 each (defensive — endpoints we don't use)
- **Budget alert**: $1 monthly, scoped to `openpizzamap` project only, thresholds 50/90/100/150%, email notifications enabled.
- **Hostinger env**: `GOOGLE_MAPS_API_KEY` set. **`ENRICHMENT_PROVIDER` deliberately NOT set** — stays at default (Playwright, free) until phase 2 implementation lands and is verified.

Hostinger outbound IPv6 came back from `ifconfig.me` once but `api.ipify.org` returned empty for `-6`. Decision: cap defensively at IPv4 only — if we ever see 403s from IPv6 egress, add `2a02:4780:27:1749:0:3a2b:8bc:1` to the allowlist later.

## Cost guard cross-check (Gemini Cloud Assist agent)

Eric asked the GCP agent to audit. Agent couldn't read most state (Service Usage API + API Keys API + Billing API blocked for it). The one useful confirmation: **monthly spend €0.00 out-of-pocket**; the €0.10 Gemini overage from earlier in the day was absorbed by promotional credits.

## Pending — flagged but not done today

1. **Rotate the leaked Gemini key.** Earlier in the chat Eric pasted the existing `AIzaSyC6uH...` key (the one Gemini uses) in plain text. It's now in chat history. Risk is low — chat is private — but best practice says rotate. Eric's explicit call: "no te preocupes por eso ahora", do it later. Not urgent but real.
2. **Phase 2 implementation.** Schema migration, `src/services/enrichment/` module, `PlaywrightProvider` adapter wrapping the existing `gmaps.js`, fixture-based E2E test, swap `import-places.js` and submission-approval to call `enrichAndValidate`. All Playwright still — zero spend. Eric to give the go signal.
3. **Phase 3 (live API)**. After phase 2 ships clean, flip `ENRICHMENT_PROVIDER=google_api` in Hostinger, restart, run a 20-row test batch, watch the audit log.
4. **Service Usage API + API Keys API permissions** for the Cloud Assist agent — would let it audit automatically next time. Low priority.

## What did NOT happen today

- No code in `scripts/` touched. No imports run. No DB writes. Zero API calls to Google (no key in use yet).
- No legacy backfill of the ~1,500 existing rows. That's an explicit future-phase decision once we have per-row cost data from real usage.
- No new sources added — the Spanish/Italian queue (Guía Repsol → Gambero Rosso → Pizzerías Top Spain) waits until the new pipeline is in place; otherwise we'd be adding more low-quality rows on top of the existing problem.
