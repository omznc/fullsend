CREATE TABLE `webhook_replays` (
	`webhook_id` text NOT NULL,
	`message_id` text NOT NULL,
	`queued_at` integer NOT NULL,
	PRIMARY KEY(`webhook_id`, `message_id`)
);
--> statement-breakpoint
CREATE INDEX `webhook_replays_queued` ON `webhook_replays` (`queued_at`);