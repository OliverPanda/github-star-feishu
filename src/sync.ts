import type { Octokit } from "octokit";
import type { Db } from "./db/client.js";
import { fetchStarredRepos } from "./github/stars.js";
import { classifyRepos } from "./llm/classify.js";
import { renderMarkdown, type RenderedRepo, type RenderResult } from "./render/markdown.js";
import {
  findAuthorIdByLogin,
  getAuthorStars,
  getSyncState,
  getUnclassifiedRepos,
  listTrackedLogins,
  saveClassifications,
  updateSyncState,
  upsertAuthor,
  upsertRepos,
  upsertStars,
  type AuthorRecord,
} from "./store.js";
import { normalizeCategory, type Category } from "./taxonomy.js";
import type { LanguageModel } from "ai";

export interface SyncOptions {
  db: Db;
  github: Octokit;
  model?: LanguageModel | undefined;
  login: string;
  /** Ignore the stored watermark and re-walk the whole star list. */
  full?: boolean;
  /** Skip the LLM step; unclassified repos render under the fallback category. */
  skipClassify?: boolean;
  isSelf?: boolean;
  log?: (message: string) => void;
  now?: Date;
}

export interface SyncResult {
  author: AuthorRecord;
  newStars: number;
  totalStars: number;
  classified: number;
  pagesFetched: number;
  incremental: boolean;
  render: RenderResult;
  markdown: string;
  counts: Record<string, number>;
}

/**
 * Pull an author's stars into the database and produce the rendered Markdown.
 *
 * This is the whole pipeline minus the Feishu write, which is deliberately
 * kept separate so it can be dry-run and reversed without touching the DB.
 */
export async function syncAuthor(options: SyncOptions): Promise<SyncResult> {
  const {
    db,
    github,
    model,
    login,
    full = false,
    skipClassify = false,
    isSelf = false,
    log = () => {},
    now = new Date(),
  } = options;

  log(`[1/4] 拉取 ${login} 的 star 列表...`);

  // Only trust the watermark once a full walk has completed, otherwise an
  // interrupted first run would permanently skip everything older than the
  // newest page.
  const priorAuthor = findAuthorIdByLogin(db, login);
  const priorState = priorAuthor ? getSyncState(db, priorAuthor) : undefined;
  const canUseWatermark =
    !full && Boolean(priorState?.fullSyncCompletedAt) && Boolean(priorState?.lastStarredAt);
  const since = canUseWatermark ? (priorState?.lastStarredAt ?? undefined) : undefined;

  const page = await fetchStarredRepos(github, login, {
    since,
    onProgress: ({ fetched, total }) => log(`      已获取 ${fetched}/${total}`),
  });

  const isIncremental = since !== undefined;
  log(
    isIncremental
      ? `      增量模式：发现 ${page.edges.length} 个新 star`
      : `      全量模式：获取 ${page.edges.length} 个 star`,
  );

  const author = upsertAuthor(db, page.profile, isSelf);
  const repoIds = upsertRepos(db, page.edges);
  upsertStars(db, author.id, page.edges, repoIds);

  log(`[2/4] 分类与摘要...`);
  let classified = 0;
  if (!skipClassify && model) {
    const pending = getUnclassifiedRepos(db, author.id);
    if (pending.length) {
      const results = await classifyRepos(
        pending.map((p) => ({
          fullName: p.fullName,
          description: p.description,
          language: p.language,
          topics: p.topics ?? [],
        })),
        {
          model,
          onProgress: ({ done, total }) => log(`      已分类 ${done}/${total}`),
        },
      );
      classified = saveClassifications(db, pending, results);
    } else {
      log("      无新增仓库需要分类（命中缓存）");
    }
  } else if (skipClassify) {
    log("      已跳过（--no-classify）");
  } else {
    log("      已跳过（未配置 LLM）");
  }

  // The watermark only advances after a successful full walk, so a crash
  // mid-run cannot silently lose stars.
  const newest = page.edges[0]?.starredAt;
  updateSyncState(db, author.id, {
    lastStarredAt: newest ?? priorState?.lastStarredAt ?? null,
    fullSyncCompletedAt: sqlNow(),
    status: "ok",
    error: null,
  });

  log(`[3/4] 渲染 Markdown...`);
  const rows = getAuthorStars(db, author.id);
  const rendered: RenderedRepo[] = rows.map((row) => ({
    fullName: row.fullName,
    url: `https://github.com/${row.fullName}`,
    description: row.description,
    language: row.language,
    stars: row.stars,
    starredAt: row.starredAt,
    category: normalizeCategory(row.category) as Category,
    monetization: row.monetization,
    moneyScore: row.moneyScore,
    summaryZh: row.summaryZh,
    endorsedBy: row.endorsedBy,
  }));

  const trackedLogins = listTrackedLogins(db);
  // Newest star date drives the "data updated to" line; it only moves when the
  // star list actually changes, which keeps the rendered doc stable across runs.
  const dataUpdatedAt = rows.reduce<string | null>(
    (latest, row) => (latest === null || row.starredAt > latest ? row.starredAt : latest),
    null,
  );
  const render = renderMarkdown(rendered, {
    login: author.login,
    displayName: author.name,
    followers: author.followers,
    starredCount: author.starredCount,
    isSelf: author.isSelf,
    generatedAt: now,
    dataUpdatedAt,
    trackedAuthors: trackedLogins,
  });

  log(`[4/4] 完成：${rendered.length} 个仓库，${Object.keys(render.counts).length} 个分类`);

  return {
    author,
    newStars: page.edges.length,
    totalStars: rows.length,
    classified,
    pagesFetched: page.pagesFetched,
    incremental: isIncremental,
    render,
    markdown: render.markdown,
    counts: render.counts,
  };
}

function sqlNow(): string {
  return new Date().toISOString();
}
