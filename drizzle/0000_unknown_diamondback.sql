CREATE TABLE `authors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`login` text NOT NULL,
	`name` text,
	`avatar_url` text,
	`followers` integer DEFAULT 0 NOT NULL,
	`starred_count` integer DEFAULT 0 NOT NULL,
	`is_self` integer DEFAULT false NOT NULL,
	`last_synced_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_login_unique` ON `authors` (`login`);--> statement-breakpoint
CREATE TABLE `repos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`full_name` text NOT NULL,
	`description` text,
	`language` text,
	`stars` integer DEFAULT 0 NOT NULL,
	`forks` integer DEFAULT 0 NOT NULL,
	`topics` text DEFAULT '[]' NOT NULL,
	`homepage` text,
	`pushed_at` text,
	`archived` integer DEFAULT false NOT NULL,
	`fetched_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_full_name_unique` ON `repos` (`full_name`);--> statement-breakpoint
CREATE TABLE `stars` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`repo_id` integer NOT NULL,
	`starred_at` text NOT NULL,
	`category` text,
	`summary_zh` text,
	`classified_at` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stars_author_repo_unique` ON `stars` (`author_id`,`repo_id`);--> statement-breakpoint
CREATE INDEX `stars_author_starred_at_idx` ON `stars` (`author_id`,`starred_at`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`last_starred_at` text,
	`last_cursor` text,
	`full_sync_completed_at` text,
	`last_run_at` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`error` text,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_state_author_unique` ON `sync_state` (`author_id`);--> statement-breakpoint
CREATE TABLE `wiki_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer NOT NULL,
	`doc_key` text NOT NULL,
	`space_id` text NOT NULL,
	`node_token` text NOT NULL,
	`document_id` text,
	`content_hash` text,
	`title` text,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_nodes_author_doc_unique` ON `wiki_nodes` (`author_id`,`doc_key`);--> statement-breakpoint
CREATE INDEX `wiki_nodes_node_token_idx` ON `wiki_nodes` (`node_token`);