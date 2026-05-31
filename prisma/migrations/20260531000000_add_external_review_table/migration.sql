-- Promote scraped external reviews (Google + TripAdvisor) from the
-- Place.*ReviewsJson blobs to first-class rows, mirroring PlaceImage.
-- Each row owns its position + isHidden so admin reorder/hide survives the
-- monthly re-scrape (scraper upserts on placeId+source+dedupKey).

-- CreateTable
CREATE TABLE `ExternalReview` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `placeId` INTEGER NOT NULL,
    `source` VARCHAR(20) NOT NULL,
    `position` INTEGER NOT NULL,
    `author` VARCHAR(191) NULL,
    `rating` DECIMAL(2, 1) NULL,
    `text` TEXT NULL,
    `relativeTime` VARCHAR(60) NULL,
    `profilePhoto` VARCHAR(500) NULL,
    `publishedAt` DATETIME(3) NULL,
    `lang` VARCHAR(10) NULL,
    `isHidden` BOOLEAN NOT NULL DEFAULT false,
    `dedupKey` VARCHAR(191) NOT NULL,
    `scrapedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ExternalReview_placeId_source_position_idx`(`placeId`, `source`, `position`),
    UNIQUE INDEX `ExternalReview_placeId_source_dedupKey_key`(`placeId`, `source`, `dedupKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ExternalReview` ADD CONSTRAINT `ExternalReview_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `Place`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
