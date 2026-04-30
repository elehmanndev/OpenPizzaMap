# 2026-04-30 — Hostinger IOPS rescue + popup thumbnails

Session trigger: Hostinger sent a "you're over your resource limits" email. The
panel showed both **IOPS (avg 112, peaks at the 512 limit)** and **Max Processes
(avg 101 of 120)** sustained-red over 04-22 → 04-30. Goal: cut both back under
their thresholds without paying for a bigger plan or a paid CDN tier.

## Root causes identified

1. **`getLatestMtimeMs` recursive scan in `src/app.js`** at every Passenger
   worker boot was stat()-ing the entire `public/` tree — **1,415 files / 401 MB**,
   most of which is `public/uploads/places/` user images. Every cold worker boot
   meant ~1,400 syscalls just to compute the cache-bust query string.
2. **Heroes served at full original resolution**. Map popups used
   `background-image:url(/uploads/places/{id}.jpg)`. Some originals were
   **28 MB / 14 MB / 10 MB** raw photos — painted into a 280×150 popup. Each
   click downloaded the full image; Node `express.static` read it from disk
   (slow TTFB ≈ 600 ms) on every cache miss.
3. **`prisma migrate deploy` ran on every Passenger respawn** via the `start`
   script. Each respawn = MySQL round-trips + Prisma engine subprocess. That
   plus `morgan("dev")` writing to stdout at every request (Passenger captures
   to disk) compounded the writes.
4. **Prisma query engine spawns a separate binary process** alongside Node, so
   each Passenger worker = 2 processes against the 120 cap.

## What shipped (commits `7d2dcf9`, `ecdcab3`, on top of Eric's `7dd1f5a` UI)

### `scripts/build-thumbs.js` (new)

Sharp-based offline thumbnail generator. For each
`public/uploads/places/{id}.{ext}` it writes a sibling `{id}-thumb.jpg` at
**400 px wide, JPEG q78, mozjpeg, with EXIF rotation**. Idempotent (skips
when thumb mtime ≥ source mtime); `--force` regenerates; `--file <path>`
operates on a single file (used by the download hook).

`npm run thumbs:build` is the manual entrypoint.

**Result of the bulk run**: 1,398 thumbs built, 12 failed (11 pathological
AVIFs that sharp's libheif chokes on, 1 truncated JPG). 395 MB of source →
**23 MB of thumbs (94% smaller)**. Worst-case outliers dropped from MB to KB:

| Place | Original | Thumb |
|------:|---------:|------:|
| 1116  | 28.1 MB  | 29 KB |
| 1012  | 14.4 MB  | 23 KB |
| 1150  | 10.5 MB  | 23 KB |
| 1032  |  9.7 MB  | 25 KB |
| 1198  |  9.5 MB  | 30 KB |

### `scripts/download-images.js` — auto-thumb on new fetches

The `downloadOne` function now generates the thumb inline right after writing
the source. Best-effort: if sharp can't decode (a few weird AVIFs), the popup
falls back to the original via `<img onerror>`.

### `public/js/map.js` — popup uses thumb with fallback

Replaced the `background-image:url(...)` div with a real `<img>` element. New
helper `thumbUrlFor(url)` rewrites `/uploads/places/{id}.{ext}` →
`/uploads/places/{id}-thumb.jpg`. External URLs (legacy hotlinks) and unknown
extensions pass through unchanged.

The `<img>` carries `data-fallback="<original>"` and an inline `onerror` that
swaps to the original on first failure, then `.remove()`s itself if even the
original 404s. Verified end-to-end in browser preview — both happy path and
forced 404 fallback.

### `public/css/styles.css` — `.ppc-hero-img` rules

Added inside Eric's UI commit `7dd1f5a`. Positions the new `<img>` as
`absolute; inset:0; object-fit:cover` so the popup hero behaves identically
to the old `background-size:cover` div.

### `src/app.js` — startup IOPS + per-request reductions

- **Asset-version scan now scoped** to `public/{css,js,assets}` only (~50
  files instead of 1,415). `uploads/` is explicitly excluded; if you ever
  need a pinned bust string, set `ASSET_VERSION` in the Hostinger env.
- **Morgan production-aware**: in `NODE_ENV=production` it only logs ≥4xx
  via `combined`; dev still gets full `dev` format.
- **Static cache headers**: `/public` and `/uploads` mounts now serve with
  `{ maxAge: "30d", immutable: true, etag: true }`. (The CDN in front
  overrides to 1 year — see below — so this is a backstop.)

### `package.json` — sharp + script

`sharp` added as devDep. `npm run thumbs:build` script registered.

### Reverted mid-flight

Originally also planned to (a) move `prisma migrate deploy` out of `start`
and (b) flip `AUTO_SEED` default to `false`. Eric reverted both — "no me
acuerdo yo nunca de hacerlo" — keeping the auto-migrate-on-boot behavior.
This means `prisma migrate deploy` still runs at every Passenger respawn.
If IOPS/processes are still red after this push warms up, that's the next
lever to pull (move migrate to a build hook).

## CDN situation

Production already serves through **Cloudflare + Hostinger HCDN**:

```
Server: cloudflare
x-hcdn-cache-status: MISS
Cache-Control: public, max-age=31536000   (1 year, set by HCDN)
```

So the `/uploads/*` and `/public/*` files are cached at edge for a year on
each PoP after first hit. **Polish (paid) was NOT enabled** — Eric is on
Cloudflare Free, so 28 MB originals on `/place/:id` still travel full-size
to the client (slow page, but Hostinger only serves them on cache miss).
Map popups are now ~30 KB each, which is the case that visitors hit most.

## Round 2 — closing the open frentes (same day)

Eric came back asking to fix the three loose ends. All addressed:

### `*-large.jpg` for `/place/:id` hero (1200 px, q82)

`build-thumbs.js` now builds **two variants per source**: `-thumb.jpg`
(400 px, q78) and `-large.jpg` (1200 px, q82). Pass `--variant thumb|large|all`
to scope; default is `all`. `src/views/place.ejs` calls a new `largeVariant()`
helper inline (mirrors `thumbUrlFor` in `map.js`) and uses the same
`<img onerror>` fallback pattern.

Bulk run delta on the 1,398 working sources:
- thumb: 1.7 MB → 0.2 MB (already mostly done last round; the 11 AVIFs caught up)
- **large: 396.7 MB → 97.7 MB (75% smaller)**

Worst-case place 1116: 28 MB → **222 KB** on the detail page (×127). Place 43
(formerly failing AVIF): 180 KB original → 22 KB thumb + 170 KB large.

### Playwright fallback for sharp-incompatible AVIFs

11 of the original 12 failures were valid AVIFs that sharp's bundled libheif
choked on (`heif: bad seek`). `build-thumbs.js` now lazy-loads Playwright
Chromium when sharp throws, renders the source via a data: URL in a headless
page, screenshots the `<img>` at the target width, and re-encodes via sharp's
JPEG path. Slow (~3 s per call) but only triggers on rare failures.

All 11 AVIFs now have working variants.

### `946.jpg` was HTML, not an image

`file public/uploads/places/946.jpg` → `HTML document, UTF-8 text`. The
original scrape saved a server error page as `.jpg`. Disk file deleted
(`rm public/uploads/places/946*`). DB still has
`Place.heroImageUrl = "/uploads/places/946.jpg"` — the popup/ficha
`<img onerror>` chain handles the 404 gracefully (.remove()s itself), but
the row should be nulled when convenient. SQL noted in repo for next manual
admin pass:

```sql
UPDATE Place SET heroImageUrl = NULL WHERE id = 946;
```

(Eric was advised to rotate his MySQL password first — see security note below.)

### Smart `scripts/migrate.js` — skip when migrations unchanged

Eric explicitly didn't want to remove migrate-on-boot ("nunca me acuerdo de
hacerlo manualmente"). New strategy: hash the names + sizes + mtimes of every
file under `prisma/migrations/` and persist the hash to
`.builds/last-migrate-hash` after a successful run. On every subsequent boot,
recompute and compare — match → exit immediately, no MySQL traffic, no engine
spawn. Mismatch (new migration committed) → run normally, update sentinel.

`MIGRATE_FORCE=true` overrides if the sentinel ever desyncs.
`.builds/last-migrate-hash` added to `.gitignore` (it's per-host state).

Verified locally: first call (no sentinel) → "RUN", second call (matching
sentinel) → "SKIP". On Hostinger this means **migrate runs once per deploy,
then every Passenger respawn until the next deploy is a no-op**.

### Security note — leaked credential

While checking which DB the local env points to, a `grep` regex didn't fully
mask the password and the full `mysql://` URL ended up in chat. Eric was
advised to rotate the password in the Hostinger panel and update both
`.env.local` and `.builds/config/.env`. The repo never carried the password
(both env files are in `.gitignore`).

## What's still open

1. **Place 946 DB row still points at the deleted file**. Run the SQL above
   from the Hostinger panel after rotating the password.
2. **No upload UI yet**. `admin_place_edit.ejs` has only a text `<input>`
   for `heroImageUrl`. If/when a real upload endpoint lands (multer or
   similar), spawn `scripts/build-thumbs.js --file <newfile>` from the
   handler.

## Verification of the deploy

- `https://openpizzamap.com/uploads/places/787-thumb.jpg` → 200, 3.5 KB,
  served via `Server: cloudflare` + HCDN.
- `git status`: clean against `origin/main` after Eric's push (commits
  `7dd1f5a`, `7d2dcf9`, `ecdcab3`, `c69011f`).

Watch the Hostinger panel over the next 24 h. Expected pattern: IOPS
average drops once worker-boot scans stop hammering disk; Max Processes
flattens once popup hits stop spawning extra disk reads. If still red,
next move is Cloudflare Cache Rule for `/uploads/*` (forces edge caching
even with weird origin headers) — **NOT** paid Polish.
