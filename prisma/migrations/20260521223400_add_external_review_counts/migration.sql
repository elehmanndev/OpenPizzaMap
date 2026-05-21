-- External-platform review count columns referenced in schema.prisma since
-- the enrichment pipeline landed (2026-05-04), but never tracked in a real
-- migration. Confirmed missing in prod via:
--   SELECT COLUMN_NAME FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Place'
--     AND COLUMN_NAME IN ('googleReviewCount','tripadvisorReviewCount','yelpReviewCount');
--   -> 0 rows
-- The enrichment pipeline (src/services/enrichment/batch.js) writes these
-- and has been silently failing (caught in try/catch as stats.errors++);
-- /api/places/markers' SELECT also broke when these fields were added.
ALTER TABLE `Place`
  ADD COLUMN `googleReviewCount` INT NULL,
  ADD COLUMN `tripadvisorReviewCount` INT NULL,
  ADD COLUMN `yelpReviewCount` INT NULL;
