# Enrichment Pipeline — Design Doc

**Status:** draft, awaiting Eric's review (2026-05-04). Nothing in
[scripts/import-places.js](../scripts/import-places.js),
[scripts/enricher.js](../scripts/enricher.js) or
[scripts/resolve-via-gmaps.js](../scripts/resolve-via-gmaps.js) will be
touched until this doc is signed off.

---

## 1. The problem

Today's bulk imports keep producing low-quality rows. The pattern is
always the same: we trust the source for identity (name + city +
coords), insert, and verify too late — sometimes never. Concrete
incidents from this week alone:

- **50 Kalò (Naples, IT)** — coords landed in Piemonte (~178 km off).
  Source had a malformed lat/lng that nobody cross-checked.
- **7 Sensi (Lanzarote, ES)** — `city = "Las Palmas"` (the *province*),
  not the actual town. Sources don't always mean the same thing by
  "city".
- **Pizzeria Starita a Materdei** vs. **Starita a Materdei** —
  duplicated until [c935e4c](../scripts/import-places.js) added the
  prefix-strip + 200 m Haversine fallback. That patches a symptom; it
  doesn't solve identity.
- **Castellón / Castellón de la Plana** — same city, two spellings,
  duplicates created.
- **Sevilla centroid pile-up** — multiple unrelated venues pinned to
  the city centroid because the geocoder returned a fallback. The
  enricher's `validate` phase (see
  [scripts/enricher.js](../scripts/enricher.js)) hides them after the
  fact but does not prevent the insert.
- **Generic / mediocre descriptions** — sources hand us a paragraph or
  two of marketing copy. We pass it through. No summarisation, no
  dedup against neighbouring rows.
- **TripAdvisor 500s on imports without ranking signals** — quota burn
  on rows we'd never have surfaced anyway.

The common thread: **we have optimised for import volume and bolted on
verification scripts** ([scripts/audit-geocodes.js](../scripts/audit-geocodes.js),
[scripts/fix-seville-centroids.js](../scripts/fix-seville-centroids.js),
[scripts/dedup-apply-high-confidence.js](../scripts/dedup-apply-high-confidence.js))
**that run after damage is done.** There is no single step that asks,
*"does this venue actually exist, is the canonical name X, and is it
really at coordinate Y?"* before the row hits `Place`.

## 2. Goals

1. **Quality > quantity.** Every row in `Place` is an identity-resolved,
   coordinate-sane, dedup-checked entity — or it never gets inserted.
2. **Single canonical identity** per real-world venue. Currently we
   identify by `(slug)` with a name+coord fallback. We will switch to
   `googlePlaceId` as the canonical identifier when available, with
   the existing fallbacks as backup.
3. **Coordinate sanity by construction.** Coords come from one trusted
   resolver, not from whatever the source happened to print.
4. **Robust dedup** before insert. Current dedup is reactive
   (post-import audit). New pipeline checks for an existing canonical
   row before any write.
5. **Decent descriptions.** Eventually summarise external reviews into
   a 2–3 sentence neutral description per row. *Postponed to a later
   phase — see §10.*
6. **Pluggable provider.** Same pipeline whether the resolver is
   Playwright (free), Google Places API (paid, behind a hard quota),
   or TripAdvisor (last resort). Adapters are interchangeable; toggled
   via `ENRICHMENT_PROVIDER`.
7. **Zero additional spend.** Until Eric explicitly opts in, the
   default provider stays Playwright. When Google API is enabled,
   GCP hard quotas (set at the per-SKU free-tier limits Google
   introduced March 2025) plus a $1 budget alert make overspend
   mathematically impossible — see
   [docs/setup-google-maps-api.md](setup-google-maps-api.md).

## 3. Non-goals (this refactor)

- **No bulk re-migration of legacy data.** The 1,500+ rows already in
  the DB are out of scope. Once the new pipeline is stable we can
  point a backfill script at the existing rows, but that's a separate
  decision once Eric sees the per-row API cost in practice.
- **No removal of the existing import scripts.** They will keep
  working. The new `enrichAndValidate` module wraps them, so
  refactoring is incremental — we can turn the new pipeline on for
  one source at a time.
- **No new sources in this phase.** Spanish/Italian source queue from
  `project_es_it_sources.md` (Guía Repsol, Gambero Rosso, Pizzerías
  Top Spain) waits until the pipeline is in place — otherwise we'd be
  adding more low-quality rows on top of the existing problem.

## 4. Architecture

```
                ┌────────────────────────────────────┐
  raw place ──▶ │       enrichAndValidate(raw)        │ ──▶ validated Place + decision
  (importer or  │                                     │     { action: "insert"
   web form)    │   1. Source                         │              | "merge_into"
                │   2. Identity Resolution (provider) │              | "skip"
                │   3. Cross-source corroboration     │              | "manual_review"
                │   4. Quality signals (rating + n)   │       canonicalGooglePlaceId
                │   5. Dedup gate                     │       reasons: [...]
                │   6. Coordinate sanity              │     }
                │   7. Persist + post-audit hook      │
                └────────────────────────────────────┘
                              │
                              ▼
                  EnrichmentProvider interface
                  ├── PlaywrightProvider (default, free)
                  ├── GoogleApiProvider (env-toggled, paid, capped)
                  └── TripAdvisorProvider (stub, last resort)
```

The pipeline is a single function:

```js
// src/services/enrichment/index.js  (new)
async function enrichAndValidate(rawPlace, { provider, dryRun } = {}) {
  // returns { action, place, googlePlaceId, reasons, signals }
}
```

It is called from:

- **[scripts/import-places.js](../scripts/import-places.js)** — replace
  the inline dedup + insert block with `enrichAndValidate(rawPlace)`.
- **[src/services/submissions.js](../src/services/submissions.js)** — at
  approval time, run `enrichAndValidate(payload)` before promoting a
  `Submission` to a `Place`. (Manual flow — see §6.)
- **[scripts/enricher.js](../scripts/enricher.js)** — refactored so its
  phases delegate to the same provider interface.

## 5. Pipeline steps

Each step has a single responsibility, a single owner module, and a
documented fallback. If a step's fallback also fails, the result is
either `action: "skip"` (no insert) or `action: "manual_review"`
(write to a queue, never to `Place`).

### 5.1 Source

- **Input:** raw record from a scraper or web form.
- **Output:** normalised `RawPlace` shape — `{ name, addressLine?, city,
  region?, country, lat?, lng?, sourceName, sourceRank?, ... }`.
- **Owner:** the scraper itself (no change). The new pipeline starts
  *after* this point.
- **Fallback:** scrapers already log to `import-errors.json`. No
  change.

### 5.2 Identity Resolution (provider)

- **Input:** `RawPlace`.
- **Output:** `{ googlePlaceId, canonicalName, formattedAddress, lat,
  lng, types[], rating?, ratingCount? }` — or `null` on hard miss.
- **Owner:** `EnrichmentProvider.findPlace(name, city, country?)`.
- **Default provider:** Playwright (existing
  [scripts/lib/gmaps.js](../scripts/lib/gmaps.js)). Returns address +
  coords + meta but **no place_id today** — we will extract it from
  the GMaps URL during this refactor (the canonical place page URL
  contains a CID, which is enough to identify uniquely).
- **Google API provider:** single Places Text Search call. Returns
  `place_id` directly. Cached in DB by `(name, city, country)` so a
  retry never re-charges.
- **Fallback:**
  1. If Google API returns 429 (quota) → fall through to Playwright.
  2. If Playwright misses → run Nominatim text search.
  3. If Nominatim misses → flag `manual_review`. **Never insert**
     without a coord-sane resolution.

### 5.3 Cross-source corroboration

- **Input:** resolved identity + `RawPlace.sourceName`.
- **Output:** boolean `corroborated` + list of cross-references.
- **Owner:** `src/services/enrichment/corroborate.js` (new).
- **Logic:** if the source is already a high-trust list (50TP,
  Michelin, AVPN, TasteAtlas top), corroboration is implied — we trust
  the source's editorial process. For lower-trust sources, do a
  WebSearch for `"{canonicalName}" "{city}"` and check whether at
  least one independent reference (other than the source itself)
  appears.
- **Fallback:** corroboration is a *signal*, not a gate. If it fails,
  we still insert but flag `corroborated: false` so admin UI can
  surface it for manual review. Goal is to catch the "scraper
  hallucinated a venue" class of bug, which is rare but real.
- **Cost:** WebSearch is free in Claude. Skipped when `corroborated`
  is implied by source rank.

### 5.4 Quality signals

- **Input:** resolved identity + source rank + provider rating data.
- **Output:** `{ qualityGate: "pass" | "fail", reasons[] }`.
- **Owner:** `src/services/enrichment/quality.js` (new). Codifies the
  rule we've been applying ad-hoc:
  - **Pass** if any of: source has a ranking award (50TP top-100,
    Michelin Bib Gourmand, AVPN certified, TasteAtlas top-N,
    lamejorpizza.es featured) OR `rating >= 4.3 AND ratingCount >= 100`.
  - **Fail** otherwise → `action: "manual_review"`.
- **Fallback:** N/A — quality gate is intentionally strict. Eric can
  approve manually for edge cases.

### 5.5 Dedup gate

- **Input:** resolved `googlePlaceId` + canonical name + coords.
- **Output:** existing `Place` row (if duplicate found) or null.
- **Owner:** `src/services/enrichment/dedup.js` (new). Three layered
  checks, in order:
  1. **`googlePlaceId` exact match** (new column, see §7). Fastest +
     most reliable.
  2. **Coord-bbox + name-normalize** (existing logic from
     [scripts/import-places.js](../scripts/import-places.js:760-792)
     — Haversine ≤ 200 m + `normalizeName()` exact match). Catches
     pre-place_id rows.
  3. **Slug match** (existing fallback).
- **On hit:** return `action: "merge_into"` with the existing row's
  ID. The caller's responsibility to fill empty fields without
  overwriting (existing `isEmpty` rule from
  [scripts/import-places.js](../scripts/import-places.js:822-833)).
- **Fallback:** no fallback — if all three checks miss, the row is
  genuinely new.

### 5.6 Coordinate sanity

- **Input:** resolved coords (from provider) vs. raw source coords (if
  any).
- **Output:** chosen coords + drift flag.
- **Owner:** `src/services/enrichment/coords.js` (new).
- **Rule:**
  - If raw source had no coords → use provider's.
  - If raw source had coords AND drift from provider's is ≤ 1 km →
    use provider's (slightly more accurate, building-level).
  - If drift > 1 km → use provider's, log a warning, and flag for
    manual audit. The 50 Kalò Piemonte case (178 km drift) would have
    been caught here.
- **Fallback:** if provider has no coords either, it's a
  `manual_review` case from step 5.2 already.

### 5.7 Persist + post-import audit

- **Input:** validated row.
- **Output:** `Place` row inserted/updated; `enrichedAt = now()`;
  `enrichmentVersion = N` (so future schema changes know what to
  re-run).
- **Owner:** `src/services/enrichment/persist.js` (new). Single
  transaction: upsert `Place`, attach `PlaceSource` row, attach
  `cityRef` if matched.
- **Post-import audit hook:** after insert, enqueue (or directly run,
  for low volume) a sanity sweep — re-run `validate` and centroid
  audit on the new row only. Catches bugs we haven't anticipated.

## 6. Manual flow (web form)

The "Submit place" form at [src/views/suggest_edit.ejs](../src/views/suggest_edit.ejs)
posts to [POST /api/submissions](../src/routes/api.submissions.js:56)
which writes a `Submission` row with `status="pending"`. Admin
approval at
[POST /api/admin/submissions/:id/approve](../src/routes/api.admin.js:19)
currently promotes the payload directly to `Place` via
[src/services/submissions.js](../src/services/submissions.js).

**Change:** approval calls `enrichAndValidate(payload)`. Same gate, same
quality rules, same dedup. If the user submitted a duplicate, admin
sees `action: "merge_into"` with a diff and one click to confirm.

**Future UX (out of scope for this phase, but the design supports it):**
the submission form gets a Google Maps autocomplete input. User types
"50 Kalò Naples", picks the right place, and we post the resolved
`googlePlaceId` directly. Server still calls `enrichAndValidate` but
short-circuits identity resolution. Eric reviews a card preview before
final insert.

```
user types "Sorbillo Naples"
        │
        ▼
GMaps autocomplete dropdown ───▶ user picks one
        │
        ▼
form posts { googlePlaceId, userNotes }
        │
        ▼
POST /api/submissions ──▶ creates Submission row
        │
        ▼
admin opens /admin/submissions/:id ──▶ preview card (rendered from
        │                                enrichAndValidate output)
        ▼
admin clicks Approve ──▶ enrichAndValidate runs ──▶ Place insert
```

## 7. Schema impact

New columns on `Place`:

| Column                | Type                       | Notes |
|-----------------------|----------------------------|-------|
| `googlePlaceId`       | `String? @unique @db.VarChar(64)` | Canonical identity. Nullable until backfilled. Unique constraint enforces no-duplicates at DB level. |
| `googlePlaceUrl`      | `String? @db.VarChar(500)` | The canonical GMaps URL. Useful for UI link-out + as fallback identity if `googlePlaceId` is ever stripped from URLs. |
| `enrichmentVersion`   | `Int @default(0)`          | Bumped each time the pipeline's logic changes in a way that needs re-running. Lets us target backfills without a "have we processed this row" flag. |

Existing `enrichedAt DateTime?` is reused.

**Migration plan:**
1. Add columns as nullable (`prisma migrate dev` then `prisma db push`
   on Hostinger via [scripts/migrate.js](../scripts/migrate.js)).
2. Default `enrichmentVersion = 0`. Pipeline writes `1` on every new
   insert / re-enrich.
3. No backfill in this phase — all 1,500 existing rows stay at
   `version=0`. We decide on a backfill cadence after costs are clear.

## 8. Provider abstraction

```js
// src/services/enrichment/provider.js  (new)
interface EnrichmentProvider {
  // Resolve identity by name + city. Returns null on hard miss.
  findPlace(name, city, country?): Promise<ResolvedIdentity | null>

  // Hydrate full details for a known place_id. Idempotent + cached.
  getDetails(placeId): Promise<PlaceDetails | null>

  // Optional: fetch external review snippets (used by the future
  // description-generator phase, §10). Stub for now.
  searchReviews?(placeId): Promise<ReviewSnippet[]>
}
```

Adapters:

- **`PlaywrightProvider`** — wraps existing
  [scripts/lib/gmaps.js](../scripts/lib/gmaps.js). Default. Free.
  `findPlace` does the existing search + click flow; `getDetails`
  re-uses the on-disk cache at `gmaps-resolve-cache.json`.
- **`GoogleApiProvider`** — Places API (New) Text Search +
  Place Details. Behind `ENRICHMENT_PROVIDER=google_api`. Cached in DB
  (new table `EnrichmentCache` keyed by `(provider, queryHash)`) with
  a 90-day TTL so retries don't re-charge.
- **`TripAdvisorProvider`** — stub only in this phase. Existing TA
  budget logic lives at
  [scripts/lib/tripadvisor-budget.js](../scripts/lib/tripadvisor-budget.js)
  and will be folded in if/when Eric approves the spend.

Toggle:

```bash
# Hostinger env (Websites → Advanced → Environment variables)
ENRICHMENT_PROVIDER=playwright   # default — no spend
ENRICHMENT_PROVIDER=google_api   # paid — needs GOOGLE_MAPS_API_KEY
```

## 9. Fallback rules (table)

| Failure                        | Fallback                                        | Result if fallback also fails |
|--------------------------------|-------------------------------------------------|-------------------------------|
| Google API 429 (quota)         | Playwright                                      | Nominatim                     |
| Google API 5xx / network       | Playwright                                      | Nominatim                     |
| Playwright timeout / no result | Nominatim text search                           | `manual_review`, no insert    |
| Nominatim 5xx / no result      | (none)                                          | `manual_review`, no insert    |
| Coord drift > 1 km             | Use provider coord, log warning                 | (continues)                   |
| Quality gate fails             | (none — gate is intentional)                    | `manual_review`               |
| Corroboration fails            | Insert with `corroborated: false` flag          | (still inserts; admin reviews)|

The principle: **never insert a `Place` row with unverified coords.**
Everything else is best-effort enrichment.

## 10. Open questions / future phases

1. **Description generation.** Once the pipeline is stable, summarise
   3–5 review snippets (provider-supplied) into a neutral 2-sentence
   description per place using Gemini's free tier. Mind the 1500 RPD
   cap — see auto-memory `feedback_gemini_limits.md`. Probably a
   nightly batch over visible places that are missing
   `descriptionHtml`.
2. **Periodic refresh.** Re-enrich every place once every N months
   (closed venues, moved venues, hours changes). Needs a `lastSeen`
   signal from the provider before we can detect "place no longer
   exists".
3. **TripAdvisor full integration.** Cost / value still unclear.
   Decide after we have GMaps API quota data to compare.
4. **Submission autocomplete UX.** Mentioned in §6. Frontend work,
   separate ticket.
5. **Backfill of legacy rows.** ~1,500 rows at `enrichmentVersion=0`.
   Decide cadence + total cost cap after first week of new-import
   data.

## 11. Testing strategy

- **Unit tests** per module (`enrichment/dedup.js`, `coords.js`,
  `quality.js`, `corroborate.js`). Mostly pure functions over
  fixtures.
- **Provider contract tests.** Each `EnrichmentProvider` adapter must
  pass the same suite of "given input X, return output of shape Y".
  Run with a recorded-fixture mode (no live API calls in CI).
- **End-to-end fixture.** A `test/fixtures/raw-place-pathological.json`
  with the bad cases from §1 (50 Kalò wrong coords, 7 Sensi province
  city, Starita prefix duplicate, Sevilla centroid). The full
  `enrichAndValidate` pipeline runs against it; expected outcomes are
  asserted (insert / merge / skip / manual_review). Regression-proofs
  the design against the original incidents.
- **Cost guard test.** Mock the Google API to return 429 and assert
  the pipeline falls through to Playwright without exception.
- **Smoke test post-deploy.** Reuse pattern from
  [scripts/dedup-importer-smoke-test.js](../scripts/dedup-importer-smoke-test.js)
  — 5 known-canonical inputs, assert pipeline returns expected
  identity + dedup decision.

## 12. Rollout

1. Land this doc + GCP setup punchlist (this commit).
2. Eric reviews + signs off (or pushes back).
3. Phase 2 implementation:
   - Schema migration (add 3 columns).
   - `src/services/enrichment/` module skeleton.
   - `PlaywrightProvider` adapter wrapping existing `gmaps.js`.
   - Fixture-based E2E test green.
   - Switch `import-places.js` to call `enrichAndValidate`.
   - Switch submission approval to call `enrichAndValidate`.
4. Phase 3 (Eric pulls the trigger):
   - GCP project + API key + quotas + budget alert.
   - `GoogleApiProvider` adapter behind env toggle.
   - First live import on `ENRICHMENT_PROVIDER=google_api` against a
     small batch (≤ 20 rows) with full audit log.
5. Phase 4: descriptions, refresh, TripAdvisor — separate decisions.
