-- AlterTable
ALTER TABLE `Place` ADD COLUMN `cityId` INTEGER NULL,
    ADD COLUMN `descriptionHtml` LONGTEXT NULL,
    ADD COLUMN `heroImageUrl` VARCHAR(191) NULL,
    ADD COLUMN `isVisible` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `seoDescription` VARCHAR(200) NULL,
    ADD COLUMN `seoTitle` VARCHAR(191) NULL,
    ADD COLUMN `slug` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Country` (
    `code` CHAR(2) NOT NULL,
    `name` VARCHAR(191) NULL,
    `slug` VARCHAR(191) NULL,
    `introHtml` LONGTEXT NULL,
    `heroImageUrl` VARCHAR(191) NULL,
    `seoTitle` VARCHAR(191) NULL,
    `seoDescription` VARCHAR(200) NULL,
    `isVisible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Country_slug_key`(`slug`),
    INDEX `Country_isVisible_idx`(`isVisible`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `City` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `countryCode` CHAR(2) NOT NULL,
    `introHtml` LONGTEXT NULL,
    `heroImageUrl` VARCHAR(191) NULL,
    `seoTitle` VARCHAR(191) NULL,
    `seoDescription` VARCHAR(200) NULL,
    `isVisible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `City_countryCode_idx`(`countryCode`),
    INDEX `City_isVisible_idx`(`isVisible`),
    UNIQUE INDEX `City_countryCode_slug_key`(`countryCode`, `slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Faq` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `scope` ENUM('global', 'country', 'city', 'place') NOT NULL,
    `countryCode` CHAR(2) NULL,
    `cityId` INTEGER NULL,
    `placeId` INTEGER NULL,
    `question` VARCHAR(200) NOT NULL,
    `answerHtml` LONGTEXT NOT NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isVisible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Faq_scope_idx`(`scope`),
    INDEX `Faq_countryCode_idx`(`countryCode`),
    INDEX `Faq_cityId_idx`(`cityId`),
    INDEX `Faq_placeId_idx`(`placeId`),
    INDEX `Faq_isVisible_idx`(`isVisible`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Page` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(60) NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `bodyHtml` LONGTEXT NOT NULL,
    `seoTitle` VARCHAR(191) NULL,
    `seoDescription` VARCHAR(200) NULL,
    `isVisible` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Page_key_key`(`key`),
    INDEX `Page_isVisible_idx`(`isVisible`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Place_slug_key` ON `Place`(`slug`);

-- AddForeignKey
ALTER TABLE `Place` ADD CONSTRAINT `Place_cityId_fkey` FOREIGN KEY (`cityId`) REFERENCES `City`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Faq` ADD CONSTRAINT `Faq_cityId_fkey` FOREIGN KEY (`cityId`) REFERENCES `City`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Faq` ADD CONSTRAINT `Faq_placeId_fkey` FOREIGN KEY (`placeId`) REFERENCES `Place`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
