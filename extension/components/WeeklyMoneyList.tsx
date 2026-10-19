import { useEffect, useState } from "react";
import {
  ApiError,
  type WeeklyMoneyBoard,
  type WeeklyMoneyPick,
} from "../lib/api.js";
import { createClient } from "../lib/settings.js";
import { formatTime } from "./SubscriptionList.js";

/**
 * Weekly editorial board.
 *
 * Unlike the trending page, this view is not trying to answer "what is hot".
 * It answers "which ten open-source projects are most worth validating this
 * week, and exactly why". Every card therefore leads with the selection
 * rationale and shows the four score components behind the total.
 */
export function WeeklyMoneyList() {
  const [board, setBoard] = useState<WeeklyMoneyBoard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const client = await createClient();
        setBoard(await client.listWeeklyMoney());
      } catch (cause) {
        setError(describe(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="stack" style={{ padding: "20px 24px 48px", maxWidth: 1180, margin: "0 auto" }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="spread" style={{ alignItems: "flex-start" }}>
          <div className="stack" style={{ gap: 4 }}>
            <h1 style={{ fontSize: 22 }}>每周搞钱项目 Top 10</h1>
            <div className="muted small">
              {board?.period
                ? `${board.period.label} · 汇总 ${board.candidateCount} 个不重复项目后精选 ${board.picks.length} 个`
                : "每周总结上一个完整自然周的项目，周一后的首次同步自动更新并推送。"}
            </div>
          </div>
          {board?.period ? <span className="badge accent">周报</span> : null}
        </div>
        {board?.generatedAt ? (
          <div className="muted small">
            生成于 {formatTime(board.generatedAt)}
            {board.fallbackCount ? ` · ${board.fallbackCount} 个常备项目补位` : ""}
            {board.pushedAt ? ` · 已推送 ${formatTime(board.pushedAt)}` : " · 推送待确认"}
          </div>
        ) : null}
      </div>

      {error ? <div className="alert error">{error}</div> : null}

      {loading ? (
        <p className="muted small" style={{ margin: 0 }}>
          正在读取本地服务…
        </p>
      ) : null}

      {!loading && board && !board.picks.length ? (
        <div className="alert warning">
          还没有周报数据。下一次同步会汇总上一个完整自然周，并生成 Top 10。
        </div>
      ) : null}

      {board?.picks.length ? (
        <>
          <div className="card stack" style={{ gap: 4, background: "var(--bg-subtle)" }}>
            <strong>怎么选出来的</strong>
            <div className="muted small">{board.methodology}</div>
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(360px, 1fr))",
              gap: 14,
            }}
          >
            {board.picks.map((pick) => (
              <PickCard key={pick.repo} pick={pick} />
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function PickCard({ pick }: { pick: WeeklyMoneyPick }) {
  return (
    <article className="card stack" style={{ gap: 10 }}>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        <div className="stack" style={{ gap: 3, minWidth: 0 }}>
          <h2 style={{ fontSize: 15 }}>
            <span className="muted">#{pick.rank}</span>{" "}
            <a href={pick.url} target="_blank" rel="noreferrer">
              {pick.name}
            </a>
          </h2>
          <div className="muted small">
            {pick.category} · {pick.sourceDate ?? "常备项目池补位"}
          </div>
        </div>
        <div className="stack" style={{ alignItems: "flex-end", gap: 3 }}>
          <span className="badge accent">{pick.score}/100</span>
          <span className="muted small">入选指数</span>
        </div>
      </div>

      <div
        className="stack"
        style={{
          gap: 4,
          padding: "8px 10px",
          borderLeft: "3px solid var(--accent)",
          background: "var(--bg-subtle)",
        }}
      >
        <strong style={{ fontSize: 12 }}>精选原因</strong>
        <div className="small">{pick.reason}</div>
      </div>

      <ScoreBreakdown pick={pick} />

      <dl
        className="small"
        style={{
          display: "grid",
          gridTemplateColumns: "72px 1fr",
          gap: "5px 8px",
          margin: 0,
        }}
      >
        <dt className="muted">落地场景</dt>
        <dd style={{ margin: 0 }}>{pick.scenario}</dd>
        <dt className="muted">起步方式</dt>
        <dd style={{ margin: 0 }}>{pick.deploy}</dd>
        <dt className="muted">搞钱路径</dt>
        <dd style={{ margin: 0 }}>{pick.monetization}</dd>
        <dt className="muted">适合谁</dt>
        <dd style={{ margin: 0 }}>{pick.fit}</dd>
      </dl>
    </article>
  );
}

function ScoreBreakdown({ pick }: { pick: WeeklyMoneyPick }) {
  const entries = [
    ["需求", pick.breakdown.demand],
    ["变现", pick.breakdown.monetization],
    ["交付", pick.breakdown.delivery],
    ["持续收费", pick.breakdown.repeatability],
  ] as const;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
        gap: 6,
      }}
    >
      {entries.map(([label, score]) => (
        <div key={label} className="stack" style={{ gap: 2 }}>
          <div className="spread small">
            <span className="muted">{label}</span>
            <span>{score}</span>
          </div>
          <div
            aria-hidden="true"
            style={{ height: 4, borderRadius: 999, background: "var(--bg-subtle)" }}
          >
            <div
              style={{
                width: `${score}%`,
                height: "100%",
                borderRadius: 999,
                background: "var(--accent)",
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
