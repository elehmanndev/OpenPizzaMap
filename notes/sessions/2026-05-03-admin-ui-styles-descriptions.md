# 2026-05-03 — Admin UI, Style Taxonomy, Gemini Descriptions

## What changed

### Style taxonomy
- Merged "Traditional Italian" + "Contemporary Italian" → **Italian Style** (catch-all for quality Italian pizza)
- Added **Pinsa** and **Pizza Fritta** as new styles
- Locked at 14 styles total; sortOrders cleaned up
- Migration: 17 places moved Traditional→Italian Style, 14 new PlaceStyle rows

### Admin UI
- **Style CMS**: full create/edit/toggle-visible at `/admin/styles`
  - Fields: slug, name, shortLabel, sortOrder, heroImageUrl, introHtml (Quill), seoTitle, seoDescription
- **Places list** upgraded from cards → table
  - Columns: ID, name, city, country, styles, visible
  - Filters: name, country, visible, style, needs (inc. "No style")
  - Checkbox + select-all + sticky bulk-assign bar (POST /admin/places/bulk-style)
- **Nav**: Admin split into Places / Styles / CMS links
- Added `.admin-table` CSS (hover, muted headers, monospace slugs)

### Gemini free-tier scripts
Both require `GEMINI_API_KEY` in `.env` and use `gemini-2.5-flash-lite`.

**`scripts/classify-styles.js`** — assigns pizza styles
- Fetches website text for context (up to 1500 chars)
- 150ms delay between calls (natural throttle via website fetches)
- Flags: `--dry-run`, `--apply`, `--all`, `--id=N`, `--min-confidence=0.7`, `--limit=500`
- Result: **1635 / 1677 visible places tagged** (97.5%)

**`scripts/generate-descriptions.js`** — 2-sentence HTML descriptions
- 4100ms delay (safe 15 RPM)
- Flags: `--dry-run`, `--apply`, `--all`, `--id=N`, `--limit=200`
- Running in batches of 300; ~380 written so far, ~1000 remaining

**`scripts/tag-untagged.js`** — one-off cleanup
- Regex name patterns → 20 tagged (Vezzo, Trozzo, Napoli, Pinsa, Taglio, Siciliana)
- Hide patterns → 3 hidden (clothing store, liquor, Korean restaurant)
- Remaining 42 untagged: US indie places without websites; needs manual review

### Bug fixed
`fetchUrl` redirect handler crashed on relative Location headers (`/closed.html`).
Fixed with `new URL(res.headers.location, url).href` in both classify and describe scripts.

## Status
- Styles coverage: 97.5% (42 untagged remain — visible in admin with `needs=no-style` filter)
- Descriptions: ~380/1677 written; batches 3–6 queued (running daily at free-tier pace)
- All changes pushed to production (Hostinger auto-deploy from `main`)
- HEAD: `d2ed32d`
