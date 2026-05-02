# 2026-05-02 — Mobile-first map: bottom sheet, no zoom/layers, Sort dropdown

Eric reported: on mobile, tapping a marker "auto-closes" the popup. Root cause:
the sidebar took 50vh, leaving the map only ~50vh, so Leaflet's `autoPan` shoved
popups behind the sidebar (or off-screen). Fix: full-screen map + bottom-sheet
sidebar with a drag handle, plus map chrome cleanup.

Companion directive — UI/UX is **mobile-first** from now on. Most users will
hit OpenPizzaMap on their phone "on the spot." Desktop is secondary; verify
mobile preview before reporting any UI work done.

## Bottom sheet

- `.map-shell` on `(max-width: 900px)` is now single-column, full-viewport.
- `.map-sidebar` becomes `position: absolute; bottom: 0` with
  `height: var(--sheet-h, 132px)` and `transition: height 0.22s`.
- Three snap points, computed at boot from `window.innerHeight`:
  - **collapsed (~132 px)** — only handle + search row + sort/styles visible
  - **peek (~45 dvh)** — search + a few cards
  - **expanded (~85 dvh)** — full list scrolls inside
- Drag handle (`.map-sheet-handle`) — pointer events, snap-to-nearest on
  release. Tap (no drag) toggles collapsed ↔ peek.
- Auto-collapse on `map.click`, `map.popupopen`, and on each `marker.click`
  so popups always have the full canvas.
- Auto-expand to snap 2 on search input focus.
- `popupAutoPanPaddingBottomRight: [16, 160]` reserves room for the collapsed
  sheet so popups never autoPan into it.

Desktop layout untouched (≥ 901 px gets the original 420 px sidebar + map).

## Map chrome cleanup

- Removed `+/-` zoom buttons (`zoomControl: false` on map init).
- Removed the layer-picker control (`L.control.layers(...)` call deleted).
  Voyager tiles still load by default; Positron/satellite tile layer
  definitions left in place in case we wire a custom toggle later.
- Pinch-to-zoom and double-tap zoom still work natively on mobile.

## Sort: select → dropdown matching Styles

Replaced the native `<select class="map-sort-select">` with a
`<details class="map-sort-dropdown">` that mirrors the Styles dropdown
pattern (pill button, caret rotates on open, menu pops below).

- Summary shows just the word "Sort" (no current value text — Eric's call).
- Options are radios with the input visually hidden; the active row gets a
  faint accent-tinted background + brand-color text + bold label.
- Selecting an option closes the dropdown and applies the sort.
- Outside-click closes the dropdown (parity with Styles).
- `.map-sort-menu` anchors `left: 0` (it sits on the left of the controls
  row), `.map-style-menu` keeps `right: 0` — neither overflows the viewport.

## Files touched

- `src/views/map.ejs` — added sheet handle, replaced sort `<select>` with
  `<details>` radio dropdown.
- `public/css/styles.css` — bottom-sheet @media block, dropdown selectors
  consolidated, `.map-sort-opt` hides the radio + highlights active.
- `public/js/map.js` — `sheet` IIFE (drag/snap/expose-on-events), `isMobile`
  helper, marker click → collapse, removed `L.control.layers`, swapped
  `sortSelect` → `sortDropdown` change handler.

## Verification (mobile preview, 375 × 812)

- Sheet boots collapsed at 132 px; map fills full canvas.
- Tapped a marker with sheet at peek (360 px) → sheet snapped to 132 px,
  popup visible at top 216–561, well above sheet top (680).
- Search-input focus expanded sheet to ~690 px.
- Sort dropdown opens, shows 6 options, "Popular" highlighted; picking
  "Rating" closes the menu and re-renders the list.
- Desktop (1280 × 800) layout intact: 420 px sidebar, no handle, sheet is
  static positioning.

## Memory updates

- Added `feedback_mobile_first.md` — mobile-first design rule with the
  "verify the mobile preview before reporting done" clause.
- Indexed in `MEMORY.md`.

## Hot fix (later same day) — drag from anywhere on the header

Eric reported the sheet only opened by tapping the handle, not by sliding.
The handle was too small to be a natural drag target.

- Moved the `pointerdown` listener from `.map-sheet-handle` to `.map-sidebar`,
  so any swipe on the sheet (handle, search row, sort/styles bar, result
  count, padding) starts a drag.
- Added a 6 px movement threshold before promoting `pending` → `dragging` so
  taps still work — the handle's tap-to-toggle keeps firing because we don't
  `preventDefault` until we're sure it's a drag.
- Bail-out list inside the new `isInteractive(target)` helper:
  `.map-sidebar-list` (let the list scroll natively), and any
  `input, button, select, textarea, label, summary, a` (form controls and
  dropdown summaries handle their own touch).
- `.map-sidebar-header` got `touch-action: none` so iOS Safari doesn't
  interpret a swipe as native scroll/zoom and steal the gesture.

Commit `107145e`. Verified in mobile preview by simulating a 240 px upward
swipe from `.map-result-count` — sheet height moved 132 → 472 px before
the snap.

## Follow-ups (not done this session)

- The rest of the site (place page, admin grids, profile, filters) was
  built desktop-first. Worth a screen-by-screen mobile audit pass.
- The unused Positron/satellite tile-layer definitions can be deleted if
  we decide we'll never wire a custom toggle.
- Consider a small "list" / "map" toggle button for users who would rather
  see the list dominant — currently they have to drag the handle up to
  ~85 dvh every time.
