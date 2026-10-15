import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import { ApiError, type RunSummary, type SubscriptionView } from "../lib/api.js";
import { isValidLogin } from "../lib/github.js";
import { ROSTER_PAGE_PATH, TRENDING_PAGE_PATH } from "../lib/author-page.js";
import { createClient } from "../lib/settings.js";
import { SubscriptionList, formatTime } from "./SubscriptionList.js";

const STATUS_LABELS: Record<string, string> = {
  running: "进行中",
  success: "成功",
  partial: "部分失败",
  failed: "失败",
};

export function Popup() {
  const [subscriptions, setSubscriptions] = useState<SubscriptionView[]>([]);
  const [login, setLogin] = useState("");
  const [alias, setAlias] = useState("");
  const [busyLogin, setBusyLogin] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastRun, setLastRun] = useState<RunSummary | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const client = await createClient();
    const [list, runs] = await Promise.all([client.listSubscriptions(), client.listRuns()]);
    setSubscriptions(list);
    setLastRun(runs[0] ?? null);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        await refresh();
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setLoaded(true);
      }
    })();
  }, [refresh]);

  const add = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = login.trim();
    if (!isValidLogin(trimmed)) {
      setError("这不是一个合法的 GitHub 用户名。");
      return;
    }

    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      const client = await createClient();
      const saved = await client.addSubscription({
        login: trimmed,
        ...(alias.trim() ? { alias: alias.trim() } : {}),
      });
      setLogin("");
      setAlias("");
      setNotice(`已添加 ${saved.login}（${saved.starredCount ?? 0} 个 star）`);
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (target: string) => {
    setBusyLogin(target);
    setError(null);
    setNotice(null);
    try {
      const client = await createClient();
      await client.removeSubscription(target);
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyLogin(null);
    }
  };

  const toggle = async (target: string, enabled: boolean) => {
    setBusyLogin(target);
    setError(null);
    try {
      const client = await createClient();
      await client.updateSubscription(target, { enabled });
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusyLogin(null);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    setNotice(null);
    try {
      const client = await createClient();
      const result = await client.run();
      const skipped = result.skipped.length ? `，跳过 ${result.skipped.length} 个` : "";
      setNotice(`同步完成：新增 ${result.newStars} 个 star${skipped}`);
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setRunning(false);
    }
  };

  const enabledCount = subscriptions.filter((item) => item.enabled).length;

  return (
    <div className="stack" style={{ padding: 12, width: 380 }}>
      <div className="spread">
        <h1>GitHub Star RAG</h1>
        <div className="row" style={{ gap: 10 }}>
          {/*
           * The roster is a grid of cards, so it opens in a full tab; 380px of
           * popup would force every card into a single cramped column.
           */}
          <button
            type="button"
            className="link"
            title="看看有哪些值得跟踪的账号可以一键整理"
            onClick={() => {
              void browser.tabs.create({
                url: browser.runtime.getURL(ROSTER_PAGE_PATH),
              });
            }}
          >
            名人榜
          </button>
          {/*
           * The board is a ranking table with a card grid, so it opens in a tab
           * like the roster rather than being squeezed into the popup.
           */}
          <button
            type="button"
            className="link"
            title="今天涨得最快的 10 个仓库，已按变现赛道标注"
            onClick={() => {
              void browser.tabs.create({
                url: browser.runtime.getURL(TRENDING_PAGE_PATH),
              });
            }}
          >
            趋势榜
          </button>
          <button
            type="button"
            className="link"
            onClick={() => browser.runtime.openOptionsPage()}
          >
            设置
          </button>
        </div>
      </div>

      <form className="stack" style={{ gap: 6 }} onSubmit={add}>
        <div className="row" style={{ gap: 6 }}>
          <input
            type="text"
            placeholder="GitHub 用户名，例如 karpathy"
            value={login}
            onChange={(event) => setLogin(event.target.value)}
            disabled={adding}
          />
          <button type="submit" className="primary" disabled={adding || !login.trim()}>
            {adding ? "验证中" : "添加"}
          </button>
        </div>
        <input
          type="text"
          placeholder="显示名（可选），例如 Andrej Karpathy"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          disabled={adding}
        />
      </form>

      {error ? <div className="alert error">{error}</div> : null}
      {notice ? <div className="alert success">{notice}</div> : null}

      <div className="spread">
        <h2>订阅的账号（{subscriptions.length}）</h2>
        <button
          type="button"
          disabled={running || enabledCount === 0}
          onClick={runNow}
          title={enabledCount === 0 ? "没有启用中的订阅" : "立即同步到飞书知识库"}
        >
          {running ? "同步中…" : "立即同步"}
        </button>
      </div>

      {!loaded ? (
        <p className="muted small" style={{ margin: 0 }}>
          正在读取…
        </p>
      ) : (
        <SubscriptionList
          subscriptions={subscriptions}
          busyLogin={busyLogin}
          onRemove={remove}
          onToggle={toggle}
        />
      )}

      {lastRun ? (
        <div className="card stack" style={{ gap: 6 }}>
          <div className="spread">
            <h2>上次同步</h2>
            <span
              className={`badge ${lastRun.status === "success" ? "" : "paused"}`}
            >
              {STATUS_LABELS[lastRun.status] ?? lastRun.status}
            </span>
          </div>
          <div className="muted small">
            {formatTime(lastRun.startedAt)} · 新增 {lastRun.newStars} 个 star ·{" "}
            {lastRun.totalAuthors} 个账号
            {lastRun.failedAuthors ? ` · ${lastRun.failedAuthors} 个失败` : ""}
          </div>
          {lastRun.error ? <div className="alert error">{lastRun.error}</div> : null}
          {lastRun.authors.filter((author) => author.error).length ? (
            <div className="small" style={{ color: "var(--danger)" }}>
              {lastRun.authors
                .filter((author) => author.error)
                .map((author) => `${author.login}：${author.error}`)
                .join("\n")}
            </div>
          ) : null}
        </div>
      ) : null}

      {running ? (
        <div className="log">
          正在同步，可在服务端终端查看进度。首次同步一个 star 较多的账号可能需要数分钟。
        </div>
      ) : null}
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
