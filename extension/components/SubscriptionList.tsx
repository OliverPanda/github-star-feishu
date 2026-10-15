import { browser } from "wxt/browser";
import type { SubscriptionView } from "../lib/api.js";
import { authorPagePath } from "../lib/author-page.js";

interface Props {
  subscriptions: SubscriptionView[];
  busyLogin: string | null;
  onRemove: (login: string) => void;
  onToggle: (login: string, enabled: boolean) => void;
}

/** Formats a follower count the way GitHub does, so the number stays readable. */
export function formatCount(value: number | null): string {
  if (value === null) return "—";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  return `${Math.round(value / 1000)}k`;
}

/** SQLite stores naive UTC strings; make them readable without a date library. */
export function formatTime(value: string | null): string {
  if (!value) return "尚未同步";
  const parsed = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString("zh-CN", { hour12: false });
}

export function SubscriptionList({ subscriptions, busyLogin, onRemove, onToggle }: Props) {
  if (!subscriptions.length) {
    return (
      <p className="muted small" style={{ margin: 0 }}>
        还没有订阅。在上方输入一个 GitHub 用户名，例如 <code>karpathy</code>。
      </p>
    );
  }

  return (
    <div className="list">
      {subscriptions.map((item) => {
        const busy = busyLogin === item.login;
        return (
          <div className="list-item" key={item.login}>
            <div style={{ minWidth: 0 }}>
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {/*
                 * Opens the extension's own categorized page. Jumping straight
                 * to github.com would hand the reader an unsorted star list,
                 * which is exactly what this project exists to replace.
                 */}
                <button
                  type="button"
                  className="link"
                  style={{ fontWeight: 600 }}
                  title={`查看 ${item.login} 按变现赛道分类后的仓库`}
                  onClick={() => {
                    void browser.tabs.create({
                      url: browser.runtime.getURL(
                        authorPagePath(item.login),
                      ),
                    });
                  }}
                >
                  {item.alias ? `${item.alias}（${item.login}）` : item.login}
                </button>
                <a
                  className="muted small"
                  href={`https://github.com/${item.login}?tab=stars`}
                  target="_blank"
                  rel="noreferrer"
                  title="在 GitHub 上查看原始 star 列表"
                >
                  GitHub
                </a>
                {item.isSelf ? <span className="badge accent">本人</span> : null}
                {!item.enabled ? <span className="badge paused">已暂停</span> : null}
              </div>
              <div className="muted small">
                {item.syncedRepos} 个已入库 / 共 {formatCount(item.starredCount)} stars ·{" "}
                {formatTime(item.lastSyncedAt)}
              </div>
            </div>
            <div className="row" style={{ gap: 6, flexShrink: 0 }}>
              <label className="row small muted" style={{ gap: 4, cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={item.enabled}
                  disabled={busy}
                  onChange={(event) => onToggle(item.login, event.target.checked)}
                />
                启用
              </label>
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => onRemove(item.login)}
              >
                {busy ? "…" : "删除"}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
