import cron from "node-cron";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { readLoginStatus } from "./feishu/login-flow.js";
import { readGitHubLoginStatus } from "./github/login-flow.js";
import { notifyText, notifyWeeklyMoneyReport } from "./feishu/notify.js";
import { runSync, subscriptionsFromDb } from "./service.js";
import { setSetting } from "./store.js";
import { markWeeklyMoneyPushed, type WeeklyMoneyReport } from "./weekly-money.js";

export class SyncBusyError extends Error {
  constructor() { super("已有同步正在运行，请稍后再试"); }
}

/** Shared by the service's HTTP and scheduled entry points. */
export function createSyncGate() {
  let busy = false;
  return async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (busy) throw new SyncBusyError();
    busy = true;
    try { return await work(); } finally { busy = false; }
  };
}

export function createSyncScheduler(options: {
  db: Db;
  config: AppConfig;
  exclusive: ReturnType<typeof createSyncGate>;
  log: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  runner?: typeof runSync;
}) {
  const { db, config, exclusive, log, env = process.env, runner = runSync } = options;
  if (env.SYNC_SCHEDULE_ENABLED === "false" || env.SYNC_SCHEDULE_ENABLED === "0") {
    log("每日同步定时任务已关闭");
    return null;
  }
  const expression = env.SYNC_CRON ?? "0 9 * * *";
  const timezone = env.SYNC_TIMEZONE ?? "Asia/Shanghai";
  if (!cron.validate(expression)) throw new Error(`无效的 SYNC_CRON：${expression}`);
  // Validate before the HTTP server starts accepting traffic.
  new Intl.DateTimeFormat("zh-CN", { timeZone: timezone }).format();

  async function execute() {
    try {
      await exclusive(async () => {
        // Read on every tick: subscription edits in the extension take effect immediately.
        const subscriptions = subscriptionsFromDb(db);
        const startedAt = new Date().toISOString();
        let message: string;
        let status: string;
        let actionable = true;
        let weeklyReport: WeeklyMoneyReport | null = null;
        let weeklyPeriodKey: string | null = null;
        let weeklyNodeToken: string | null = null;
        try {
          const [feishu, github] = await Promise.all([
            readLoginStatus({ ...config.feishu, log }),
            readGitHubLoginStatus({ ...config.github, log }),
          ]);
          const missing = [!feishu.loggedIn && "飞书", !github.loggedIn && "GitHub"].filter(Boolean);
          if (missing.length) throw new Error(`${missing.join(" / ")} 未登录，请重新扫码登录；本次同步已停止`);
          if (feishu.missingScopes.length) {
            throw new Error(`飞书缺少权限：${feishu.missingScopes.join(", ")}，请重新扫码授权`);
          }
          log("每日定时同步开始");
          const result = await runner({ db, config, subscriptions, trigger: "schedule", log });
          const trendingFailed = subscriptions.trending && (result.trendingError || result.trendingCount === 0);
          const weeklyFailed = result.weeklyMoneyPushDue && Boolean(result.weeklyMoneyError);
          actionable =
            result.newStars > 0 ||
            result.failed > 0 ||
            Boolean(trendingFailed) ||
            result.weeklyMoneyPushDue ||
            weeklyFailed;
          status = result.failed || trendingFailed || weeklyFailed ? "failed" : "success";
          if (result.weeklyMoneyPushDue) {
            weeklyReport = result.weeklyMoneyReport;
            weeklyPeriodKey = result.weeklyMoneyPeriodKey;
            weeklyNodeToken = result.weeklyMoneyNodeToken;
          }
          const lines = [`每日同步：新增 ${result.newStars} 个 star，失败 ${result.failed} 个作者`];
          for (const outcome of result.outcomes) {
            if (outcome.error) lines.push(`${outcome.login}：${outcome.error}`);
          }
          if (trendingFailed) lines.push(`趋势榜失败：${result.trendingError ?? "暂无数据"}`);
          // The money board is written by the same run, so its failure belongs
          // in the same message instead of only in the run log.
          if (result.commercialError) lines.push(`搞钱项目精选失败：${result.commercialError}`);
          if (result.weeklyMoneyError) lines.push(`搞钱周报失败：${result.weeklyMoneyError}`);
          if (weeklyReport) {
            lines.push(
              `搞钱周报：${weeklyReport.period.label} Top ${weeklyReport.picks.length} 待推送`,
            );
          }
          message = lines.join("\n");
        } catch (error) {
          status = "failed";
          message = `每日同步失败：${error instanceof Error ? error.message : String(error)}`;
        }
        // Includes preflight failures, which never reach runSync's history table.
        setSetting(db, "scheduler_last_result", JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), status, message }));
        log(message);
        const app =
          subscriptions.notifyChat && config.feishu.appId && config.feishu.appSecret
            ? {
                appId: config.feishu.appId,
                appSecret: config.feishu.appSecret,
                chatId: subscriptions.notifyChat,
              }
            : undefined;
        const hasChannel = Boolean(app || subscriptions.webhook);
        if (actionable && hasChannel) {
          try {
            await notifyText(message, {
              ...(app ? { app } : {}),
              webhook: subscriptions.webhook,
              log,
            });
          } catch (error) {
            log(`每日同步通知失败：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (weeklyReport && weeklyPeriodKey && hasChannel) {
          try {
            const sent = await notifyWeeklyMoneyReport(weeklyReport, {
              ...(app ? { app } : {}),
              webhook: subscriptions.webhook,
              wikiBaseUrl: subscriptions.wikiBaseUrl,
              nodeToken: weeklyNodeToken,
              log,
            });
            if (sent) markWeeklyMoneyPushed(db, weeklyPeriodKey);
          } catch (error) {
            log(`搞钱周报推送失败（下次同步会补推）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      });
    } catch (error) {
      log(error instanceof SyncBusyError
        ? "跳过本次定时同步：已有同步正在运行"
        : `每日同步任务异常：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The server starts this only after successfully binding its listening port.
  const task = cron.createTask(expression, execute, {
    name: "github-star-daily-sync", timezone, noOverlap: true,
  });
  log(`每日同步已配置：${expression}（${timezone}），随服务运行`);
  return task;
}
