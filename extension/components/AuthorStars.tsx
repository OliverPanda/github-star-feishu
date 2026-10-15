import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ApiError,
  type AuthorLibrary,
  type LibraryCategory,
  type LibraryRepo,
} from "../lib/api.js";
import { createClient } from "../lib/settings.js";
import { loginFromSearch } from "../lib/author-page.js";
import { formatCount, formatTime } from "./SubscriptionList.js";

/** How many rows a category shows before the rest collapses behind a toggle. */
const PREVIEW_ROWS = 8;

/**
 * The "作者库" page.
 *
 * Opened from a subscription click, so the reader lands on the categorized
 * list instead of being sent off to github.com. Layout deliberately mirrors the
 * document that is published into Feishu — same tracks, same order, same
 * headline rankings — because the grouping comes from one shared backend call.
 */
export function AuthorStars() {
  const login = useMemo(() => loginFromSearch(window.location.search), []);
  const [library, setLibrary] = useState<AuthorLibrary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  /** True when the service answers 404, i.e. this login has never been synced. */
  const [missing, setMissing] = useState(false);
  const [arranging, setArranging] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!login) {
      setError("缺少 login 参数，请从插件弹窗里点击账号名进入。");
      setLoading(false);
      return;
    }
    try {
      const client = await createClient();
      setLibrary(await client.authorLibrary(login));
      setMissing(false);
    } catch (cause) {
      // A 404 is not a failure: it is the expected state before the first
      // sync, so it gets an action instead of a red error box.
      if (cause instanceof ApiError && cause.status === 404) {
        setMissing(true);
      } else {
        setError(describe(cause));
      }
    } finally {
      setLoading(false);
    }
  }, [login]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Fetches this author's stars on demand, so a shared link to an account that
   * has not been synced yet is one click away from being useful.
   */
  const arrange = async () => {
    setArranging(true);
    setError(null);
    setNotice(null);
    try {
      const client = await createClient();
      const result = await client.run({ logins: [login], allowUnsubscribed: true });
      const outcome = result.outcomes.find(
        (item) => item.login.toLowerCase() === login.toLowerCase(),
      );
      if (outcome?.error) {
        setError(`${login} 整理失败：${outcome.error}`);
        return;
      }

      await load();
      setNotice(`整理完成：新增 ${outcome?.newStars ?? result.newStars} 个 star。`);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setArranging(false);
    }
  };

  const keyword = query.trim().toLowerCase();
  const categories = useMemo(() => {
    if (!library) return [];
    if (!keyword) return library.categories;
    return library.categories
      .map((category) => ({
        ...category,
        repos: category.repos.filter((repo) => matches(repo, keyword)),
      }))
      .filter((category) => category.repos.length > 0);
  }, [library, keyword]);

  const hitCount = categories.reduce((sum, category) => sum + category.repos.length, 0);

  if (loading) {
    return <Shell login={login}>正在读取本地服务…</Shell>;
  }

  if (missing) {
    return (
      <Shell login={login}>
        <div className="stack" style={{ gap: 10, alignItems: "flex-start" }}>
          <div>
            还没有 {login} 的数据。点下面的按钮抓取 {login} 的 star
            并按变现赛道分类，不需要先订阅。
          </div>
          <button type="button" className="primary" disabled={arranging} onClick={() => void arrange()}>
            {arranging ? "整理中…" : "一键整理"}
          </button>
          {error ? <div className="alert error">{error}</div> : null}
          {notice ? <div className="alert success">{notice}</div> : null}
        </div>
      </Shell>
    );
  }

  if (error || !library) {
    return (
      <Shell login={login}>
        <div className="alert error">{error ?? "没有读到数据。"}</div>
      </Shell>
    );
  }

  return (
    <div className="stack" style={{ padding: "20px 24px 48px", maxWidth: 1120, margin: "0 auto" }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ fontSize: 20 }}>
            {library.alias ? `${library.alias}（${library.login}）` : library.login} 的 Star 精选
          </h1>
          <div className="row muted small" style={{ flexWrap: "wrap", gap: 8 }}>
            {library.isSelf ? <span className="badge accent">本人</span> : null}
            <span>{formatCount(library.followers)} followers</span>
            <span>·</span>
            <span>已整理 {library.syncedRepos} 个仓库</span>
            <span>·</span>
            <span>数据更新至 {library.dataUpdatedAt?.slice(0, 10) ?? "—"}</span>
            <span>·</span>
            <span>上次同步 {formatTime(library.lastSyncedAt)}</span>
          </div>
        </div>
        <a
          className="small"
          href={`https://github.com/${library.login}?tab=stars`}
          target="_blank"
          rel="noreferrer"
          style={{ flexShrink: 0 }}
        >
          在 GitHub 上查看原文
        </a>
      </div>

      {library.unclassified ? (
        <div className="alert warning small">
          有 {library.unclassified} 个仓库尚未按当前分类体系重新归类，它们仍显示在下方对应位置。
        </div>
      ) : null}

      {notice ? <div className="alert success small">{notice}</div> : null}
      {error ? <div className="alert error small">{error}</div> : null}

      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder={`在 ${library.syncedRepos} 个仓库里搜关键词，例如 rag / 量化`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          style={{ flex: "1 1 320px" }}
        />
        {keyword ? (
          <span className="muted small">
            命中 {hitCount} 个仓库
          </span>
        ) : null}
      </div>

      {!keyword && library.topPicks.length ? (
        <Ranking
          title="变现机会榜"
          hint={`按「变现潜力」排序，取 ${4} 分以上的前 ${library.topPicks.length} 个。同一批仓库在下方按赛道完整列出。`}
          repos={library.topPicks}
          showRank
        />
      ) : null}

      {!keyword && library.shared.length ? (
        <Ranking
          title="多位关注对象共同收藏"
          hint="被多个跟踪账号同时 star，是可信度最高的推荐。"
          repos={library.shared}
        />
      ) : null}

      {!keyword ? (
        <div className="card stack" style={{ gap: 4 }}>
          <h2>目录</h2>
          <div className="stack" style={{ gap: 2 }}>
            {categories.map((category, index) => (
              <a key={category.name} className="small" href={`#cat-${index}`}>
                {category.name}（{category.count}
                {category.averageMoneyScore ? `，平均潜力 ${category.averageMoneyScore}` : ""}）
              </a>
            ))}
          </div>
        </div>
      ) : null}

      {categories.map((category, index) => (
        <CategorySection key={category.name} category={category} index={index} collapsed={Boolean(keyword)} />
      ))}

      {!categories.length ? (
        <p className="muted small" style={{ margin: 0 }}>
          {keyword ? `没有匹配「${query.trim()}」的仓库。` : "这个账号还没有已入库的 star。"}
        </p>
      ) : null}
    </div>
  );
}

function Shell({ login, children }: { login: string; children: React.ReactNode }) {
  return (
    <div className="stack" style={{ padding: "20px 24px", maxWidth: 760, margin: "0 auto" }}>
      <h1 style={{ fontSize: 18 }}>{login ? `${login} 的 Star 精选` : "作者精选"}</h1>
      <div className="muted small">{children}</div>
    </div>
  );
}

function CategorySection({
  category,
  index,
  collapsed,
}: {
  category: LibraryCategory;
  index: number;
  collapsed: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const showingAll = collapsed || expanded || category.repos.length <= PREVIEW_ROWS;
  const rows = showingAll ? category.repos : category.repos.slice(0, PREVIEW_ROWS);

  return (
    <div className="stack" style={{ gap: 8 }} id={`cat-${index}`}>
      <div className="spread">
        <h2 style={{ fontSize: 15 }}>
          {category.name}（{category.count}
          {category.averageMoneyScore ? `，平均潜力 ${category.averageMoneyScore}` : ""}）
        </h2>
        {!showingAll ? (
          <button type="button" className="link small" onClick={() => setExpanded(true)}>
            展开其余 {category.repos.length - PREVIEW_ROWS} 个
          </button>
        ) : null}
      </div>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>仓库</th>
              <th>变现路径</th>
              <th>潜力</th>
              <th>Stars</th>
              <th>收藏时间</th>
              <th>一句话说明</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((repo) => (
              <tr key={repo.fullName}>
                <td style={{ whiteSpace: "nowrap" }}>
                  <a href={repo.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                    {repo.fullName}
                  </a>
                  {repo.endorsedBy >= 2 ? <span className="badge accent" style={{ marginLeft: 6 }}>×{repo.endorsedBy}</span> : null}
                </td>
                <td style={{ whiteSpace: "nowrap" }} className="muted">
                  {repo.monetization}
                </td>
                <td style={{ whiteSpace: "nowrap" }} title={repo.moneyScore ? `变现潜力 ${repo.moneyScore}/5` : "未评分"}>
                  {formatScore(repo.moneyScore)}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{formatCount(repo.stars)}</td>
                <td style={{ whiteSpace: "nowrap" }} className="muted small">
                  {repo.starredAt.slice(0, 10)}
                </td>
                <td className="muted">{repo.summaryZh ?? repo.description ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Ranking({
  title,
  hint,
  repos,
  showRank = false,
}: {
  title: string;
  hint: string;
  repos: LibraryRepo[];
  showRank?: boolean;
}) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <h2 style={{ fontSize: 15 }}>{title}</h2>
      <p className="muted small" style={{ margin: 0 }}>
        {hint}
      </p>
      <div className="card" style={{ padding: 0, overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              {showRank ? <th>#</th> : null}
              <th>仓库</th>
              <th>赛道</th>
              <th>变现路径</th>
              <th>潜力</th>
              {showRank ? null : <th>共同收藏</th>}
              <th>Stars</th>
            </tr>
          </thead>
          <tbody>
            {repos.map((repo, index) => (
              <tr key={repo.fullName}>
                {showRank ? <td className="muted">{index + 1}</td> : null}
                <td style={{ whiteSpace: "nowrap" }}>
                  <a href={repo.url} target="_blank" rel="noreferrer" style={{ fontWeight: 600 }}>
                    {repo.fullName}
                  </a>
                  <div className="muted small" style={{ whiteSpace: "normal", maxWidth: 360 }}>
                    {repo.summaryZh ?? repo.description ?? ""}
                  </div>
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{repo.category}</td>
                <td style={{ whiteSpace: "nowrap" }} className="muted">
                  {repo.monetization}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>{formatScore(repo.moneyScore)}</td>
                {showRank ? null : <td>{repo.endorsedBy}</td>}
                <td style={{ whiteSpace: "nowrap" }}>{formatCount(repo.stars)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Filled dots instead of a bare digit, matching the Feishu document. */
function formatScore(score: number | null): string {
  if (score === null) return "—";
  return `${"●".repeat(score)}${"○".repeat(Math.max(0, 5 - score))} ${score}`;
}

function matches(repo: LibraryRepo, keyword: string): boolean {
  return [repo.fullName, repo.summaryZh, repo.description, repo.language, repo.category, repo.monetization]
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.toLowerCase().includes(keyword));
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
