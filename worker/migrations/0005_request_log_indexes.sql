CREATE INDEX `api_requests_class` ON `api_requests` (("status" / 100),`created_at`);--> statement-breakpoint
CREATE INDEX `api_requests_key` ON `api_requests` (`api_key_id`,`created_at`);