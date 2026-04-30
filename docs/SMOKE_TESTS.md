# Smoke Tests (Manual)

Run these quick checks after each change set to ensure the site still works end-to-end.

## Auth
- `GET /register` loads
- `GET /login` loads
- Register a user (or use seeded admin) and verify session works

## Core
- `GET /map` loads and renders a map
- `GET /api/places?query=sample&city=Barcelona` returns `{ ok: true, places: [...] }`
- `GET /place/1` loads (adjust an existing ID)

## Admin
- Sign in as admin
- `GET /admin/submissions` loads
- Approve a `new_place` submission and confirm:
  - Place is created
  - Submission status becomes `approved`
  - Sitemap rebuild does not crash the app

## CMS
- `GET /admin/pages` loads
- Create/edit `about` page and toggle visible
- `GET /about` returns 200 when visible, 404 when hidden
- `GET /admin/faqs` loads
- Create a global FAQ and toggle visible
- `GET /faq` shows the FAQ when visible

## Auto Landing Pages
- After approving places, verify `City` and `Country` records are created
- When a city reaches 6+ active places, confirm the city `isVisible` flips true
- When a country reaches 5+ visible cities, confirm the country `isVisible` flips true

