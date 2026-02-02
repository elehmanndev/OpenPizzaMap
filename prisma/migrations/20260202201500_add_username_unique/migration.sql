-- Add unique constraint for usernames
CREATE UNIQUE INDEX `User_displayName_key` ON `User`(`displayName`);
