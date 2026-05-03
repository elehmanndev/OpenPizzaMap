-- Bump opmRating precision from Decimal(3,1) to Decimal(4,2) so the
-- bayesian rating algorithm can keep 2 decimals (9.06 vs 9.07). All
-- existing values fit cleanly: 9.5 → 9.50, 8.7 → 8.70, etc.
ALTER TABLE `Place` MODIFY `opmRating` DECIMAL(4, 2) NULL;

-- CreateTable
CREATE TABLE `Review` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `placeId` INTEGER NOT NULL,
    `userId` INTEGER NOT NULL,
    `pizza` DOUBLE NOT NULL,
    `local` DOUBLE NOT NULL,
    `servicio` DOUBLE NOT NULL,
    `precio` DOUBLE NOT NULL,
    `comment` VARCHAR(500) NULL,
    `isVisible` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Review_placeId_idx`(`placeId`),
    INDEX `Review_userId_idx`(`userId`),
    INDEX `Review_createdAt_idx`(`createdAt`),
    UNIQUE INDEX `Review_placeId_userId_key`(`placeId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `Place`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Review` ADD CONSTRAINT `Review_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
