ALTER TABLE `emails` ADD `ignored_at` integer;--> statement-breakpoint
CREATE INDEX `emails_ignored` ON `emails` (`ignored_at`) WHERE "emails"."ignored_at" IS NOT NULL;