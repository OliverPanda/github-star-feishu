import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Authors whose star lists we track: either the local user or any public
 * GitHub account. Kept separate from repos so the same login can be re-synced
 * without losing history.
 */
export const authors = sqliteTable(
  "authors",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    login: text("login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    followers: integer("followers").default(0).notNull(),
    starredCount: integer("starred_count").default(0).notNull(),
    isSelf: integer("is_self", { mode: "boolean" }).default(false).notNull(),
    lastSyncedAt: text("last_synced_at"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [uniqueIndex("authors_login_unique").on(table.login)],
);

/**
 * Repositories are deduplicated globally: when several tracked authors star the
 * same repo it is stored once, which is what makes the "cross-endorsed by
 * multiple experts" signal cheap to compute.
 */
export const repos = sqliteTable(
  "repos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fullName: text("full_name").notNull(),
    description: text("description"),
    language: text("language"),
    stars: integer("stars").default(0).notNull(),
    forks: integer("forks").default(0).notNull(),
    topics: text("topics", { mode: "json" }).$type<string[]>().default([]).notNull(),
    homepage: text("homepage"),
    pushedAt: text("pushed_at"),
    archived: integer("archived", { mode: "boolean" }).default(false).notNull(),
    fetchedAt: text("fetched_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [uniqueIndex("repos_full_name_unique").on(table.fullName)],
);

/**
 * The star edge: who starred what, and when. `starredAt` drives incremental
 * sync (anything at or before the stored watermark is skipped), and
 * `category`/`summaryZh` are cached per repo so an LLM call is never repeated
 * for a repo that a second author also starred.
 */
export const stars = sqliteTable(
  "stars",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: integer("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade" }),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    starredAt: text("starred_at").notNull(),
    category: text("category"),
    summaryZh: text("summary_zh"),
    /** How this repo is expected to earn money; see MONETIZATION_PATHS. */
    monetization: text("monetization"),
    /** 1-5 monetary promise, the sort key for the "最值得搞钱" ranking. */
    moneyScore: integer("money_score"),
    classifiedAt: text("classified_at"),
    /**
     * TAXONOMY_VERSION the row was classified under. A row written by an older
     * taxonomy is treated as unclassified, so a taxonomy change re-classifies
     * lazily on the next sync rather than needing a manual cache purge.
     */
    taxonomyVersion: integer("taxonomy_version"),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("stars_author_repo_unique").on(table.authorId, table.repoId),
    index("stars_author_starred_at_idx").on(table.authorId, table.starredAt),
  ],
);

/**
 * Incremental sync watermark per author. `lastStarredAt` is the newest
 * starred_at we have already stored; `fullSyncCompletedAt` distinguishes "never
 * synced" from "synced and there was genuinely nothing new", which otherwise
 * look identical and would cause a full re-walk on every run.
 */
export const syncState = sqliteTable(
  "sync_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: integer("author_id")
      .notNull()
      .references(() => authors.id, { onDelete: "cascade" }),
    lastStarredAt: text("last_starred_at"),
    lastCursor: text("last_cursor"),
    fullSyncCompletedAt: text("full_sync_completed_at"),
    lastRunAt: text("last_run_at"),
    status: text("status").default("idle").notNull(),
    error: text("error"),
  },
  (table) => [uniqueIndex("sync_state_author_unique").on(table.authorId)],
);

/**
 * Maps a generated document to its Feishu node. `contentHash` makes re-runs
 * idempotent: unchanged Markdown skips the write entirely, and a changed doc
 * updates the existing node instead of creating a duplicate.
 *
 * Identity is `(docKey, spaceId)`, never `docKey` alone: a node token only
 * addresses a node inside the space that issued it, so the same document
 * published to two spaces is two independent nodes. Keying on `docKey` alone
 * let a `--local` dry run overwrite the real Feishu token (and vice versa),
 * which then produced duplicate pages on the next real run.
 *
 * `docKey` is not scoped per author: the knowledge base index page belongs to
 * no single author, and every per-author key already embeds the login.
 * `authorId` is therefore attribution metadata (and the hook for cascade
 * cleanup) instead of part of the identity.
 */
export const wikiNodes = sqliteTable(
  "wiki_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    authorId: integer("author_id").references(() => authors.id, { onDelete: "cascade" }),
    docKey: text("doc_key").notNull(),
    spaceId: text("space_id").notNull(),
    nodeToken: text("node_token").notNull(),
    documentId: text("document_id"),
    contentHash: text("content_hash"),
    /**
     * Parent the node was last written under, or NULL for rows created before
     * this column existed. A node token alone does not say where a document
     * sits, and `wiki create` only honours the parent on the very first write:
     * without remembering the placement, a document that an early run left in
     * the space root could never be moved into its author's subtree.
     */
    parentNodeToken: text("parent_node_token"),
    title: text("title"),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [
    uniqueIndex("wiki_nodes_doc_space_unique").on(table.docKey, table.spaceId),
    index("wiki_nodes_node_token_idx").on(table.nodeToken),
  ],
);

export type AuthorRow = typeof authors.$inferSelect;
/**
 * Subscriptions are user intent ("track this login"), which is deliberately
 * separate from `authors`, the synced profile of a login we have already
 * fetched. A subscription therefore exists before any star data does, and the
 * extension can add or remove entries without a sync having run.
 *
 * The YAML file stays the CI entry point; this table is what the API serves.
 */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    login: text("login").notNull(),
    /** Shown instead of the login in the knowledge base. */
    alias: text("alias"),
    /** Marks the reader's own account, which changes document titles. */
    isSelf: integer("is_self", { mode: "boolean" }).default(false).notNull(),
    /** Parks an account without deleting its row. */
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    createdAt: text("created_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
  (table) => [uniqueIndex("subscriptions_login_unique").on(table.login)],
);

export const settings = sqliteTable(
  "settings",
  {
    key: text("key").primaryKey(),
    value: text("value").notNull(),
    updatedAt: text("updated_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
  },
);

/**
 * One row per batch run, so the extension's status panel can answer "when did
 * it last run, what changed, and what broke" without re-deriving it from the
 * per-author watermark. `detail` keeps the per-author outcomes as JSON because
 * they are only ever read back as a whole, never queried by field.
 */
export const syncRuns = sqliteTable(
  "sync_runs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    startedAt: text("started_at")
      .default(sql`(datetime('now'))`)
      .notNull(),
    finishedAt: text("finished_at"),
    /** running | success | partial | failed */
    status: text("status").default("running").notNull(),
    /** How the run was started: cli | api | schedule. */
    trigger: text("trigger").default("cli").notNull(),
    totalAuthors: integer("total_authors").default(0).notNull(),
    failedAuthors: integer("failed_authors").default(0).notNull(),
    newStars: integer("new_stars").default(0).notNull(),
    detail: text("detail", { mode: "json" }).$type<SyncRunAuthor[]>(),
    error: text("error"),
  },
  (table) => [index("sync_runs_started_at_idx").on(table.startedAt)],
);

export interface SyncRunAuthor {
  login: string;
  newStars: number;
  totalStars: number;
  unchanged: boolean;
  error: string | null;
}

export type RepoRow = typeof repos.$inferSelect;
export type StarRow = typeof stars.$inferSelect;
export type WikiNodeRow = typeof wikiNodes.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;
export type SyncRunRow = typeof syncRuns.$inferSelect;
