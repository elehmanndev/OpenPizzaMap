-- Drop AI-generated review summary columns. Field was never populated
-- (0/2511 rows) and is redundant with descriptionHtml which already
-- carries the editorial blurb.
ALTER TABLE `Place` DROP COLUMN `aiReviewSummary`;
ALTER TABLE `Place` DROP COLUMN `aiReviewSummaryAt`;
