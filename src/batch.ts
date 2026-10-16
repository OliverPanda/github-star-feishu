import type { LanguageModel } from "ai";
import type { Octokit } from "octokit";
import pRetry from "p-retry";
import type { Db } from "./db/client.js";
import type { WikiWriter } from "./feishu/types.js";
import { GitHubStarsUnavailableError, GitHubUserNotFoundError } from "./github/stars.js";
import {
  INDEX_DOC_KEY,
  TRENDING_DOC_KEY,
  documentKey,
  ensureSection,
  publishDocument,
} from "./publish.js";
import { renderIndex, type IndexAuthor } from "./render/markdown.js";
import {
  getAuthorByLogin,
  getAuthorSyncSummary,
  getWikiNode,
  listTrackedLogins,
} from "./store.js";
import type { Subscription } from "./subscriptions.js";
import { syncAuthor } from "./sync.js";
import { buildTrendingBoard, saveTrendingSnapshot, type TrendingSince } from "./trending-board.js";
import {
  COMMERCIAL_DOC_KEY,
  COMMERCIAL_TITLE,
  renderCommercialBoard,
  summarizeCommercialBoard,
} from "./commercial-board.js";

export interface BatchOptions {
  db: Db;
  github: Octokit;
  writer: WikiWriter;
  spaceId: string;
  authors: Subscription[];
  model?: LanguageModel | undefined;
  /** Parent of every author subtree; falls back to the space root. */
  parentNodeToken?: string | undefined;
  /** Root node for the landing page, when it should not sit at the space root. */
  indexParentNodeToken?: string | undefined;
  full?: boolean;
  skipClassify?: boolean;
  /** Rewrite every document even when its content hash is unchanged. */
  force?: boolean;
  /**
   * Publish the GitHub trending board alongside the authors.
   *
   * On by default because it is the one page that is useful before the reader
   * has subscribed to anyone; an offline or CI run can still switch it off.
   */
  trending?: boolean;
  /** Trending window; the board's numbers are meaningless without it. */
  trendingSince?: TrendingSince;
  /**
   * Fetch implementation used to scrape the trending page.
   *
   * Injected so tests can serve a saved page instead of reaching github.com,
   * and so an offline run can supply a stub.
   */
  trendingFetch?: typeof fetch;
  /** Retries per author, on top of the first attempt. */
  retries?: number;
  log?: (message: string) => void;
  now?: Date;
}

export interface AuthorOutcome {
  login: string;
  displayName: string | null;
  isSelf: boolean;
  newStars: number;
  totalStars: number;
  /** True when the document was already up to date and nothing was written. */
  unchanged: boolean;
  sectionToken: string | null;
  nodeToken: string | null;
  /** Populated when this author failed; the batch still continues. */
  error: string | null;
}

export interface BatchResult {
  spaceId: string;
  outcomes: AuthorOutcome[];
  indexNodeToken: string | null;
  indexUnchanged: boolean;
  /** Rendered landing page, so callers can export it without re-rendering. */
  indexMarkdown: string;
  /** Trending board node, or null when it was skipped or failed. */
  trendingNodeToken: string | null;
  trendingUnchanged: boolean;
  /** Trending repositories published in this run; 0 when the board was empty. */
  trendingCount: number;
  /** Populated when the board could not be published; the run still succeeds. */
  trendingError: string | null;
  /** Money board node, or null when it was skipped or failed. */
  commercialNodeToken: string | null;
  commercialUnchanged: boolean;
  /** Short digest of the money board, pushed to Feishu with the run summary. */
  commercialSummary: string;
  /** Populated when the money board could not be published. */
  commercialError: string | null;
  newStars: number;
  failed: number;
}

/**
 * Sync every subscribed author into the knowledge base.
 *
 * Authors are processed one at a time rather than in parallel: the LLM step
 * already saturates its own concurrency, and sequential writes keep each
 * author's node creation ordered and easy to follow in the logs.
 *
 * A failure is recorded against the author and never aborts the run — one
 * renamed or private account must not stop everyone else's daily update.
 */
export async function runBatch(options: BatchOptions): Promise<BatchResult> {
  const {
    db,
    github,
    writer,
    spaceId,
    authors,
    model,
    parentNodeToken,
    indexParentNodeToken,
    full = false,
    skipClassify = false,
    force = false,
    trending = true,
    trendingSince = "daily",
    trendingFetch,
    retries = 2,
    log = () => {},
    now = new Date(),
  } = options;

  const outcomes: AuthorOutcome[] = [];
  log(`\n本批共 ${authors.length} 个作者，开始逐个同步\n`);

  for (const [position0, author] of authors.entries()) {
    const position = `[${position0 + 1}/${authors.length}]`;
    log(`${position} ${author.login}`);
    const outcome = await syncOne();
    outcomes.push(outcome);
    log(
      outcome.error
        ? `      ${position} ${author.login} 失败：${outcome.error}`
        : `      ${position} ${author.login} 完成：新增 ${outcome.newStars}，累计 ${outcome.totalStars}\n`,
    );

    async function syncOne(): Promise<AuthorOutcome> {
      const base: AuthorOutcome = {
        login: author.login,
        displayName: author.alias ?? null,
        isSelf: author.self,
        newStars: 0,
        totalStars: 0,
        unchanged: false,
        sectionToken: null,
        nodeToken: null,
        error: null,
      };

      try {
        const synced = await pRetry(
          () =>
            syncAuthor({
              db,
              github,
              model,
              login: author.login,
              full,
              skipClassify: skipClassify || !model,
              isSelf: author.self,
              log,
              now,
            }),
          {
            retries,
            minTimeout: 2_000,
            factor: 2,
            onFailedAttempt: ({ error, retriesLeft }) => {
              log(`      同步失败（剩 ${retriesLeft} 次重试）：${describe(error)}`);
            },
          },
        );

        const section = await ensureSection({
          db,
          writer,
          login: author.login,
          title: sectionTitle(author),
          spaceId,
          parentNodeToken,
          log,
        });

        const published = await publishDocument({
          db,
          writer,
          authorId: synced.author.id,
          login: synced.author.login,
          spaceId,
          title: documentTitle(synced.author.login, synced.author.name, synced.author.isSelf),
          markdown: synced.markdown,
          parentNodeToken: section.nodeToken,
          force,
          log,
        });

        return {
          ...base,
          displayName: synced.author.name,
          isSelf: synced.author.isSelf,
          newStars: synced.newStars,
          totalStars: synced.totalStars,
          unchanged: published.skipped,
          sectionToken: section.nodeToken,
          nodeToken: published.nodeToken,
        };
      } catch (error) {
        return { ...base, error: describe(error) };
      }
    }
  }

  const newStars = outcomes.reduce((sum, outcome) => sum + outcome.newStars, 0);
  const index = await publishIndex();
  const board = trending ? await publishTrending() : emptyBoard();
  // The standalone boards are enabled for normal daily runs. Keep the
  // explicit no-trending/test mode lightweight and preserve the empty-batch
  // behavior used by dry runs.
  const money = trending && authors.length > 0 ? await publishCommercialBoard() : emptyMoney();

  return {
    spaceId,
    outcomes,
    indexNodeToken: index.nodeToken,
    indexUnchanged: index.skipped,
    indexMarkdown: index.markdown,
    trendingNodeToken: board.nodeToken,
    trendingUnchanged: board.skipped,
    trendingCount: board.count,
    trendingError: board.error,
    commercialNodeToken: money.nodeToken,
    commercialUnchanged: money.skipped,
    commercialSummary: money.summary,
    commercialError: money.error,
    newStars,
    failed: outcomes.filter((outcome) => outcome.error).length,
  };

  function emptyBoard() {
    return { nodeToken: null, skipped: false, count: 0, error: null };
  }

  function emptyMoney() {
    return { nodeToken: null, skipped: false, summary: "", error: null };
  }

  /**
   * Publish the trending board, isolating every failure of its own.
   *
   * It is the only step that scrapes a web page rather than calling an API, so
   * it is the most likely thing in the run to break. Catching here keeps a
   * layout change on github.com from failing a sync whose real work — the
   * authors — already succeeded.
   */
  async function publishTrending() {
    try {
      const board = await buildTrendingBoard({
        model: skipClassify ? undefined : model,
        since: trendingSince,
        now,
        log,
        ...(trendingFetch ? { fetchImpl: trendingFetch } : {}),
      });

      // Cached before publishing: the extension reads this copy, and it should
      // reflect what was scraped even if the wiki write below then fails.
      saveTrendingSnapshot(db, {
        generatedAt: now.toISOString(),
        since: trendingSince,
        repos: board.repos,
        rows: board.rows,
      });

      const published = await publishDocument({
        db,
        writer,
        login: TRENDING_DOC_KEY,
        docKey: TRENDING_DOC_KEY,
        spaceId,
        title: "GitHub 上涨趋势榜",
        markdown: board.markdown,
        parentNodeToken: indexParentNodeToken,
        force,
        log,
      });

      log(
        `\n趋势榜：${board.repos.length} 个仓库，` +
          (published.skipped ? "内容未变化，已跳过" : `已更新 ${published.nodeToken}`),
      );
      return { nodeToken: published.nodeToken, skipped: published.skipped, count: board.repos.length, error: null };
    } catch (error) {
      const detail = describe(error);
      log(`\n趋势榜发布失败（不影响 Star 同步）：${detail}`);
      return { nodeToken: null, skipped: false, count: 0, error: detail };
    }
  }

  /**
   * Publish the curated money board and return its digest for the Feishu push.
   *
   * Failure is isolated like the trending board's: the board is a bonus page,
   * and a wiki hiccup while writing it must not invalidate the author syncs
   * that already succeeded.
   */
  async function publishCommercialBoard(): Promise<{
    nodeToken: string | null;
    skipped: boolean;
    summary: string;
    error: string | null;
  }> {
    const summary = summarizeCommercialBoard(now);
    try {
      const published = await publishDocument({
        db,
        writer,
        login: COMMERCIAL_DOC_KEY,
        docKey: COMMERCIAL_DOC_KEY,
        spaceId,
        title: COMMERCIAL_TITLE,
        markdown: renderCommercialBoard(now, model),
        parentNodeToken: indexParentNodeToken,
        force,
        log,
      });
      log(
        `\n搞钱项目精选：${published.skipped ? "内容未变化，已跳过" : `已更新 ${published.nodeToken}`}`,
      );
      return {
        nodeToken: published.nodeToken,
        skipped: published.skipped,
        summary,
        error: null,
      };
    } catch (error) {
      const detail = describe(error);
      log(`\n搞钱项目精选发布失败（不影响 Star 同步）：${detail}`);
      // The digest still goes out: the curated list is generated locally, so
      // the reader gets today's picks even when the wiki write failed.
      return { nodeToken: null, skipped: false, summary, error: detail };
    }
  }

  async function publishIndex() {
    const indexAuthors = collectIndexAuthors();
    const markdown = renderIndex(indexAuthors, { generatedAt: now });
    const published = await publishDocument({
      db,
      writer,
      login: INDEX_DOC_KEY,
      docKey: INDEX_DOC_KEY,
      spaceId,
      title: "GitHub Star 知识库",
      markdown,
      parentNodeToken: indexParentNodeToken,
      force,
      log,
    });
    log(`\n索引页：${published.skipped ? "内容未变化，已跳过" : `已更新 ${published.nodeToken}`}`);
    return { ...published, markdown };
  }

  /**
   * Everyone the knowledge base knows about, not just the accounts this run
   * touched.
   *
   * A run can be scoped to a single login (the extension's "一键整理" button
   * for a recommended author), and building the page from this batch alone
   * would drop every other author out of the index.
   *
   * Counts come from the database rather than from this run's totals so that a
   * re-run which changes nothing renders byte-identical Markdown and therefore
   * skips the write.
   */
  function collectIndexAuthors(): IndexAuthor[] {
    const outcomeByLogin = new Map(
      outcomes.map((outcome) => [outcome.login.toLowerCase(), outcome]),
    );
    const seen = new Set<string>();
    const indexAuthors: IndexAuthor[] = [];

    for (const tracked of listTrackedLogins(db)) {
      const login = tracked.toLowerCase();
      seen.add(login);
      const author = getAuthorByLogin(db, tracked);
      const outcome = outcomeByLogin.get(login);
      indexAuthors.push({
        login: author?.login ?? tracked,
        displayName: outcome?.displayName ?? author?.name ?? null,
        repoCount: getAuthorSyncSummary(db, tracked)?.syncedRepos ?? 0,
        isSelf: author?.isSelf ?? outcome?.isSelf ?? false,
        nodeToken: outcome?.nodeToken ?? getWikiNode(db, documentKey(tracked), spaceId)?.nodeToken,
        error: outcome?.error ?? undefined,
      });
    }

    // An author that failed on its very first sync has no database row yet, so
    // it is appended from this run to keep the failure visible.
    for (const outcome of outcomes) {
      if (seen.has(outcome.login.toLowerCase())) continue;
      indexAuthors.push({
        login: outcome.login,
        displayName: outcome.displayName,
        repoCount: outcome.totalStars,
        isSelf: outcome.isSelf,
        nodeToken: outcome.nodeToken ?? undefined,
        error: outcome.error ?? undefined,
      });
    }

    return indexAuthors;
  }
}

/** Title of the container node that holds one author's document. */
export function sectionTitle(author: Subscription): string {
  return author.alias ? `${author.alias}（${author.login}）` : author.login;
}

function documentTitle(login: string, name: string | null, isSelf: boolean): string {
  if (isSelf) return "我的 Star 精选";
  return name ? `${login} 的 Star 精选（${name}）` : `${login} 的 Star 精选`;
}

function describe(error: unknown): string {
  // These two are the failures a user can actually act on, so they are
  // translated here; anything else keeps its original text to stay debuggable.
  if (error instanceof GitHubUserNotFoundError) {
    return `找不到该 GitHub 账号（${error.message.replace(/^GitHub user not found: /, "")}）`;
  }
  if (error instanceof GitHubStarsUnavailableError) {
    return `该账号未公开 star 列表（${error.message}）`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
