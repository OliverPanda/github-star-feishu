import type { LanguageModel } from "ai";
import type { Db } from "./db/client.js";
import { fetchTrending, type TrendingRepo } from "./github/trending.js";
import { classifyRepos, type Classification } from "./llm/classify.js";
import { renderTrending, type TrendingRow } from "./render/markdown.js";
import { getSetting, setSetting } from "./store.js";
import { FALLBACK_CATEGORY } from "./taxonomy.js";

/**
 * Cached form of the board, persisted after each sync.
 *
 * The extension reads this instead of hitting GitHub on page load: the
 * trending page is scraped HTML rather than an API, and a page view must not
 * depend on that scrape succeeding.
 */
export interface TrendingSnapshot {
  generatedAt: string;
  since: TrendingSince;
  repos: TrendingRepo[];
  rows: TrendingRow[];
}

export type TrendingSince = "daily" | "weekly" | "monthly";

export const TRENDING_CACHE_KEY = "trending_cache";

export interface TrendingBoardResult {
  markdown: string;
  rows: TrendingRow[];
  repos: TrendingRepo[];
  generatedAt: Date;
  /** True when the board could not be built; the document then says so. */
  empty: boolean;
}

export interface TrendingBoardOptions {
  model?: LanguageModel | undefined;
  top?: number;
  since?: TrendingSince;
  now?: Date;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
}

/**
 * Build today's trending board: scrape, classify against the money taxonomy,
 * then render.
 *
 * The raw trending list is the input and the classification only decorates it,
 * so a classifier outage degrades the board to uncategorized rows rather than
 * emptying it. Nothing here throws for the same reason: the board is one page
 * beside the per-author star documents, and it must never be able to fail a
 * daily sync.
 */
export async function buildTrendingBoard(
  options: TrendingBoardOptions = {},
): Promise<TrendingBoardResult> {
  const { model, top = 10, since = "daily", now = new Date(), log = () => {}, fetchImpl } = options;

  const repos = await fetchTrending({ top, since, log, ...(fetchImpl ? { fetchImpl } : {}) });
  log(`      趋势榜：抓到 ${repos.length} 个仓库`);

  let classified = new Map<string, Classification>();
  if (repos.length && model) {
    try {
      classified = await classifyRepos(
        repos.map((repo) => ({
          fullName: repo.fullName,
          description: repo.description,
          language: repo.language,
          // The trending card carries no topics, and the prompt treats them as
          // optional context, so an empty list is passed rather than skipped.
          topics: [],
        })),
        { model },
      );
      log(`      趋势榜：完成分类 ${classified.size}/${repos.length}`);
    } catch (error) {
      // classifyRepos absorbs per-batch failures, so reaching here means
      // something structural; the board is still worth publishing unclassified.
      const detail = error instanceof Error ? error.message : String(error);
      log(`      趋势榜分类失败，将以未分类形式发布：${detail}`);
    }
  }

  const rows: TrendingRow[] = repos.map((repo) => {
    const hit = classified.get(repo.fullName);
    return {
      fullName: repo.fullName,
      url: repo.url,
      starsToday: repo.starsToday,
      stars: repo.stars,
      language: repo.language,
      description: repo.description,
      category: hit?.category ?? FALLBACK_CATEGORY,
      summaryZh: hit?.summaryZh ?? null,
      monetization: hit?.monetization ?? null,
      moneyScore: hit?.moneyScore ?? null,
    };
  });

  const rendered = renderTrending(rows, { generatedAt: now, since });
  return {
    markdown: rendered.markdown,
    rows,
    repos,
    generatedAt: now,
    empty: !repos.length,
  };
}

/** Persist the board so the API can serve it without re-scraping GitHub. */
export function saveTrendingSnapshot(db: Db, snapshot: TrendingSnapshot): void {
  setSetting(db, TRENDING_CACHE_KEY, JSON.stringify(snapshot));
}

/**
 * Read the cached board back.
 *
 * A cache written by an older build may not match the current shape, and a
 * malformed cache must not break the endpoint, so a parse failure is reported
 * as "no data yet" instead of propagating.
 */
export function readTrendingSnapshot(db: Db): TrendingSnapshot | null {
  const raw = getSetting(db, TRENDING_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<TrendingSnapshot>;
    if (!Array.isArray(parsed.rows) || !parsed.generatedAt) return null;
    return {
      generatedAt: parsed.generatedAt,
      since: parsed.since ?? "daily",
      repos: Array.isArray(parsed.repos) ? parsed.repos : [],
      rows: parsed.rows,
    };
  } catch {
    return null;
  }
}
