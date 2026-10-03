CREATE TABLE `api_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`api_key_id` text,
	`error_name` text,
	`error_message` text,
	`duration_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `api_requests_created` ON `api_requests` (`created_at`);--> statement-breakpoint
CREATE INDEX `api_requests_status` ON `api_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `system_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`level` text NOT NULL,
	`source` text NOT NULL,
	`message` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `system_events_created` ON `system_events` (`created_at`);--> statement-breakpoint
ALTER TABLE `emails` ADD `sweep_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `emails_status_event` ON `emails` (`status`,`last_event_at`);--> statement-breakpoint
CREATE INDEX `idempotency_keys_created` ON `idempotency_keys` (`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created` ON `webhook_deliveries` (`created_at`);