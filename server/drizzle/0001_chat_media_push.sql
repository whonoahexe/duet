CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`uploader_id` text NOT NULL,
	`message_seq` integer,
	`position` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`declared_size` integer NOT NULL,
	`width` integer,
	`height` integer,
	`duration_ms` integer,
	`waveform` text,
	`error` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`uploader_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attachments_message_seq_idx` ON `attachments` (`message_seq`);--> statement-breakpoint
CREATE TABLE `messages` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`sender_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text,
	`reply_to_seq` integer,
	`created_at` integer NOT NULL,
	`updated_seq` integer NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_id_unique` ON `messages` (`id`);--> statement-breakpoint
CREATE INDEX `messages_updated_seq_idx` ON `messages` (`updated_seq`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`session_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_ok_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE TABLE `reactions` (
	`message_seq` integer NOT NULL,
	`user_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`message_seq`, `user_id`),
	FOREIGN KEY (`message_seq`) REFERENCES `messages`(`seq`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `read_state` (
	`user_id` text PRIMARY KEY NOT NULL,
	`last_read_seq` integer DEFAULT 0 NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
