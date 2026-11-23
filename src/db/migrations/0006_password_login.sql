CREATE TABLE `password_setup_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `password_setup_tokens_email_idx` ON `password_setup_tokens` (`email`);--> statement-breakpoint
ALTER TABLE `user` ADD `password_hash` text;