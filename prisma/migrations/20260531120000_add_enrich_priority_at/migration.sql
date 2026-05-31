-- Admin-edit priority signal. Set to now() when a place is edited in the
-- admin; opm-runner enrichment queues order by this DESC (MySQL puts NULLs
-- last on DESC) so freshly-edited spots are processed first.

-- AlterTable
ALTER TABLE `Place` ADD COLUMN `enrichPriorityAt` DATETIME(3) NULL;
