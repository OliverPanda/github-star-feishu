import type { Db } from "./db/client.js";
import {
  getAuthorByLogin,
  getAuthorStars,
  getAuthorSyncSummary,
  getSubscription,
  type AuthorStarRow,
} from "./store.js";
import {
  CATEGORIES,
  TAXONOMY_VERSION,
  normalizeCategory,
  normalizeMonetization,
  type Category,
} from "./taxonomy.js";

/** One repo as the library view shows it; mirrors the Markdown renderer. */
export interface LibraryRepo {
  fullName: string;
  url: string;
  description: string | null;
  summaryZh: string | null;
  language: string | null;
  stars: number;
  starredAt: string;
  category: Category;
  monetization: string;
  moneyScore: number | null;
  endorsedBy: number;
}

export interface LibraryCategory {
  name: Category;
  count: number;
  /** Mean moneyScore of the scored rows, one decimal; null when none scored. */
  averageMoneyScore: string | null;
  repos: LibraryRepo[];
}

export interface AuthorLibrary {
  login: string;
  name: string | null;
  alias: string | null;
  isSelf: boolean;
  followers: number;
  starredCount: number;
  syncedRepos: number;
  lastSyncedAt: string | null;
  /** Newest starredAt in the library, shown as "数据更新至". */
  dataUpdatedAt: string | null;
  categories: LibraryCategory[];
  /** Rows with no current classification; they still appear under 其他. */
  unclassified: number;
  /** Headline ranking: moneyScore >= 4, best first. */
  topPicks: LibraryRepo[];
  /** Repos starred by several tracked authors, the strongest recommendation. */
  shared: LibraryRepo[];
}

/** A repo is worth a headline slot from this score up, matching the wiki. */
const TOP_MONEY_MIN_SCORE = 4;
const TOP_MONEY_ROWS = 15;
const SHARED_ROWS = 10;

/**
 * Rows written by an older taxonomy are pending re-classification, so they are
 * counted as unclassified here exactly like `getUnclassifiedRepos` does. The
 * category they carry is still shown, because hiding the repo would make the
 * list look emptier than the database is.
 */
function isPending(row: AuthorStarRow): boolean {
  return (
    row.classifiedAt === null ||
    row.taxonomyVersion === null ||
    row.taxonomyVersion !== TAXONOMY_VERSION
  );
}

function toLibraryRepo(row: AuthorStarRow): LibraryRepo {
  return {
    fullName: row.fullName,
    url: `https://github.com/${row.fullName}`,
    description: row.description,
    summaryZh: row.summaryZh,
    language: row.language,
    stars: row.stars,
    starredAt: row.starredAt,
    category: normalizeCategory(row.category),
    monetization: normalizeMonetization(row.monetization),
    moneyScore: row.moneyScore,
    endorsedBy: row.endorsedBy,
  };
}

/**
 * Everything the extension's "作者库" page renders, grouped the same way the
 * Feishu document groups it so the two views cannot drift apart.
 *
 * Returns undefined for an unknown login, which the route turns into a 404
 * rather than an empty library that looks like "this author starred nothing".
 */
export function buildAuthorLibrary(db: Db, login: string): AuthorLibrary | undefined {
  const author = getAuthorByLogin(db, login);
  if (!author) return undefined;

  const rows = getAuthorStars(db, author.id);
  const repos = rows.map(toLibraryRepo);
  const subscription = getSubscription(db, login);
  const summary = getAuthorSyncSummary(db, login);

  const grouped = new Map<Category, LibraryRepo[]>();
  for (const repo of repos) {
    const list = grouped.get(repo.category) ?? [];
    list.push(repo);
    grouped.set(repo.category, list);
  }

  const categories: LibraryCategory[] = [];
  for (const name of CATEGORIES) {
    const list = grouped.get(name);
    if (!list?.length) continue;

    // Same sort as the Markdown renderer: popularity first, then the most
    // recent star, so both views list a category in one consistent order.
    list.sort((a, b) => b.stars - a.stars || b.starredAt.localeCompare(a.starredAt));

    const scored = list
      .map((repo) => repo.moneyScore)
      .filter((score): score is number => typeof score === "number");
    const average = scored.length
      ? (scored.reduce((sum, score) => sum + score, 0) / scored.length).toFixed(1)
      : null;

    categories.push({ name, count: list.length, averageMoneyScore: average, repos: list });
  }

  const topPicks = repos
    .filter((repo) => (repo.moneyScore ?? 0) >= TOP_MONEY_MIN_SCORE)
    .sort(
      (a, b) =>
        (b.moneyScore ?? 0) - (a.moneyScore ?? 0) ||
        b.endorsedBy - a.endorsedBy ||
        b.stars - a.stars,
    )
    .slice(0, TOP_MONEY_ROWS);

  const shared = repos
    .filter((repo) => repo.endorsedBy >= 2)
    .sort((a, b) => b.endorsedBy - a.endorsedBy || b.stars - a.stars)
    .slice(0, SHARED_ROWS);

  return {
    login: author.login,
    name: author.name,
    alias: subscription?.alias ?? null,
    isSelf: author.isSelf,
    followers: author.followers,
    starredCount: author.starredCount,
    syncedRepos: summary?.syncedRepos ?? repos.length,
    lastSyncedAt: summary?.lastSyncedAt ?? null,
    dataUpdatedAt: repos.reduce<string | null>(
      (latest, repo) => (latest === null || repo.starredAt > latest ? repo.starredAt : latest),
      null,
    ),
    categories,
    unclassified: rows.filter(isPending).length,
    topPicks,
    shared,
  };
}
