PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_wiki_nodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`author_id` integer,
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
INSERT INTO `__new_wiki_nodes`("id", "author_id", "doc_key", "space_id", "node_token", "document_id", "content_hash", "title", "updated_at") SELECT "id", "author_id", "doc_key", "space_id", "node_token", "document_id", "content_hash", "title", "updated_at" FROM `wiki_nodes`;--> statement-breakpoint
DROP TABLE `wiki_nodes`;--> statement-breakpoint
ALTER TABLE `__new_wiki_nodes` RENAME TO `wiki_nodes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_nodes_doc_key_unique` ON `wiki_nodes` (`doc_key`);--> statement-breakpoint
CREATE INDEX `wiki_nodes_node_token_idx` ON `wiki_nodes` (`node_token`);