# Security Audit — OpenPizzaMap

Audit completed 2026-05-03. Fixes C1 → M1 are pending.

## Pending fixes

| ID | Sev | Issue | File(s) |
|----|-----|-------|---------|
| C1 | Critical | `prisma/dev.db` committed to git | `.gitignore`, git history |
| C2 | Critical | Hardcoded admin password in seed | `prisma/seed.js:14-15` |
| H1 | High | Stored XSS: `descriptionHtml` / `answerHtml` rendered raw | `src/views/place.ejs:295,336` |
| H2 | High | Stored XSS: `rejectionReason` unescaped | `src/views/me.ejs:6` |
| H3 | High | `POST /add` skips Zod validation; `new_place` approval has no field whitelist | `src/routes/pages.js:60`, `src/services/submissions.js:32` |
| H4 | High | `POST /add` missing rate limiter | `src/routes/pages.js:60` |
| H5 | High | No CSRF tokens on any state-changing form routes | `src/app.js`, all form templates |
| H6 | High | CDN scripts loaded without SRI hashes | `src/views/layout.ejs:18-22` |
| M1 | Medium | `DEV_ADMIN_BYPASS` activates when `NODE_ENV` unset | `src/middleware/auth.js:10-11` |

## Fix notes

**C1** — Run `git rm --cached prisma/dev.db` in the repo, then add to `.gitignore`:
```
prisma/*.db
prisma/*.db-journal
prisma/*.db-shm
prisma/*.db-wal
```

**C2** — Replace hardcoded password with `crypto.randomBytes(16).toString("hex")` and print to stdout.

**H1** — In `GET /place/:id` (pages.js), call `sanitizeRichText` on `place.descriptionHtml` and each `faq.answerHtml` before rendering.

**H2** — `src/views/me.ejs:6`: wrap with `escapeHtml(s.rejectionReason)`.

**H3** — Route `POST /add` through `newPlacePayloadSchema`. Add `pick()` whitelist to `approveSubmission` for `new_place` (mirrors the existing `edit_place` branch).

**H4** — Add `submitLimiter` to `router.post("/add", requireAuth, submitLimiter, ...)`.

**H5** — Install `csrf-csrf`, wire in `app.js`, pass token to all renders, add hidden input to all forms.

**H6** — Add `integrity=` + `crossorigin="anonymous"` to Leaflet/MarkerCluster `<script>`/`<link>` tags. Replace Quill 1.3.6 or self-host.

**M1** — Change guard from `!== "production"` to `=== "development"` in `auth.js:11`.
