DROP INDEX `wiki_nodes_doc_key_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `wiki_nodes_doc_space_unique` ON `wiki_nodes` (`doc_key`,`space_id`);