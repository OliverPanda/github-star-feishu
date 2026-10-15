import { useEffect, useMemo, useState } from "react";
import { ApiError, type TrendingBoard, type TrendingRow } from "../lib/api.js";
import { createClient } from "../lib/settings.js";
import { formatCount, formatTime } from "./SubscriptionList.js";

/**
 * The "趋势榜" page.
 *
 * GitHub's own trending page answers "what is hot"; this one answers "what is
 * hot and could make money", by showing each repository's 变现赛道 alongside
 * the day's gain. The data is the copy the local service cached during its last
 * sync, so the page opens instantly and never scrapes github.com itself.
 */
export function TrendingList() {
  const [board, setBoard] = useState<TrendingBoard | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const client = await createClient();
        setBoard(await client.listTrending());
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const keyword = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const rows = board?.rows ?? [];
    if (!keyword) return rows;
    return rows.filter((row) =>
      [row.fullName, row.category, row.language ?? "", row.description ?? "", row.summaryZh ?? ""]
        .some((value) => value.toLowerCase().includes(keyword)),
    );
  }, [board, keyword]);

  const rows = board?.rows ?? [];

  return (
    <div className="stack" style={{ padding: "20px 24px 48px", maxWidth: 1120, margin: "0 auto" }}>
      <div className="stack" style={{ gap: 4 }}>
        <h1 style={{ fontSize: 20 }}>GitHub 上涨趋势榜 · 今日新增 Star TOP 10</h1>
        <div className="muted small">
          {board?.generatedAt
            ? `数据抓取于 ${formatTime(board.generatedAt)}（${sinceLabel(board.since)}榜），共 ${rows.length} 个仓库。`
            : "还没有抓取过趋势榜，等下一次每日同步后这里会显示 TOP 10。"}
        </div>
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {loading ? (
        <p className="muted small" style={{ margin: 0 }}>
          正在读取本地服务…
        </p>
      ) : null}

      {!loading && board && !rows.length ? (
        <div className="alert warning">
          暂无可展示的趋势数据。可能是还没有同步过，或 GitHub 的页面结构发生了变化导致解析失败——
          两种情况都会在下一次同步时自动重试。
        </div>
      ) : null}

      {rows.length ? (
        <input
          type="text"
          placeholder="搜仓库、赛道或语言，例如 agent / 量化 / TypeScript"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      ) : null}

      {rows.length && !visible.length ? (
        <p className="muted small" style={{ margin: 0 }}>
          没有匹配「{query.trim()}」的仓库。
        </p>
      ) : null}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: 12,
        }}
      >
        {visible.map((row, index) => (
          <Card key={row.fullName} row={row} rank={rankOf(rows, row, index)} />
        ))}
      </div>
    </div>
  );
}

/** Keeps the badge showing the board's own rank even while a filter is active. */
function rankOf(rows: TrendingRow[], row: TrendingRow, fallback: number): number {
  const index = rows.indexOf(row);
  return index === -1 ? fallback + 1 : index + 1;
}

function Card({ row, rank }: { row: TrendingRow; rank: number }) {
  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <h2>
            <span className="muted">#{rank}</span>{" "}
            <a href={row.url} target="_blank" rel="noreferrer">
              {row.fullName}
            </a>
          </h2>
          <div className="muted small">
            今日 +{formatCount(row.starsToday)} · 总 {formatCount(row.stars)} stars
            {row.language ? ` · ${row.language}` : ""}
          </div>
        </div>
        <span className="badge accent">{row.category}</span>
      </div>

      <div className="muted small">{row.summaryZh ?? row.description ?? "暂无描述"}</div>

      <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
        {row.monetization ? <span className="badge">{row.monetization}</span> : null}
        <span className="badge" title={row.moneyScore ? `变现潜力 ${row.moneyScore}/5` : "未评分"}>
          {formatScore(row.moneyScore)}
        </span>
      </div>
    </div>
  );
}

/** "●●●○○ 3" — a dot meter reads faster than a bare number in a card grid. */
function formatScore(score: number | null | undefined): string {
  if (!score) return "潜力 -";
  const filled = "●".repeat(score);
  const empty = "○".repeat(Math.max(0, 5 - score));
  return `潜力 ${filled}${empty} ${score}`;
}

function sinceLabel(since: TrendingBoard["since"]): string {
  if (since === "weekly") return "每周";
  if (since === "monthly") return "每月";
  return "每日";
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
