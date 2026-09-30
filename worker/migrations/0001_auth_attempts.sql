CREATE TABLE `auth_attempts` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`locked_until` integer NOT NULL,
	`updated_at` integer NOT NULL
);
