# API Key Guidelines

The API key gate is enforced in code. You should set the keys in Hostinger hPanel
environment variables (or `.env.local` locally) so they can be rotated without
redeploying.

## Admin API
- Protected route group: `/api/admin/*`
- Env var: `ADMIN_API_KEYS`
- Format: comma-separated list of keys
- Example: `ADMIN_API_KEYS=prod_abc123,prod_def456`

## How to Send the Key
Preferred:
- Header `x-api-key: <your-key>`

Also accepted:
- Header `Authorization: Bearer <your-key>`
- Query string `?api_key=<your-key>` (only for quick testing)

## Behavior
- Missing or invalid key returns `404` immediately (no DB access).
- If `ADMIN_API_KEYS` is empty or missing, all `/api/admin/*` requests will return `404`.

## Hostinger hPanel
Set this in hPanel:
1. `Websites` -> your site -> `Advanced` -> `Environment variables`
2. Add `ADMIN_API_KEYS` and paste the key(s)
3. Restart the Node app to apply

## Deploy Note (Hostinger)
If your start command runs `prisma migrate deploy`, it must load the same env file
used by the app (`.builds/config/.env`). The repo uses `scripts/migrate.js` for this.

---

# CMS + Landing Pages Notes

These features are DB-backed (not authored in code) and are designed to work with the existing submission + moderation flow.

## Admin CMS (Session-Based)
Admin UI is available to logged-in users with `user.role="admin"`:
- `/admin/pages` (global pages like `about`, `faq` intro)
- `/admin/faqs` (global/country/city/place FAQs)
- `/admin/countries`
- `/admin/cities`
- `/admin/places`

Rich text editing uses Quill (CDN) on admin edit pages. HTML is sanitized server-side before saving.

## Auto City/Country Landing Pages
When an admin approves a place submission, post-approve hooks run automatically:
- Country is upserted by ISO2 `Place.country` (e.g. `ES`)
- City is upserted by `(Place.city, Place.country)` and `Place.cityId` is attached when missing
- Visibility thresholds (auto-publish):
  - City: `>= 6` places where `status="active"` and `isVisible=true`
  - Country: `>= 5` visible cities

Public routes (only render when visible):
- `/country/:code`
- `/country/:code/city/:slug`
- `/about` (requires `Page(key="about").isVisible=true`)
- `/faq` (global FAQs; optional intro from `Page(key="faq")` when visible)

## Maintenance Mode
If `MAINTENANCE_MODE=true`, the app serves the maintenance page for all routes and bypasses normal routing.

## Recompute Script (Useful After Imports)
If you bulk-import places (e.g., from Apify), run:
- `npm run landing:recompute`

This ensures missing `Country`/`City` rows exist, attaches `Place.cityId` where missing, and recomputes visibility thresholds.
