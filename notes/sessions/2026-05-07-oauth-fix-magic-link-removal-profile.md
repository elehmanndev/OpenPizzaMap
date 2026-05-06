# 2026-05-07 — OAuth fix, magic-link removal, profile redesign, security audit

## Status: SHIPPED — `5acc8f3` on main, prod verified HEALTHY

## TL;DR (for non-technical reading)

Big day in two parts.

**Part 1 — login was broken in prod.** Signing in with Google bounced you straight back to the sign-in page. Cause: a one-line config (`trust proxy`) was missing, so Express thought the connection wasn't HTTPS, so the session cookie was being silently dropped on the redirect from Google. Fixed.

**Part 2 — clean-up sweep.** Magic-link email sign-in was removed (Google-only now), the `/me` page was redesigned into a real profile (avatar, stats, wishlist + been-there + reviews tabs), the noisy pizza-pattern wallpaper was scoped to the auth screens only, and three security findings from prior audits were closed (committed dev DB, hardcoded admin password, avatar URL trust).

**Heads-up:** the OAuth fix's first deploy tripped the recurring Hostinger Prisma chmod issue (DB queries 503'd). Recovered via the runbook — the path was wrong in the runbook, now corrected. Two rotations are still **pending and on you to do**: `SESSION_SECRET` (currently equals the DB password) and `GOOGLE_CLIENT_SECRET` (was visible in chat during diagnosis).

---

## What changed

### 1. Google OAuth fix — `01accac`
- `app.set("trust proxy", 1)` in `src/app.js` so `req.secure` reflects Hostinger's `X-Forwarded-Proto`.
- `req.session.save(...)` wrapping the redirect in `/api/auth/google/callback` — kills a race where the 302 fired before PrismaSessionStore's MySQL write completed.
- Verified end-to-end via Chrome MCP — sign-in now lands on `/me`, not `/auth?google=failed`.

### 2. Hostinger Prisma chmod outage (recovered, runbook fixed) — `1a63cf4`
- The OAuth deploy triggered a Passenger respawn that hit the chmod-strip-on-deploy bug. Recovery: SSH + `npm run postinstall` from `~/domains/openpizzamap.com/nodejs/`. Required `export PATH=/opt/alt/alt-nodejs20/root/bin:$PATH` first because the npm sub-shell doesn't inherit `node`.
- Updated `docs/runbook.md` with: (a) the correct path (the previous runbook said `public_html`, which has no `package.json`), (b) the `export PATH` gotcha, (c) script paths under `scripts/deploy/`.
- Auto-memory now has a [Hostinger paths](../../.claude/projects/C--Users-Eric-OpenPizzaMap/memory/reference_hostinger_paths.md) entry so future Claude sessions don't waste 20 minutes finding `nodejs/` again.

### 3. Magic-link auth removed — `d918fc9`
- Dropped: `POST /api/auth/start`, `GET /verify`, `GET /check-email`, `src/services/email.js`, `src/views/check_email.ejs`, `src/views/verify.ejs`, the stale `test/auth-flow.test.js`. `/auth` is now Google-only.
- DB check before ripping: 8 total users, 4 had `googleId`, the other 4 were all `test@example.com` / `smoke-*` / `hijes62623@helesco.com` (10minutemail-style burner). Zero real magic-link users to migrate.
- `verificationTokenHash` / `verificationTokenExpiresAt` columns left on `User` for now — orphaned but harmless. Drop in a later cleanup migration when other schema changes ship.

### 4. Google avatar capture — `2758705`
- Added nullable `User.avatarUrl` (TEXT) via migration `20260506200000_add_user_avatar`.
- `pickGoogleAvatar()` in `src/services/googleAuth.js` parses the URL, requires `https:`, requires host to end with `.googleusercontent.com` or `.google.com`, slices to 1024 chars, returns null otherwise. (The host allow-list was added later in the day as part of the audit pass.)
- Avatar rides along in `req.session.user` so the profile view doesn't need a second DB hit.

### 5. Profile page redesign — `029c63e` + `d8b423d`
- New `/me`: header card (avatar + display name + @username + "Member since"), 3-stat strip (Visited / Wishlist / Reviews), tabs (Wishlist · Been there · Reviews), empty states route back to `/map`.
- Wishlist = favourites where no `Visit` exists; Been there = visits unioned with favourites-with-visit. One Favorites table, two views — exactly the "favourites doubles as wishlist" Eric asked for.
- Mobile-first at 375 px with one `min-width: 600px` breakpoint scaling avatar + headline up.
- Bug caught during prod verification: the global stylesheet's `header { ... }` rule was clobbering my `<header class="profile-header">` element, collapsing the avatar card into a 64 px banner. Fixed by switching to `<section>`. (Worth remembering — element-tag selectors in the global sheet are a foot-gun for any future card layout that uses `<header>`/`<footer>`/`<nav>`.)

### 6. Pattern background scoped — `f50819e`
- Pizza-slice wallpaper was visually fighting stacked card layouts on `/me`, `/place/:id`, `/favourites`, `/privacy`, `/terms`, `/admin`.
- Flipped from default-on (with map opt-out) to opt-in via `body.auth-page` only. Maintenance landing has its own bespoke background, unaffected.

### 7. Security audit + three closures — `9eb9b77` + `5acc8f3`
- New audit file `AUDIT-2026-05-07.md` committed (also brought the prior `AUDIT-2026-05-05.md` and `SECURITY.md` into the tree — they were sitting untracked).
- **C1 closed** — `prisma/dev.db` removed via `git rm --cached`; `.gitignore` now blocks `prisma/*.db` and the SQLite journal/shm/wal patterns.
- **C2 closed** — admin user creation removed from `prisma/seed.js`. With Google-only auth, a row with a pre-baked `passwordHash` could never sign in; the seeded admin was both a deterministic-credential risk (hash exposed via C1) and useless. Admin promotion now: `UPDATE User SET role = 'admin' WHERE email = ...` against an already-signed-in Google user.
- **N9 closed** — avatar URL host allow-list shipped (see §4).
- **H2 closed earlier in the day by deletion** — the new `/me` no longer renders `rejectionReason`.

## Verification (done in-session)
- All commits pushed; final HEAD `5acc8f3` deployed clean (uptimeSec ≈ 0/1, healthy).
- Live OAuth round-trip in Chrome MCP — landed on `/me`, screenshotted.
- Profile page rendered correctly after the `<section>` fix; avatar fallback "E" shows because the user record doesn't have `avatarUrl` populated yet (will fill on next sign-in).
- Pattern off everywhere except `/auth` confirmed via curl + computed-style read.
- Prod health stayed green through six deploys.

## Still pending (next session)

- **Rotate `SESSION_SECRET`.** Currently the same string as the DB password in `.env`. One leak compromises both. Generate via `node -e "console.log(crypto.randomBytes(32).toString('hex'))"`, set in `.env`, `.env.local`, and Hostinger's `.builds/config/.env`. Existing logged-in users will be signed out once.
- **Rotate `GOOGLE_CLIENT_SECRET`.** Was visible in chat during diagnostic grep. Google Cloud Console → Credentials → reset.
- **H4** — `POST /add` skips Zod + `submitLimiter`. From the 2026-05-05 audit.
- **H5** — no CSRF protection on any state-changing form route. From 2026-05-05.
- **Move postinstall sequence into `npm start`** so future Hostinger respawns self-heal without SSH (the chmod issue keeps recurring).
- **Drop unused magic-link columns** in a later cleanup migration: `verificationTokenHash`, `verificationTokenExpiresAt`, plus `passwordHash` (Google-only now), `resetTokenHash`, `resetTokenExpiresAt`.
- **Profile page follow-ups:** badges (Neapolitan x10 etc), `/leaderboard` route.

## Commit chain

```
5acc8f3 sec: close C1 (dev.db in git), C2 (seeded admin password), N9 (avatar trust)
9eb9b77 docs: add 2026-05-07 security audit and track prior audit artefacts
f50819e ui: scope pizza-pattern background to auth pages only
d8b423d profile: use section/div instead of <header> for profile header card
029c63e profile: redesign /me as a real profile page
2758705 auth: capture Google avatar URL on sign-in
d918fc9 auth: remove magic-link, Google sign-in only
1a63cf4 docs(runbook): correct Hostinger SSH paths after 2026-05-06 incident
01accac fix(auth): trust proxy + force session save in google callback
```
