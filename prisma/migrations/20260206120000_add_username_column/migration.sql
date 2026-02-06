-- Add username column (nullable) and unique index, and drop displayName uniqueness.
ALTER TABLE `User` ADD COLUMN `username` VARCHAR(20) NULL;

CREATE UNIQUE INDEX `User_username_key` ON `User`(`username`);

DROP INDEX `User_displayName_key` ON `User`;
