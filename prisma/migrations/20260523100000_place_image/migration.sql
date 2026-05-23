-- Track 2 (docs/track2-photo-gallery.md): per-place photo gallery.
--
-- Adds:
--   1. Place.galleryLastScrapedAt — timestamp used by the runner to pick
--      the next batch (NULL = never scraped, else > 365 days old).
--   2. PlaceImage table — up to 10 rows per Place, ordered by `position`.
--      Position 1 is the default hero unless Place.heroImageUrl was
--      admin-pinned to a non-gallery path.
--
-- Dedup-on-rescrape strategy: @@unique(placeId, sourceRef) means a
-- yearly re-scrape of the same Google photo (sourceRef = stable Google
-- photo ID) is an UPDATE, not a duplicate INSERT — admin-hide flags and
-- position survive across re-scrapes.
--
-- Note on signed URLs: PlaceImage.sourceUrl is the lh3 URL we downloaded
-- bytes from, kept for audit. It is NOT usable for re-downloads — lh3
-- URLs expire in minutes (2026-05-23 Track 1 regression). The download
-- always happens in the same scrape session that produced the URL.

ALTER TABLE `Place`
  ADD COLUMN `galleryLastScrapedAt` DATETIME(3) NULL;

CREATE TABLE `PlaceImage` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `placeId`    INT NOT NULL,
  `position`   INT NOT NULL,
  `localPath`  VARCHAR(255) NOT NULL,
  `source`     VARCHAR(20) NOT NULL,
  `sourceRef`  VARCHAR(255) NULL,
  `sourceUrl`  VARCHAR(500) NULL,
  `width`      INT NULL,
  `height`     INT NULL,
  `bytes`      INT NULL,
  `isHidden`   BOOLEAN NOT NULL DEFAULT false,
  `scrapedAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `PlaceImage_placeId_position_idx` (`placeId`, `position`),
  UNIQUE INDEX `PlaceImage_placeId_sourceRef_key` (`placeId`, `sourceRef`),

  CONSTRAINT `PlaceImage_placeId_fkey`
    FOREIGN KEY (`placeId`) REFERENCES `Place`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB;
