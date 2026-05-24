-- Profile stamps + city-hub metro view + AI review summary + visit dates.
--
-- All changes are ADDITIVE and NULLABLE. Existing rows stay valid;
-- features light up as the new columns get populated by enricher /
-- seed scripts / user actions.
--
-- 1. City   gains iconSlug, lat, lng, region, metroRadiusKm
--    → drives stamp icons on /me + the city-hub Near-{city} metro tier.
-- 2. Place  gains aiReviewSummary + aiReviewSummaryAt
--    → drives the "Pizza Lovers say" section on place pages.
-- 3. Visit  gains visitedAt
-- 4. Review gains visitedAt
--    → user-supplied month-precision dates. The render path uses
--      visitedAt ?? createdAt so legacy rows still display a date.

-- ── City ──────────────────────────────────────────────────────────
ALTER TABLE `City`
  ADD COLUMN `iconSlug`      VARCHAR(80) NULL,
  ADD COLUMN `lat`           DOUBLE      NULL,
  ADD COLUMN `lng`           DOUBLE      NULL,
  ADD COLUMN `region`        VARCHAR(191) NULL,
  ADD COLUMN `metroRadiusKm` DOUBLE      NULL;

-- ── Place ─────────────────────────────────────────────────────────
ALTER TABLE `Place`
  ADD COLUMN `aiReviewSummary`   TEXT        NULL,
  ADD COLUMN `aiReviewSummaryAt` DATETIME(3) NULL;

-- ── Visit ─────────────────────────────────────────────────────────
ALTER TABLE `Visit`
  ADD COLUMN `visitedAt` DATETIME(3) NULL;

-- ── Review ────────────────────────────────────────────────────────
ALTER TABLE `Review`
  ADD COLUMN `visitedAt` DATETIME(3) NULL;
