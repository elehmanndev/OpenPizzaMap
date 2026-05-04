-- Enrichment pipeline (docs/enrichment-pipeline.md). Adds the canonical
-- identity column googlePlaceId (unique, nullable until backfilled),
-- googlePlaceUrl for the canonical GMaps link, and enrichmentVersion
-- to target future re-runs. enrichedAt already exists.
ALTER TABLE `Place`
  ADD COLUMN `googlePlaceId` VARCHAR(64) NULL,
  ADD COLUMN `googlePlaceUrl` VARCHAR(500) NULL,
  ADD COLUMN `enrichmentVersion` INT NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX `Place_googlePlaceId_key` ON `Place`(`googlePlaceId`);

-- Provider response cache. (provider, queryHash) is canonical;
-- queryHash = sha256("name|city|country"). 90-day TTL is enforced in
-- application code (lookups filter expiresAt > now()), but the index
-- on expiresAt lets a future cron sweep delete expired rows cheaply.
CREATE TABLE `EnrichmentCache` (
  `id` INTEGER NOT NULL AUTO_INCREMENT,
  `provider` VARCHAR(20) NOT NULL,
  `queryHash` VARCHAR(64) NOT NULL,
  `responseJson` LONGTEXT NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `EnrichmentCache_provider_queryHash_key`(`provider`, `queryHash`),
  INDEX `EnrichmentCache_expiresAt_idx`(`expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
