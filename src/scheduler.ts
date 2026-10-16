import cron from "node-cron";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import { readLoginStatus } from "./feishu/login-flow.js";
import { readGitHubLoginStatus } from "./github/login-flow.js";
import { notifyText } from "./feishu/notify.js";
import { runSync, subscriptionsFromDb } from "./service.js";
import { setSetting } from "./store.js";

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
          actionable = result.newStars > 0 || result.failed > 0 || Boolean(trendingFailed);
          status = result.failed || trendingFailed ? "failed" : "success";
          const lines = [`每日同步：新增 ${result.newStars} 个 star，失败 ${result.failed} 个作者`];
          for (const outcome of result.outcomes) {
            if (outcome.error) lines.push(`${outcome.login}：${outcome.error}`);
          }
          if (trendingFailed) lines.push(`趋势榜失败：${result.trendingError ?? "暂无数据"}`);
          // The money board is written by the same run, so its failure belongs
          // in the same message instead of only in the run log.
          if (result.commercialError) lines.push(`搞钱项目精选失败：${result.commercialError}`);
          message = lines.join("\n");
        } catch (error) {
          status = "failed";
          message = `每日同步失败：${error instanceof Error ? error.message : String(error)}`;
        }
        // Includes preflight failures, which never reach runSync's history table.
        setSetting(db, "scheduler_last_result", JSON.stringify({ startedAt, finishedAt: new Date().toISOString(), status, message }));
        log(message);
        if (actionable && subscriptions.webhook) {
          try {
            await notifyText(message, { webhook: subscriptions.webhook, log });
          } catch (error) {
            log(`每日同步通知失败：${error instanceof Error ? error.message : String(error)}`);
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
