# OpenPizzaMap — Session Handoff (2026-04-26)

## Vision recap
- Community pizza map; alternative to thegreat.pizza.
- Anti-"Karen reviews" — protect good places from bad-faith ratings.
- Plan: scrape curated sources + user submissions + reddit-style profile karma.
- **Hard budget:** domain + Hostinger hosting only. No paid APIs, SaaS, or tile keys, ever.

## What's live now

### Map (`/map`)
- Three Leaflet raster basemaps in top-right layer picker: Voyager (default), Positron, Esri Satellite.
- Marker cluster group (leaflet.markercluster).
- Pizza emoji 🍕 markers scale with zoom (22px → 56px).
- **Place card popup** (rebuilt): hero image with rating chip overlay (top-left), name, directions link, summary, single full-width green CTA to the place profile.
- Loads from `/api/places` (added fall-through for no-params → returns all `status=active, isVisible=true`).

### Auth — single magic-link flow
- One entry: **`/auth`** (email field + Google OAuth). No more login/register/forgot/reset/set-password split.
- Magic-link copy diverges for new vs returning user (welcome vs sign-in subject + CTA).
- Token TTL 30 min, sha256-hashed at rest.
- Old routes (`/login`, `/register`, `/forgot`, `/reset`, `/set-password`) all 301-redirect to `/auth`.
- Email template: brand green CTA, no decorative bar, no outer cream panel.

### Maintenance landing (`/`)
- Animated pizza-slice background — each slice positioned with collision detection (no overlaps), random size/rotation/float offsets, 9–18s float loop with negative delays so they don't move in sync. `prefers-reduced-motion` respected.
- Card: warm off-white (`#fdfaf3`), green outline (`var(--c-accent)` 1.5px), green-tinted shadow.
- Copy: "We're heating up / the ovens" + "The community pizza map, in the making. Drop your email — we'll save you the first slice."
- Pill-shaped email form with mail icon, muted "Drop your email" placeholder, embedded "Sign up" button.
- POSTs to `/api/notify` → upserts into new `NewsletterSignup` table (`email` unique, `source` = "maintenance", `createdAt`).

### Burger menu
- Fixed dropdown contrast on `/map` (was unreadable white-on-white from cascade of `.map-page header a { color: #fff }`). Scoped `.map-page header .menu-panel` overrides restore `var(--c-text)` and surface bg.

### 404 cache fix
- Catch-all 404 in `src/app.js` previously set `Cache-Control: public, max-age=600` → new routes got cached as missing. Now `no-store` for real 404s; the 1-hour cache stays only on bot-blocklist paths.

## Schema changes
- **New model: `NewsletterSignup`** — applied via `prisma db push` (Hostinger user can't create shadow DB for `migrate dev`). Migration history is **not** in sync with schema for this addition; future schema changes should keep using `db push` or a manual SQL script until that's resolved.
- Dead columns still on `User`: `passwordHash`, `resetTokenHash`, `resetTokenExpiresAt`. Safe to drop in a follow-up.

## Still pending

### Product
- **Replace maintenance gate at `/`** — landing actively turns away visitors while `/map` works. A real landing with map peek + CTA would unblock SEO + traffic. Eric still wants maintenance for now.
- **Imagery sourcing** for place hero photos — no free no-key Streetview. Mapillary (free w/ key), Wikimedia Commons, manual upload all on the table.
- **AI summary inference** — Gemini free tier or Groq for `descriptionHtml` generation at moderation time. Hallucination risk → only feed structured facts, allow admin edit.
- **MapLibre GL + OpenFreeMap** migration for vector tiles (custom water color, Outfit font on labels). Bigger refactor, deferred.

### Data
- Single real seed (Sorbillo, Naples). No scraper yet. GitHub Actions free-tier still the leading plan.

### Reviews / karma
- Schema not extended. Reddit-style karma + anti-Karen design rules still unspecified.

## Useful pointers
- Layout: `src/views/layout.ejs`
- Map view: `src/views/map.ejs` + `public/js/map.js`
- Auth view: `src/views/auth.ejs`
- Maintenance: `src/views/maintenance.ejs`
- Places API: `src/routes/api.places.js`
- Auth API: `src/routes/api.auth.js` (POST `/api/auth/start` for magic link)
- Notify API: `src/routes/api.notify.js`
- Email service: `src/services/email.js` (single `sendMagicLinkEmail`)
- Schema: `prisma/schema.prisma`
