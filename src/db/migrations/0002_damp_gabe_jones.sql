CREATE TABLE `agent_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`gate` text NOT NULL,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`evidence` text,
	`duration_ms` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_checks_step_idx` ON `agent_checks` (`step_id`);--> statement-breakpoint
CREATE INDEX `agent_checks_gate_idx` ON `agent_checks` (`step_id`,`gate`);--> statement-breakpoint
CREATE TABLE `agent_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`kind` text NOT NULL,
	`prompt` text NOT NULL,
	`token` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`action` text,
	`answer` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_decisions_token_unique` ON `agent_decisions` (`token`);--> statement-breakpoint
CREATE INDEX `agent_decisions_step_idx` ON `agent_decisions` (`step_id`);--> statement-breakpoint
CREATE TABLE `agent_locks` (
	`project_id` text PRIMARY KEY NOT NULL,
	`step_id` text NOT NULL,
	`acquired_at` integer NOT NULL,
	FOREIGN KEY (`step_id`) REFERENCES `agent_steps`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agent_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_id` text NOT NULL,
	`project_id` text NOT NULL,
	`base_sha` text,
	`status` text DEFAULT 'planning' NOT NULL,
	`implementation_plan` text,
	`qa_plan` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `agent_runs_project_idx` ON `agent_runs` (`project_id`);--> statement-breakpoint
CREATE INDEX `agent_runs_status_idx` ON `agent_runs` (`status`);--> statement-breakpoint
CREATE INDEX `agent_runs_source_idx` ON `agent_runs` (`source`,`source_id`);--> statement-breakpoint
CREATE TABLE `agent_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`idx` integer NOT NULL,
	`title` text NOT NULL,
	`instruction` text NOT NULL,
	`acceptance` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`branch` text,
	`pr_number` integer,
	`head_sha` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`question` text,
	`answer` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `agent_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_steps_run_idx` ON `agent_steps` (`run_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_steps_run_idx_uq` ON `agent_steps` (`run_id`,`idx`);--> statement-breakpoint
CREATE TABLE `defect_images` (
	`id` text PRIMARY KEY NOT NULL,
	`defect_id` text NOT NULL,
	`filename` text NOT NULL,
	`sha256` text NOT NULL,
	`media_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`defect_id`) REFERENCES `defects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `defect_images_defect_idx` ON `defect_images` (`defect_id`);--> statement-breakpoint
CREATE TABLE `defects` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`what_happened` text NOT NULL,
	`what_expected` text,
	`repro_steps` text,
	`route` text,
	`viewport_width` integer,
	`viewport_height` integer,
	`user_agent` text,
	`tier` text DEFAULT 'unknown' NOT NULL,
	`severity` text,
	`symptom` text,
	`suspected_causes` text,
	`visible_strings` text,
	`suspected_files` text,
	`confidence` text,
	`missing_info` text,
	`status` text DEFAULT 'triaging' NOT NULL,
	`triage_error` text,
	`reported_via` text NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`triaged_at` integer
);
--> statement-breakpoint
CREATE INDEX `defects_project_idx` ON `defects` (`project_id`);--> statement-breakpoint
CREATE INDEX `defects_status_idx` ON `defects` (`status`);--> statement-breakpoint
CREATE INDEX `defects_created_idx` ON `defects` (`created_at`);