-- External review snapshots (Google + TripAdvisor) on Place. Up to 5
-- reviews per source, stored as JSON. Refresh cadence handled by the
-- maintenance runner.
ALTER TABLE `Place`
  ADD COLUMN `googleReviewsJson` TEXT NULL,
  ADD COLUMN `googleReviewsFetchedAt` DATETIME(3) NULL,
  ADD COLUMN `tripadvisorReviewsJson` TEXT NULL,
  ADD COLUMN `tripadvisorReviewsFetchedAt` DATETIME(3) NULL;
