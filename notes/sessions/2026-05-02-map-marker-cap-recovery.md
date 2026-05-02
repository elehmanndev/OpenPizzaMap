# 2026-05-02 — Recover ~85 % of map markers (Sorbillo, 50 Kalò et al.)

Eric noticed Sorbillo and 50 Kalò were missing from the map, plus "many more
spots." Root cause: the `take` cap added in `47d7cc1` (Phase 2 stability,
2026-04-30) limits `/api/places` to 200 rows for anon, 500 for authed users,
sorted by `updatedAt DESC`. The DB has 1,438 active+visible places — anything
updated before the cutoff (mid-day 2026-04-26 for the anon cap) silently
dropped off the map.

The cap was the right call for protecting the worker pool from `take: 1000`
queries — undoing it isn't an option. The fix is a separate, slim endpoint
that returns every visible place but with a much smaller per-row payload, plus
on-demand fetching of the heavy popup fields when a marker is opened.

## Backend — `/api/places/markers`

`src/routes/api.places.js` — added `GET /markers` before `/:id`:

- Hard-coded `where: { status: "active", isVisible: true }` — no query params
  to keep the response cacheable.
- `select` shape includes only what the marker + sidebar card need:
  `id, name, lat, lng, city, country, priceLevel, heroImageUrl,
  opmRating, googleRating, tripadvisorRating, yelpRating, styles`.
- Reuses `applyCacheHeaders` so anon hits the same edge cache as `/api/places`.
- Reuses `attachUserAndCounts` so the heart button and the "Popular" sort still
  have `viewerFavorited` / `visitCount`.

The 200/500 cap on the original `/api/places` route is untouched — it still
protects against any future caller that asks for the full payload.

## Frontend — lazy popup

`public/js/map.js` boot now hits `/api/places/markers` instead of
`/api/places`. Each marker:

- Binds a placeholder popup with just the spot's name and "Loading…".
- On `popupopen`, calls `ensureFullPlace(p)` which fetches `/api/places/:id`,
  swaps in the real `popupHtml(full)` via `setPopupContent`. Per-id cache +
  in-flight dedupe so re-opens are instant and double-clicks don't double-fetch.

Sidebar/card path (`cardHtml`, `popupHtml`, `placeMatchesQuery`,
`buildStyleFilters`, `pickCity`, `pickSpot`, the suggest panel) all keep
working because the slim shape carries every field they read.

## DB hot-fix — 50 Kalò Naples

`Place id=178` had lat/lng `45.1039351, 8.9096344` (a hill near Tortona,
Piemonte) instead of Naples. Updated to `40.828402, 14.219897` — same coords
as id 421 (`50 Kalò di Ciro Salvo`). One-off fix; Eric asked for a wider
geocode audit as the next step.

## Verified in preview

- `/api/places/markers` returns 1,438 places (was 200 anon / 500 authed via
  `/api/places`).
- All 5 Sorbillo entries + all 4 real 50 Kalò entries present in the response
  and in the sidebar.
- 50 Kalò id 178 coords now correct in both the API and the live map.
- Clicked a non-clustered marker: placeholder swapped to the full popup
  (name, address, summary, "View profile" CTA) — confirms lazy-load works.
- `npm test` failures are pre-existing (missing `set_password.ejs` stub,
  HTML-instead-of-JSON auth responses) and identical with/without this diff.

## Commit + deploy

- `a13ebed` — pushed straight to `main` so Hostinger auto-deploys.
- DB row fix landed via `prisma.place.update` against the live DB before the
  push (we share one DB across local + Hostinger).

## Follow-ups (not done)

- **Geocode audit**: id 178 was the one we caught — write a script that flags
  every row whose lat/lng is far from its city's centroid (or wrong country
  entirely). Output a JSON list for batch correction.
- **Sidebar card click on a clustered marker silently no-ops.** Pre-existing.
  Fix is `cluster.zoomToShowLayer(marker, () => marker.openPopup())` instead
  of plain `openPopup()`.
- **720-card sidebar dump on first paint** is heavy DOM. Could virtualize or
  cap to N visible.
