import { eq, sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import { authors, stars } from "./db/schema.js";
import { findRosterEntry, ROSTER } from "./roster.js";
import { getAuthorSyncSummary } from "./store.js";
import type { Category } from "./taxonomy.js";
import { normalizeCategory } from "./taxonomy.js";

/** One card in the extension's recommendation list. */
export interface RosterView {
  login: string;
  name: string;
  tag: string;
  blurb: string;
  /** Live follower count when synced, otherwise the snapshot from the roster. */
  followers: number;
  /** Live count when the snapshot is only an approximation. */
  followersLive: boolean;
  /** True once the account has been stored, so the UI can offer "查看". */
  tracked: boolean;
  syncedRepos: number;
  lastSyncedAt: string | null;
  /** Tracks this account's stars fall into, best first; empty before a sync. */
  topCategories: Array<{ name: Category; count: number }>;
}

const TOP_CATEGORY_ROWS = 3;

/**
 * The curated roster plus whatever the database already knows about each
 * account.
 *
 * `isKnown` distinguishes "synced at some point" from "never fetched", because
 * a stored author with zero repos would otherwise look identical to one that
 * has not been synced yet, and the UI would hide its "一键整理" button.
 */
export function buildRosterView(db: Db, isKnown: (login: string) => boolean): RosterView[] {
  return ROSTER.map((entry) => {
    const summary = getAuthorSyncSummary(db, entry.login);
    const categories = summary ? categoryCounts(db, entry.login) : [];
    return {
      login: entry.login,
      name: entry.name,
      tag: entry.tag,
      blurb: entry.blurb,
      followers: summary?.followers ?? entry.knownFollowers,
      followersLive: Boolean(summary),
      tracked: isKnown(entry.login),
      syncedRepos: summary?.syncedRepos ?? 0,
      lastSyncedAt: summary?.lastSyncedAt ?? null,
      topCategories: categories.slice(0, TOP_CATEGORY_ROWS),
    };
  });
}

/**
 * How many of an author's stored repos sit in each money track.
 *
 * Counted in SQL rather than by loading the rows: the roster renders every
 * entry at once, and pulling thousands of repos per card just to count them
 * would make the page's payload grow with the size of the library.
 */
function categoryCounts(db: Db, login: string): Array<{ name: Category; count: number }> {
  const rows = db
    .select({ category: stars.category, count: sql<number>`count(*)` })
    .from(stars)
    .innerJoin(authors, eq(stars.authorId, authors.id))
    .where(eq(authors.login, login))
    .groupBy(stars.category)
    .all();

  const merged = new Map<Category, number>();
  for (const row of rows) {
    const name = normalizeCategory(row.category);
    merged.set(name, (merged.get(name) ?? 0) + row.count);
  }

  return [...merged.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export { findRosterEntry };
