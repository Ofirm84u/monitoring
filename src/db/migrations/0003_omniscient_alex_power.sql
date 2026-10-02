DROP INDEX `agent_checks_gate_idx`;--> statement-breakpoint
ALTER TABLE `agent_checks` ADD `attempt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `agent_checks_gate_idx` ON `agent_checks` (`step_id`,`attempt`,`gate`);