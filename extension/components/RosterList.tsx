import { useEffect, useMemo, useState } from "react";
import { browser } from "wxt/browser";
import { ApiError, type RosterAuthor } from "../lib/api.js";
import { authorPagePath } from "../lib/author-page.js";
import { createClient } from "../lib/settings.js";
import { formatCount, formatTime } from "./SubscriptionList.js";

/**
 * The "名人榜" page.
 *
 * A checked-in list of well-known GitHub accounts, so a reader who has not
 * decided who to follow yet can pick someone and have their star list
 * categorized in place. The account does not have to be subscribed first: the
 * sync uses `allowUnsubscribed`, which keeps the daily run's scope untouched.
 */
export function RosterList() {
  const [authors, setAuthors] = useState<RosterAuthor[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyLogin, setBusyLogin] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const client = await createClient();
        setAuthors(await client.listRoster());
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!keyword) return authors;
    return authors.filter((author) =>
      [author.login, author.name, author.tag, author.blurb]
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [authors, keyword]);

  const openAuthor = async (login: string) => {
    await browser.tabs.create({ url: browser.runtime.getURL(authorPagePath(login)) });
  };

  /**
   * Runs one author's sync, then opens their categorized page.
   *
   * The page is opened only after the run succeeds, so the reader never lands
   * on an empty list wondering whether the click registered.
   */
  const arrange = async (author: RosterAuthor) => {
    setBusyLogin(author.login);
    setError(null);
    setNotice(null);
    try {
      const client = await createClient();
      const result = await client.run({
        logins: [author.login],
        allowUnsubscribed: true,
      });
      const outcome = result.outcomes.find(
        (item) => item.login.toLowerCase() === author.login.toLowerCase(),
      );
      if (outcome?.error) {
        setError(`${author.login} 整理失败：${outcome.error}`);
        return;
      }

      setNotice(
        `${author.name} 整理完成：新增 ${outcome?.newStars ?? result.newStars} 个 star，共 ${outcome?.totalStars ?? 0} 个。`,
      );
      // The card's own numbers come from the database, so re-read them rather
      // than patching state by hand and risking a stale count.
      const refreshed = await client.listRoster();
      setAuthors(refreshed);
      await openAuthor(author.login);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyLogin(null);
    }
  };

  const arranged = authors.filter((author) => author.tracked).length;

  return (
    <div className="stack" style={{ padding: "20px 24px 48px", maxWidth: 1120, margin: "0 auto" }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 4 }}>
          <h1 style={{ fontSize: 20 }}>名人榜 · 值得跟踪的 GitHub 账号</h1>
          <div className="muted small">
            共 {authors.length} 位，已整理 {arranged} 位。点「一键整理」会立刻抓取该账号的
            star 并按变现赛道归类，不需要先订阅。
          </div>
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      <input
        type="text"
        placeholder="搜名字、账号或方向，例如 karpathy / 量化 / 前端"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />

      {loading ? (
        <p className="muted small" style={{ margin: 0 }}>
          正在读取本地服务…
        </p>
      ) : null}

      {!loading && !visible.length ? (
        <p className="muted small" style={{ margin: 0 }}>
          没有匹配「{query.trim()}」的账号。
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        {visible.map((author) => (
          <Card
            key={author.login}
            author={author}
            busy={busyLogin === author.login}
            disabled={busyLogin !== null && busyLogin !== author.login}
            onArrange={() => void arrange(author)}
            onOpen={() => void openAuthor(author.login)}
          />
        ))}
      </div>
    </div>
  );
}

function Card({
  author,
  busy,
  disabled,
  onArrange,
  onOpen,
}: {
  author: RosterAuthor;
  busy: boolean;
  disabled: boolean;
  onArrange: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <h2>{author.name}</h2>
          <a
            className="muted small"
            href={`https://github.com/${author.login}`}
            target="_blank"
            rel="noreferrer"
          >
            @{author.login}
          </a>
        </div>
        <span className="badge accent">{author.tag}</span>
      </div>

      <div className="muted small">{author.blurb}</div>

      <div className="row small" style={{ flexWrap: "wrap", gap: 8 }}>
        <span title={author.followersLive ? undefined : "为收录时的近似值"}>
          {formatCount(author.followers)} followers
          {author.followersLive ? "" : "*"}
        </span>
        <span>·</span>
        <span>
          {author.tracked ? `已整理 ${author.syncedRepos} 个仓库` : "还没有整理过"}
        </span>
        {author.tracked ? (
          <>
            <span>·</span>
            <span>上次同步 {formatTime(author.lastSyncedAt)}</span>
          </>
        ) : null}
      </div>

      {author.topCategories.length ? (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {author.topCategories.map((category) => (
            <span className="badge" key={category.name}>
              {category.name} ×{category.count}
            </span>
          ))}
        </div>
      ) : null}

      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="primary" disabled={busy || disabled} onClick={onArrange}>
          {busy ? "整理中…" : author.tracked ? "重新整理" : "一键整理"}
        </button>
        {author.tracked ? (
          <button type="button" onClick={onOpen}>
            查看分类列表
          </button>
        ) : null}
      </div>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
