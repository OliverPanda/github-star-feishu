#!/usr/bin/env node
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApi } from "./app.js";
import { loadConfig } from "../config.js";
import { openDb } from "../db/client.js";
import {
  DEFAULT_SUBSCRIPTIONS_FILE,
  SubscriptionConfigError,
  loadSubscriptions,
} from "../subscriptions.js";
import { listSubscriptions, setSetting } from "../store.js";
import { runSync, seedSubscriptions } from "../service.js";
import { createSyncGate, createSyncScheduler } from "../scheduler.js";

const USAGE = `github-star-rag API — 给浏览器插件用的同步服务

用法:
  npm run api            启动服务（默认 http://127.0.0.1:8787）
  npm run api -- --seed  启动前先把订阅 YAML 导入数据库

环境变量:
  API_TOKEN   插件调用所需的 Bearer Token（必填，否则拒绝服务）
  API_PORT    监听端口，默认 8787
  API_HOST    监听地址，默认 127.0.0.1（只允许本机访问）
  API_SEED    设为 1 时，启动时导入 ${DEFAULT_SUBSCRIPTIONS_FILE}
  SYNC_SCHEDULE_ENABLED  设为 false 或 0 时关闭每日同步（默认开启）
  SYNC_CRON   定时表达式，默认 0 9 * * *（每天 09:00）
  SYNC_TIMEZONE  默认 Asia/Shanghai
`;

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();
  if (!config.api.token) {
    console.error(
      "错误：未配置 API_TOKEN。插件需要一个共享密钥才能调用本服务，\n" +
        "      请在 .env 中设置，例如：API_TOKEN=一串随机字符串",
    );
    process.exit(1);
  }

  const db = openDb({
    dbPath: config.dbPath,
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });

  if (args.includes("--seed") || process.env.API_SEED === "1") {
    seed(db);
  } else if (!listSubscriptions(db).length) {
    console.log(
      `提示：数据库中还没有订阅。可以运行 \`npm run api -- --seed\` 从 ` +
        `${DEFAULT_SUBSCRIPTIONS_FILE} 导入，或用插件页面添加。\n`,
    );
  }

  const log = (message: string) => console.log(message);
  const exclusive = createSyncGate();
  const scheduler = createSyncScheduler({ db, config, exclusive, log });
  const app = createApi({
    db,
    config,
    log,
    runner: (options) => exclusive(() => runSync(options)),
  });

  const server = serve({ fetch: app.fetch, port: config.api.port, hostname: config.api.host }, (info) => {
    scheduler?.start();
    console.log(`同步服务已启动：http://${config.api.host}:${info.port}`);
    console.log(`健康检查：curl -H "Authorization: Bearer $API_TOKEN" http://${config.api.host}:${info.port}/api/health`);
    console.log("按 Ctrl+C 停止\n");
  });

  const shutdown = () => {
    scheduler?.destroy();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/** Import the YAML document so an existing setup keeps working after the upgrade. */
function seed(db: ReturnType<typeof openDb>): void {
  try {
    const subscriptions = loadSubscriptions(DEFAULT_SUBSCRIPTIONS_FILE);
    const count = seedSubscriptions(db, subscriptions);
    setSetting(db, "seeded_from", DEFAULT_SUBSCRIPTIONS_FILE);
    console.log(`已从 ${DEFAULT_SUBSCRIPTIONS_FILE} 导入 ${count} 个订阅\n`);
  } catch (error) {
    if (error instanceof SubscriptionConfigError) {
      console.error(`导入订阅失败：${error.message}\n`);
      return;
    }
    throw error;
  }
}

main();
