CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`permission` text NOT NULL,
	`domain_id` text,
	`rate_limit` integer DEFAULT 10 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cf_zone_id` text,
	`cf_subdomain_tag` text,
	`status` text NOT NULL,
	`region` text DEFAULT 'global' NOT NULL,
	`open_tracking` integer NOT NULL,
	`click_tracking` integer NOT NULL,
	`event_subscription_id` text,
	`event_subscription_error` text,
	`records` text DEFAULT '[]' NOT NULL,
	`source` text DEFAULT 'api' NOT NULL,
	`checked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_name` ON `domains` (`name`);--> statement-breakpoint
CREATE TABLE `email_events` (
	`id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`recipient` text,
	`type` text NOT NULL,
	`data` text,
	`bot` text,
	`cf_event_id` text,
	`done` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `email_events_email` ON `email_events` (`email_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_events_type` ON `email_events` (`type`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_events_cf_event` ON `email_events` (`cf_event_id`);--> statement-breakpoint
CREATE TABLE `emails` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key_id` text NOT NULL,
	`domain_id` text,
	`from` text NOT NULL,
	`to` text NOT NULL,
	`cc` text,
	`bcc` text,
	`reply_to` text,
	`subject` text NOT NULL,
	`tags` text,
	`headers` text,
	`attachments` text,
	`suppressed` text,
	`status` text NOT NULL,
	`last_event` text NOT NULL,
	`last_event_at` integer NOT NULL,
	`error` text,
	`scheduled_at` integer,
	`dispatched_at` integer,
	`claimed_at` integer,
	`cf_message_id` text,
	`body_key` text,
	`size` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer
);
--> statement-breakpoint
CREATE INDEX `emails_created` ON `emails` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `emails_status` ON `emails` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `emails_scheduled` ON `emails` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `emails_cf_message_id` ON `emails` (`cf_message_id`);--> statement-breakpoint
CREATE INDEX `emails_api_key` ON `emails` (`api_key_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `emails_domain` ON `emails` (`domain_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`api_key_id` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`state` text NOT NULL,
	`response` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`api_key_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `suppressions` (
	`address` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`email_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`message_id` text NOT NULL,
	`event_id` text,
	`event_type` text NOT NULL,
	`attempt` integer NOT NULL,
	`status_code` integer,
	`duration_ms` integer,
	`request_body` text NOT NULL,
	`response_excerpt` text,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_webhook` ON `webhook_deliveries` (`webhook_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_message` ON `webhook_deliveries` (`message_id`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint` text NOT NULL,
	`events` text NOT NULL,
	`secret` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);
