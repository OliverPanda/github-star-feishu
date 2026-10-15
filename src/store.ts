import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import {
  authors,
  repos,
  settings,
  stars,
  subscriptions,
  syncRuns,
  syncState,
  wikiNodes,
  type SyncRunAuthor,
} from "./db/schema.js";
import type { AuthorProfile, StarEdge } from "./github/stars.js";
import type { Classification } from "./llm/classify.js";
import {
  FALLBACK_CATEGORY,
  FALLBACK_MONETIZATION,
  TAXONOMY_VERSION,
  normalizeCategory,
  normalizeMonetization,
  type Category,
} from "./taxonomy.js";

export interface AuthorRecord {
  id: number;
  login: string;
  name: string | null;
  followers: number;
  starredCount: number;
  isSelf: boolean;
}

export function upsertAuthor(db: Db, profile: AuthorProfile, isSelf = false): AuthorRecord {
  const existing = db.select().from(authors).where(eq(authors.login, profile.login)).get();

  if (existing) {
    db.update(authors)
      .set({
        name: profile.name,
        avatarUrl: profile.avatarUrl,
        followers: profile.followers,
        starredCount: profile.starredCount,
        lastSyncedAt: sql`(datetime('now'))`,
      })
      .where(eq(authors.id, existing.id))
      .run();
    return {
      id: existing.id,
      login: existing.login,
      name: profile.name,
      followers: profile.followers,
      starredCount: profile.starredCount,
      isSelf: existing.isSelf,
    };
  }

  const inserted = db
    .insert(authors)
    .values({
      login: profile.login,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
      followers: profile.followers,
      starredCount: profile.starredCount,
      isSelf,
    })
    .returning()
    .get();

  return {
    id: inserted.id,
    login: inserted.login,
    name: inserted.name,
    followers: inserted.followers,
    starredCount: inserted.starredCount,
    isSelf: inserted.isSelf,
  };
}

export function getAuthorByLogin(db: Db, login: string): AuthorRecord | undefined {
  const row = db.select().from(authors).where(eq(authors.login, login)).get();
  if (!row) return undefined;
  return {
    id: row.id,
    login: row.login,
    name: row.name,
    followers: row.followers,
    starredCount: row.starredCount,
    isSelf: row.isSelf,
  };
}


export function findAuthorIdByLogin(db: Db, login: string): number | undefined {
  return db.select({ id: authors.id }).from(authors).where(eq(authors.login, login)).get()?.id;
}

export interface AuthorSyncSummary {
  followers: number;
  starredCount: number;
  lastSyncedAt: string | null;
  syncedRepos: number;
}

/**
 * Everything the extension shows beside one subscription: profile numbers plus
 * how much of the star list has actually been stored. Returned per login
 * because the UI lists subscriptions, which may not have been synced yet.
 */
export function getAuthorSyncSummary(db: Db, login: string): AuthorSyncSummary | undefined {
  const row = db
    .select({
      id: authors.id,
      followers: authors.followers,
      starredCount: authors.starredCount,
      lastSyncedAt: authors.lastSyncedAt,
    })
    .from(authors)
    .where(eq(authors.login, login))
    .get();
  if (!row) return undefined;

  return {
    followers: row.followers,
    starredCount: row.starredCount,
    lastSyncedAt: row.lastSyncedAt,
    syncedRepos: countStarsForAuthor(db, row.id),
  };
}

export interface StoredRepo {
  id: number;
  fullName: string;
}

/**
 * Upsert repository metadata and return a fullName -> id map.
 *
 * Repos are shared across authors, so an existing row only has its volatile
 * metadata refreshed; `category`/`summaryZh` live on the star edge and are
 * preserved by the caller.
 */
export function upsertRepos(db: Db, edges: StarEdge[]): Map<string, number> {
  if (!edges.length) return new Map();

  const unique = new Map<string, StarEdge["repo"]>();
  for (const edge of edges) unique.set(edge.repo.fullName, edge.repo);

  const rows = [...unique.values()].map((repo) => ({
    fullName: repo.fullName,
    description: repo.description,
    language: repo.language,
    stars: repo.stars,
    forks: repo.forks,
    topics: repo.topics,
    homepage: repo.homepage,
    pushedAt: repo.pushedAt,
    archived: repo.archived,
  }));

  // Chunked because SQLite caps the number of bound variables per statement.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    db.insert(repos)
      .values(rows.slice(i, i + CHUNK))
      .onConflictDoUpdate({
        target: repos.fullName,
        set: {
          description: sql`excluded.description`,
          language: sql`excluded.language`,
          stars: sql`excluded.stars`,
          forks: sql`excluded.forks`,
          topics: sql`excluded.topics`,
          homepage: sql`excluded.homepage`,
          pushedAt: sql`excluded.pushed_at`,
          archived: sql`excluded.archived`,
          fetchedAt: sql`(datetime('now'))`,
        },
      })
      .run();
  }

  const names = [...unique.keys()];
  const map = new Map<string, number>();
  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    const found = db
      .select({ id: repos.id, fullName: repos.fullName })
      .from(repos)
      .where(inArray(repos.fullName, slice))
      .all();
    for (const row of found) map.set(row.fullName, row.id);
  }
  return map;
}

export function upsertStars(
  db: Db,
  authorId: number,
  edges: StarEdge[],
  repoIds: Map<string, number>,
): number {
  if (!edges.length) return 0;

  const rows = edges
    .map((edge) => {
      const repoId = repoIds.get(edge.repo.fullName);
      if (repoId === undefined) return null;
      return { authorId, repoId, starredAt: edge.starredAt };
    })
    .filter((row): row is { authorId: number; repoId: number; starredAt: string } => row !== null);

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    // Ignore conflicts: re-starring an already-known repo must not reset its
    // cached classification, which would trigger needless LLM calls.
    db.insert(stars).values(rows.slice(i, i + CHUNK)).onConflictDoNothing().run();
  }
  return rows.length;
}

/**
 * Star edges that still need an LLM classification, optionally scoped to one author.
 *
 * A row classified under an older taxonomy counts as pending: the category
 * names it holds no longer exist, so keeping it would render a folder that the
 * current taxonomy cannot produce. Doing it here rather than in a migration
 * means the re-classification is lazy and happens inside the normal sync.
 */
export function getUnclassifiedRepos(db: Db, authorId?: number) {
  const notClassified = sql`(
    ${stars.classifiedAt} is null
    or ${stars.taxonomyVersion} is null
    or ${stars.taxonomyVersion} <> ${TAXONOMY_VERSION}
  )`;
  return db
    .select({
      starId: stars.id,
      fullName: repos.fullName,
      description: repos.description,
      language: repos.language,
      topics: repos.topics,
    })
    .from(stars)
    .innerJoin(repos, eq(stars.repoId, repos.id))
    .where(authorId === undefined ? notClassified : and(notClassified, eq(stars.authorId, authorId)))
    .all();
}

export function saveClassifications(
  db: Db,
  entries: Array<{ starId: number; fullName: string }>,
  classifications: Map<string, Classification>,
): number {
  let updated = 0;
  for (const entry of entries) {
    const found = classifications.get(entry.fullName);
    const category = found?.category ?? FALLBACK_CATEGORY;
    const summary = found?.summaryZh ?? null;
    const monetization = found?.monetization ?? FALLBACK_MONETIZATION;
    // A missing score is stored as null rather than 1: "the model never judged
    // it" and "the model judged it worthless" are different, and collapsing
    // them would quietly push unjudged repos to the bottom of the ranking.
    const moneyScore = found?.moneyScore ?? null;

    db.update(stars)
      .set({
        category,
        summaryZh: summary,
        monetization,
        moneyScore,
        classifiedAt: sql`(datetime('now'))`,
        taxonomyVersion: TAXONOMY_VERSION,
      })
      .where(eq(stars.id, entry.starId))
      .run();
    updated += 1;
  }
  return updated;
}

export interface AuthorStarRow {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  starredAt: string;
  category: string | null;
  summaryZh: string | null;
  monetization: string | null;
  moneyScore: number | null;
  /** Null until the LLM answered for this row; drives the "未分类" count. */
  classifiedAt: string | null;
  /** Null or older than TAXONOMY_VERSION means the row is still pending. */
  taxonomyVersion: number | null;
  endorsedBy: number;
}

/**
 * Load one author's classified stars together with how many tracked authors
 * starred the same repo, which powers the cross-endorsement section.
 */
export function getAuthorStars(db: Db, authorId: number): AuthorStarRow[] {
  const endorseCount = sql<number>`(
    select count(*) from stars s2 where s2.repo_id = ${repos.id}
  )`;

  return db
    .select({
      fullName: repos.fullName,
      description: repos.description,
      language: repos.language,
      stars: repos.stars,
      starredAt: stars.starredAt,
      category: stars.category,
      summaryZh: stars.summaryZh,
      monetization: stars.monetization,
      moneyScore: stars.moneyScore,
      classifiedAt: stars.classifiedAt,
      taxonomyVersion: stars.taxonomyVersion,
      endorsedBy: endorseCount,
    })
    .from(stars)
    .innerJoin(repos, eq(stars.repoId, repos.id))
    .where(eq(stars.authorId, authorId))
    .orderBy(desc(repos.stars))
    .all();
}

export function listTrackedLogins(db: Db): string[] {
  return db.select({ login: authors.login }).from(authors).all().map((r) => r.login);
}

export function listAuthors(db: Db) {
  return db.select().from(authors).orderBy(desc(authors.followers)).all();
}

export function countStarsForAuthor(db: Db, authorId: number): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(stars)
    .where(eq(stars.authorId, authorId))
    .get();
  return row?.count ?? 0;
}

export interface RepoEndorsement {
  login: string;
  name: string | null;
  isSelf: boolean;
  starredAt: string;
  category: string | null;
}

export interface RepoEndorsements {
  fullName: string;
  description: string | null;
  stars: number;
  language: string | null;
  /** Tracked authors who starred this repo, so the UI can say who endorses it. */
  endorsements: RepoEndorsement[];
}

/**
 * Answers "do the people I follow also star this repo", which powers the
 * in-page badge on a GitHub repository page. Matching is case-insensitive
 * because GitHub treats owner/repo names that way.
 */
export function getRepoEndorsements(db: Db, fullName: string): RepoEndorsements | undefined {
  const repo = db
    .select()
    .from(repos)
    .where(sql`lower(${repos.fullName}) = lower(${fullName})`)
    .get();
  if (!repo) return undefined;

  const rows = db
    .select({
      login: authors.login,
      name: authors.name,
      isSelf: authors.isSelf,
      starredAt: stars.starredAt,
      category: stars.category,
    })
    .from(stars)
    .innerJoin(authors, eq(stars.authorId, authors.id))
    .where(eq(stars.repoId, repo.id))
    .orderBy(desc(authors.followers))
    .all();

  return {
    fullName: repo.fullName,
    description: repo.description,
    stars: repo.stars,
    language: repo.language,
    endorsements: rows,
  };
}

export interface SyncStateRecord {
  lastStarredAt: string | null;
  fullSyncCompletedAt: string | null;
  status: string;
}

export function getSyncState(db: Db, authorId: number): SyncStateRecord | undefined {
  const row = db.select().from(syncState).where(eq(syncState.authorId, authorId)).get();
  if (!row) return undefined;
  return {
    lastStarredAt: row.lastStarredAt,
    fullSyncCompletedAt: row.fullSyncCompletedAt,
    status: row.status,
  };
}

export function updateSyncState(
  db: Db,
  authorId: number,
  patch: {
    lastStarredAt?: string | null;
    lastCursor?: string | null;
    fullSyncCompletedAt?: string | null;
    status?: string;
    error?: string | null;
  },
): void {
  const values = {
    authorId,
    lastRunAt: sql`(datetime('now'))`,
    ...patch,
  };

  db.insert(syncState)
    .values(values)
    .onConflictDoUpdate({
      target: syncState.authorId,
      set: { ...patch, lastRunAt: sql`(datetime('now'))` },
    })
    .run();
}

export interface WikiNodeRecord {
  spaceId: string;
  nodeToken: string;
  documentId: string | null;
  contentHash: string | null;
  /** Where the node was last placed; NULL for rows predating the column. */
  parentNodeToken: string | null;
  title: string | null;
}

/**
 * Look a document up by its full identity, `(docKey, spaceId)`.
 *
 * The space has to be part of the lookup because a node token is only valid
 * inside the space that issued it. Querying by `docKey` alone is what once let
 * a `--local` dry run's file path be reused as a Feishu node token. `docKey`
 * itself is not scoped per author: the index page is shared by every author,
 * and per-author keys already embed the login, so `authorId` is attribution.
 */
export function getWikiNode(db: Db, docKey: string, spaceId: string): WikiNodeRecord | undefined {
  const row = db
    .select()
    .from(wikiNodes)
    .where(and(eq(wikiNodes.docKey, docKey), eq(wikiNodes.spaceId, spaceId)))
    .get();
  if (!row) return undefined;
  return {
    spaceId: row.spaceId,
    nodeToken: row.nodeToken,
    documentId: row.documentId,
    contentHash: row.contentHash,
    parentNodeToken: row.parentNodeToken,
    title: row.title,
  };
}

export function saveWikiNode(
  db: Db,
  docKey: string,
  node: {
    /** Omitted for shared documents such as the knowledge base index page. */
    authorId?: number | null;
    spaceId: string;
    nodeToken: string;
    documentId?: string | null;
    contentHash?: string | null;
    /**
     * Where the node sits.
     *
     * Omitting it leaves the remembered placement untouched rather than
     * clearing it: callers that only refresh a document body have no opinion
     * about the tree, and resetting the parent to NULL would make the next run
     * believe the node had drifted and move it again.
     */
    parentNodeToken?: string | null;
    title?: string | null;
  },
): void {
  const values = {
    authorId: node.authorId ?? null,
    docKey,
    spaceId: node.spaceId,
    nodeToken: node.nodeToken,
    documentId: node.documentId ?? null,
    contentHash: node.contentHash ?? null,
    parentNodeToken: node.parentNodeToken ?? null,
    title: node.title ?? null,
  };

  db.insert(wikiNodes)
    .values(values)
    .onConflictDoUpdate({
      target: [wikiNodes.docKey, wikiNodes.spaceId],
      set: {
        spaceId: values.spaceId,
        nodeToken: values.nodeToken,
        documentId: values.documentId,
        contentHash: values.contentHash,
        title: values.title,
        updatedAt: sql`(datetime('now'))`,
        // Fields the caller did not mention keep their stored value: a
        // placement-only update must not blank out the author attribution.
        ...(node.authorId === undefined ? {} : { authorId: values.authorId }),
        ...(node.parentNodeToken === undefined
          ? {}
          : { parentNodeToken: values.parentNodeToken }),
      },
    })
    .run();
}

/** Every node we manage in a space, used to render the knowledge base index. */
export function listWikiNodes(db: Db, spaceId: string): WikiNodeRecord[] {
  return db
    .select()
    .from(wikiNodes)
    .where(eq(wikiNodes.spaceId, spaceId))
    .all()
    .map((row) => ({
      spaceId: row.spaceId,
      nodeToken: row.nodeToken,
      documentId: row.documentId,
      contentHash: row.contentHash,
      parentNodeToken: row.parentNodeToken,
      title: row.title,
    }));
}

export { normalizeCategory };
export type { Category };

export interface SubscriptionRecord {
  id: number;
  login: string;
  alias: string | null;
  isSelf: boolean;
  enabled: boolean;
}

/**
 * Logins are stored in their original casing but compared case-insensitively:
 * GitHub treats them as case-insensitive, so `Torvalds` and `torvalds` must not
 * become two subscriptions racing on the same wiki node.
 */
export function listSubscriptions(db: Db): SubscriptionRecord[] {
  return db
    .select()
    .from(subscriptions)
    .orderBy(subscriptions.createdAt, subscriptions.id)
    .all()
    .map(toSubscriptionRecord);
}

export function getSubscription(db: Db, login: string): SubscriptionRecord | undefined {
  const row = db
    .select()
    .from(subscriptions)
    .where(sql`lower(${subscriptions.login}) = lower(${login})`)
    .get();
  return row ? toSubscriptionRecord(row) : undefined;
}

function toSubscriptionRecord(row: typeof subscriptions.$inferSelect): SubscriptionRecord {
  return {
    id: row.id,
    login: row.login,
    alias: row.alias,
    isSelf: row.isSelf,
    enabled: row.enabled,
  };
}

/** Insert or update a subscription, keyed case-insensitively on the login. */
export function upsertSubscription(
  db: Db,
  input: { login: string; alias?: string | null; isSelf?: boolean; enabled?: boolean },
): SubscriptionRecord {
  const patch = {
    alias: input.alias ?? null,
    isSelf: input.isSelf ?? false,
    enabled: input.enabled ?? true,
  };

  // SQLite's unique index compares text case-sensitively, so relying on
  // `onConflict` alone would let `Torvalds` and `torvalds` coexist and then
  // race on the same wiki node. Resolve the existing row case-insensitively
  // first and update it in place, which also preserves the original casing.
  const existing = db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(sql`lower(${subscriptions.login}) = lower(${input.login})`)
    .get();

  if (existing) {
    db.update(subscriptions)
      .set({ ...patch, updatedAt: sql`(datetime('now'))` })
      .where(eq(subscriptions.id, existing.id))
      .run();
  } else {
    db.insert(subscriptions).values({ login: input.login, ...patch }).run();
  }

  const saved = getSubscription(db, input.login);
  if (!saved) throw new Error(`写入订阅后读回失败：${input.login}`);
  return saved;
}

/** Returns the number of removed rows, so callers can report a missing login. */
export function deleteSubscription(db: Db, login: string): number {
  const result = db
    .delete(subscriptions)
    .where(sql`lower(${subscriptions.login}) = lower(${login})`)
    .run();
  return result.changes;
}

export function getSetting(db: Db, key: string): string | undefined {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings)
    .values({ key, value })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: sql`(datetime('now'))` },
    })
    .run();
}

export interface SyncRunRecord {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  totalAuthors: number;
  failedAuthors: number;
  newStars: number;
  authors: SyncRunAuthor[];
  error: string | null;
}

/** Opens a run row so the status panel can show work in progress. */
export function startSyncRun(
  db: Db,
  input: { trigger: string; totalAuthors: number },
): number {
  const row = db
    .insert(syncRuns)
    .values({ trigger: input.trigger, totalAuthors: input.totalAuthors, status: "running" })
    .returning({ id: syncRuns.id })
    .get();
  return row.id;
}

export function finishSyncRun(
  db: Db,
  id: number,
  patch: {
    status: string;
    newStars?: number;
    failedAuthors?: number;
    authors?: SyncRunAuthor[];
    error?: string | null;
  },
): void {
  db.update(syncRuns)
    .set({
      status: patch.status,
      newStars: patch.newStars ?? 0,
      failedAuthors: patch.failedAuthors ?? 0,
      detail: patch.authors ?? [],
      error: patch.error ?? null,
      finishedAt: sql`(datetime('now'))`,
    })
    .where(eq(syncRuns.id, id))
    .run();
}

/** Most recent runs first, for the extension's status panel. */
export function listSyncRuns(db: Db, limit = 20): SyncRunRecord[] {
  return db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.id))
    .limit(limit)
    .all()
    .map((row) => ({
      id: row.id,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      status: row.status,
      trigger: row.trigger,
      totalAuthors: row.totalAuthors,
      failedAuthors: row.failedAuthors,
      newStars: row.newStars,
      authors: row.detail ?? [],
      error: row.error,
    }));
}
