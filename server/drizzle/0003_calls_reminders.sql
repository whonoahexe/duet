CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`creator_id` text NOT NULL,
	`for_user_id` text,
	`title` text NOT NULL,
	`rule` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_fire_at` integer,
	`next_lead_min` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`creator_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`for_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`enabled`,`next_fire_at`);--> statement-breakpoint
ALTER TABLE `messages` ADD `call_kind` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `call_outcome` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `call_duration_ms` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `reminder_for_user_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `reminder_lead_min` integer;