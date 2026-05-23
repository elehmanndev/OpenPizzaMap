# Track 2 — Photo Gallery (Design Doc)

**Status:** Planning complete 2026-05-23 · Not yet implemented · Phased rollout

## Goal

Replace each place's single hero image with a gallery of up to **10 photos**,
sourced for free via a Playwright scrape of Google Maps. Surface as a
mobile-first swipeable carousel on the public place page; provide full admin
management tooling for hero pinning, reordering, hiding, and uploading.

## Why now

- `Place.heroImageUrl` already carries one Google CDN-sourced photo per place
  for ~1,820 of ~2,500 visible places.
- The Google Places Photos API path costs ~$0.05/place × 5 photos = ~$130 for a
  full backfill, eating most of the remaining €90 GCP credit and committing us
  to recurring spend for new submissions and refreshes.
- The same data is available for free by driving a browser through Google
  Maps. Memory `[lh3 URL TTL]` is mitigated by downloading bytes
  in the same scrape session rather than storing the signed URL.

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| 1 | Photo source for v1 | **Google only** | Schema leaves room for TA / website / submitted later. One source, one scraper, one failure mode. |
| 2 | Photos per place (cap) | **10** | Sweet spot between gallery richness and storage/scrape time. |
| 3 | File layout on disk | **`/uploads/places/{id}/N.{ext}`** (subdirs) | ~30 files in each of 2,500 subdirs is kinder to Hostinger shared filesystem than 75,000 files in one dir. |
| 4 | `Place.heroImageUrl` behaviour | **Admin-pinnable override** | Default = PlaceImage position 1; admin can pin any gallery photo as hero. Keeps map-marker reads single-column-fast. |
| 5 | `PlaceImage` schema fields | id, placeId, position, localPath, source, sourceRef, sourceUrl, width, height, bytes, scrapedAt, isHidden | Minimum that enables dedup-on-rescrape (`@@unique([placeId, sourceRef])`), audit trail, future TA/og sources. |
| 6 | Existing 1,820 heroes | **Migrate to position 1** with `source='legacy'` | Preserves curated editorial photos (Eater, Gambero Rosso, AVPN) which are often better than Google's top picks. |
| 7 | Runtime architecture | **Unraid scrape → Hostinger download** | Mirrors existing `localizeImages` pattern. Unraid runs Playwright; Hostinger writes bytes to its filesystem via a new admin endpoint. |
| 8 | Scrape pace | **10 places/tick** (both burn + min) | ~1.75 day backfill at the 10-min runner cadence. ~60 visits/hour stays under Google's residential-IP threshold. |
| 9 | Backfill order | **`ORDER BY id ASC`** | Deterministic. No prioritization signal needed. |
| 10 | Refresh cadence | **Yearly** | ~7 places/day steady state. Catches closures, doesn't accumulate storage. |
| 11 | CAPTCHA handling | **6-hour backoff, 3-strike → 7-day cooldown** | Self-healing. Logs suggestion to swap to CloakBrowser on escalation. |
| 12 | Public UI | **Swipeable carousel** (touch, dots, counter, lazy-load, ARIA, keyboard nav, fullscreen lightbox with pinch-zoom) | Mobile-first gold standard. Replaces static hero entirely. ~400 lines. |
| 13 | Image variants per photo | **Original + `-thumb` (400px) + `-large` (1200px)** | Consistent with existing hero pipeline. Lightbox shows originals at full quality. |
| 14 | Admin tooling scope | **Full CRUD** — set-hero, hide, hard-delete, drag-reorder, upload | ~300 lines in `admin_place_edit.ejs`. |
| 15 | User-submitted photos | **No in v1** | Adds auth + moderation queue + EXIF strip + abuse limits — separate session. |
| 16 | Rollout | **Phased — backend, then UI, then admin** | Three smaller deploys, each independently revertable. Lower Prisma-panic exposure. |

## Schema migration

```prisma
model PlaceImage {
  id          Int       @id @default(autoincrement())
  placeId     Int
  position    Int                          // 1..10
  localPath   String    @db.VarChar(255)   // /uploads/places/179/3.jpg
  source      String    @db.VarChar(20)    // 'google' | 'legacy' | 'tripadvisor' | 'website' | 'submitted'
  sourceRef   String?   @db.VarChar(255)   // Google photo ID, for dedup-on-rescrape
  sourceUrl   String?   @db.VarChar(500)   // original lh3 URL, audit trail
  width       Int?
  height      Int?
  bytes       Int?
  isHidden    Boolean   @default(false)    // admin-hide; survives re-scrape via sourceRef match
  scrapedAt   DateTime  @default(now())
  place       Place     @relation(fields: [placeId], references: [id], onDelete: Cascade)

  @@index([placeId, position])
  @@unique([placeId, sourceRef])
}

model Place {
  // ... existing fields ...
  galleryLastScrapedAt DateTime?           // refresh-cadence driver
  images               PlaceImage[]
}
```

## Rollout phases

### Phase 1 — Backend (one session, ~half-day)

1. **Prereq:** move `playwright` from devDependencies → dependencies in
   `package.json`. The opm-runner has been FAILing on `Cannot find module
   'playwright'` for at least a week — must resolve before the scraper can run.
2. Prisma schema migration as above.
3. One-shot migration script: walk 1,820 existing `heroImageUrl` values,
   `mv` files into subdirectory layout, insert `source='legacy'` PlaceImage
   rows, update `heroImageUrl` to new path. Idempotent.
4. New `scrapePhotos(page, { googlePlaceId })` function in
   `scripts/lib/gmaps.js`:
   - Navigate to `https://www.google.com/maps/place/?q=place_id:<id>`
   - Click the Photos tab (selector parallel to existing `scrapeReviews` tab click)
   - Scroll the photo grid to load up to 10 thumbnails
   - Extract `<img>` src URLs from grid; rewrite query params to request
     `=w1600-h1200` versions
   - Return array of `{ sourceUrl, sourceRef }` (sourceRef = stable Google
     photo ID parsed from URL)
   - Detect CAPTCHA (`form[action*="sorry"]`, `[src*="recaptcha"]`) → throw
     specific error
5. New maintenance phase `galleryScrape` (Unraid side):
   - Query `WHERE galleryLastScrapedAt IS NULL OR < NOW() - INTERVAL 365 DAY
     ORDER BY id ASC LIMIT 10`
   - For each place: invoke `scrapePhotos`, collect URLs
   - POST to Hostinger `/api/admin/maintenance?only=galleryDownload` with
     `{ jobs: [{ placeId, photoRefs: [...] }] }`
   - On CAPTCHA: append to `data/cache/gallery-backoff.json`, set `blockUntil`
6. New `galleryDownload` phase (Hostinger side, in `runMaintenance`):
   - Accept job payload from Unraid's POST
   - For each place: download URLs to `/uploads/places/{id}/N.{ext}`, build
     `-thumb` + `-large` via existing `build-thumbs.js`
   - Insert PlaceImage rows; update `Place.galleryLastScrapedAt`; refresh
     `heroImageUrl` if it's stale
7. Extend `/api/admin/audit/coverage` with gallery progress (count of places
   with ≥ N photos, queue depth).

**Exit criteria:** opm-runner logs show `galleryScrape: OK scraped=N`,
PlaceImage row count climbs, no visible UI change.

### Phase 2 — Public carousel UI (~half-day)

Wait until backfill is ~30-50% complete so every visible place has at least
2-3 photos before the UI ships.

1. Replace the static hero `<img>` in `place.ejs` with a carousel container.
2. Vanilla JS carousel (no framework dependency):
   - Touch swipe handlers (`touchstart` / `touchmove` / `touchend` with
     velocity + threshold)
   - Dot indicators below
   - Counter (`1 / 10`) in top-right corner
   - Lazy-load: only the current + next/prev slides have `<img src>`; others
     are `<img data-src>` swapped in on approach
   - Keyboard: `←` / `→` arrow keys
   - ARIA: `role="region"`, `aria-roledescription="carousel"`, slide labels
3. Fullscreen lightbox:
   - Tap/click any photo → opens fullscreen overlay
   - Pinch-zoom on mobile (gesture event handlers)
   - Swipe-to-dismiss on mobile (vertical swipe → close)
   - ESC to close (desktop)
   - Arrow keys to navigate within lightbox

**Mobile-first 375px design pass** before merging — memory `[Mobile-first UI]`.

### Phase 3 — Admin management UI (~half-day)

Extend `admin_place_edit.ejs`:

1. Photo grid section showing all PlaceImage rows (including hidden, marked
   with a visual indicator).
2. Per-photo controls:
   - **Set as hero** — writes path to `Place.heroImageUrl`.
   - **Hide forever** — sets `PlaceImage.isHidden=true`; survives re-scrapes
     because sourceRef-based dedup matches.
   - **Delete** — confirmation modal → hard delete row + files.
3. Drag-to-reorder via Sortable.js (already-vetted lightweight lib). On drop,
   POST new position order to a new admin endpoint; server rewrites
   `position` values atomically.
4. Upload form:
   - Multipart file input
   - Validate image MIME + size
   - Strip EXIF (privacy)
   - Build `-thumb` + `-large` via existing pipeline
   - Insert row with `source='admin'`, position = max+1

## Storage forecast

- 10 photos × 2,500 places × 3 variants ≈ **7.5 GB**
- Hostinger Business storage limit: ~200 GB. Comfortable headroom.
- Per-photo bytes:
  - original: ~200-400 KB (Google's serve-size)
  - `-large` (1200px): ~80 KB
  - `-thumb` (400px): ~30 KB

## Cost forecast

- Google API: **$0 ongoing.** The Playwright path doesn't touch the Places API.
- New-submission cost: $0 — new chatbot submissions get gallery scraped on
  the next runner tick after their `googlePlaceId` resolves.
- Refresh cost: $0 — yearly Playwright re-scrape.

## Risk register

| Risk | Mitigation |
|---|---|
| **Google CAPTCHAs the IP** | 6h backoff, 3-strike → 7-day cooldown. Manual CloakBrowser swap as escape hatch. |
| **opm-runner missing playwright** | Pre-req in Phase 1 — move dep, validate `playwrightFallback` step recovers in next tick. |
| **Prisma rust panic on deploy** | Postinstall already writes `restart.txt` + bumps `src/app.js` mtime; recurrence requires SSH chmod fallback per `docs/runbook.md` §Recovery. |
| **Storage runaway** | Yearly refresh REPLACES photos in place (overwrites files, upserts rows by `sourceRef`). No accumulation. |
| **Photos #6-10 are low quality** | Acceptable — gallery dropoff matches user expectation; admin can hide individual frames. |
| **Existing 1,820 heroes overlap with Google's #1** | Inevitable. After legacy migration, the first scrape will skip-via-unique any photo Google reports with a matching sourceRef. Since legacy rows have `sourceRef=null`, they won't match, so we end up with both the legacy hero AND Google's same photo. Resolve in a follow-up dedup pass via perceptual hashing if it becomes a visible problem. |

## Out of scope for v1

- TripAdvisor + og:image photo sources (designed-in via `source` column, not built)
- User-submitted photos (Q15)
- AI-based photo quality scoring / auto-filtering
- Per-photo captions or EXIF metadata display
- Perceptual-hash dedup across sources (deferred until measured need)

## Related memory references

- `[lh3 URL TTL]` — why we download bytes, not URLs
- `[Mobile-first UI]` — UI design constraint
- `[Hostinger Prisma CLI panic]` — why filesystem writes happen on Hostinger, not Unraid
- `[opm-runner cron]` — runtime context (Docker on Unraid, git-pulls on restart)
- `[GCP credit burn 2026-05-10]` — why the credit budget matters and why free
  scraping is preferred over Places Photos API
- `[CloakBrowser]` — escape-hatch if Google CAPTCHAs Playwright
- `[Don't oversell fixes]` — set realistic expectations on backfill timing
