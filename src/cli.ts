#!/usr/bin/env node
import { parseArgs } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, upsertEnvVar } from "./config.js";
import { openDb } from "./db/client.js";
import { createGitHubClient, getGraphqlRateLimit } from "./github/client.js";
import { GitHubUserNotFoundError, GitHubStarsUnavailableError } from "./github/stars.js";
import {
  readGitHubLoginStatus,
  runGitHubLoginFlow,
} from "./github/login-flow.js";
import { createLanguageModel } from "./llm/provider.js";
import { syncAuthor } from "./sync.js";
import { runBatch, sectionTitle } from "./batch.js";
import { publishDocument } from "./publish.js";
import { FeishuCliWriter } from "./feishu/cli.js";
import { readLoginStatus, runLoginFlow } from "./feishu/login-flow.js";
import { LocalFsWriter } from "./feishu/local.js";
import { buildSimpleCard, notifyBatchResult, notifyCard } from "./feishu/notify.js";
import { COMMERCIAL_DOC_KEY, summarizeCommercialBoard } from "./commercial-board.js";
import { getWikiNode } from "./store.js";
import {
  activeAuthors,
  DEFAULT_SUBSCRIPTIONS_FILE,
  loadSubscriptions,
  type Subscriptions,
} from "./subscriptions.js";
import { getAuthorByLogin, listAuthors, countStarsForAuthor } from "./store.js";

const USAGE = `github-star-rag — 把任意 GitHub 账号的 Star 整理成飞书知识库

用法:
  npm run cli -- run  [选项]              按订阅文件同步全部作者并更新知识库（推荐）
  npm run cli -- sync  <login> [选项]     拉取并分类，产出 Markdown
  npm run cli -- publish <login> [选项]   同步并写入飞书知识库
  npm run cli -- list                     列出已跟踪的作者
  npm run cli -- rate                     查看 GitHub API 配额
  npm run cli -- login                    扫码登录飞书（首次会自动创建你的个人应用）
  npm run cli -- logout                   退出飞书登录
  npm run cli -- whoami                   查看飞书登录状态
  npm run cli -- notify:test              往配置的群发一条搞钱日报测试卡片（验证推送通道）
  npm run cli -- login:github             扫码登录 GitHub，并把 Token 写入 .env
  npm run cli -- logout:github            退出 GitHub 登录并清空 .env 里的 Token
  npm run cli -- whoami:github            查看 GitHub 登录状态

选项:
  --config <file>   订阅配置文件（默认 ${DEFAULT_SUBSCRIPTIONS_FILE}）
  --full            忽略增量水位，重新全量拉取
  --no-classify     跳过 LLM 分类（快速验证拉取链路）
  --self            标记为本人 star（影响标题文案）
  --out <dir>       同时把 Markdown 导出到本地目录
  --local           用本地文件系统代替飞书（dry-run，不需要飞书凭证）
  --no-notify       跳过飞书 Webhook 通知
  --no-trending     本次不发布「GitHub 上涨趋势榜」（订阅文件里 trending: false 等效）
  --space <name>    指定知识库名称（默认 "GitHub Star 精选"）
  --space-id <id>   直接指定知识库 space_id
  --create-space    找不到同名知识库时新建（默认复用已有，不自动新建）
  --parent <token>  写入指定父节点下
  --index-parent <token>  索引页的父节点（默认与作者子树同级）
  --force           忽略内容哈希，强制重写
  -h, --help        显示帮助
`;

function fail(message: string): never {
  console.error(`错误：${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      full: { type: "boolean", default: false },
      "no-classify": { type: "boolean", default: false },
      self: { type: "boolean", default: false },
      local: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "no-notify": { type: "boolean", default: false },
      "no-trending": { type: "boolean", default: false },
      config: { type: "string" },
      out: { type: "string" },
      space: { type: "string" },
      "space-id": { type: "string" },
      "create-space": { type: "boolean", default: false },
      parent: { type: "string" },
      "index-parent": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(USAGE);
    return;
  }

  const command = positionals[0];
  const config = loadConfig();
  const db = openDb({
    dbPath: config.dbPath,
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });

  // Declared before the command dispatch because `runAll` (defined below)
  // closes over it; a later `const` would be in its temporal dead zone.
  const log = (message: string) => console.log(message);

  if (command === "list") {
    const authors = listAuthors(db);
    if (!authors.length) {
      console.log("还没有跟踪任何作者。先运行：npm run cli -- sync <login>");
      return;
    }
    console.log("已跟踪的作者：\n");
    for (const author of authors) {
      const count = countStarsForAuthor(db, author.id);
      const self = author.isSelf ? " (本人)" : "";
      console.log(
        `  ${author.login.padEnd(24)} ${String(count).padStart(5)} repos  ` +
          `${String(author.starredCount).padStart(6)} stars  ` +
          `上次同步 ${author.lastSyncedAt ?? "-"}${self}`,
      );
    }
    return;
  }

  if (command === "rate") {
    if (!config.githubToken) fail("需要 GITHUB_TOKEN 或 GH_TOKEN 才能查询配额");
    const rate = await getGraphqlRateLimit(createGitHubClient({ token: config.githubToken }));
    console.log(
      `GraphQL 配额：${rate.remaining}/${rate.limit}（重置于 ${rate.resetAt}）`,
    );
    return;
  }

  if (command === "login") {
    console.log("=== 飞书扫码登录 ===\n");
    const result = await runLoginFlow({
      cliPath: config.feishu.cliPath,
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      log,
    });
    if (!result.ok) fail(result.error ?? "飞书登录失败");
    console.log(`登录完成${result.appId ? `（应用 ${result.appId}）` : ""}。`);
    console.log("接下来可以直接运行：npm run cli -- run\n");
    return;
  }

  if (command === "logout") {
    const { FeishuAuth } = await import("./feishu/auth.js");
    await new FeishuAuth({
      cliPath: config.feishu.cliPath,
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      log,
    }).logout();
    console.log("已退出飞书登录（本地凭据已清除）。");
    return;
  }

  if (command === "whoami") {
    const status = await readLoginStatus({
      cliPath: config.feishu.cliPath,
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
      log,
    });
    if (!status.loggedIn) {
      console.log("尚未登录飞书。运行：npm run cli -- login\n");
      if (status.hint) console.log(`提示：${status.hint}`);
      return;
    }
    console.log("已登录飞书：\n");
    console.log(`  用户       ${status.userName ?? "(未知，CLI 未返回)"}`);
    console.log(`  应用       ${status.appId ?? "(未知)"}`);
    console.log(`  授权范围   ${status.scopes.length ? status.scopes.join(", ") : "(未知)"}`);
    if (status.missingScopes.length) {
      console.log(`  缺少权限   ${status.missingScopes.join(", ")}`);
      console.log("\n可运行 npm run cli -- login 重新授权以补齐权限。");
    }
    return;
  }

  if (command === "login:github") {
    console.log("=== GitHub 扫码登录 ===\n");
    const result = await runGitHubLoginFlow({
      ...config.github,
      envFile: path.join(process.cwd(), ".env"),
      log,
    });
    if (!result.ok) fail(result.error ?? "GitHub 登录失败");
    console.log(`登录完成${result.login ? `（${result.login}）` : ""}。`);
    console.log("接下来可以直接运行：npm run cli -- run\n");
    return;
  }

  if (command === "logout:github") {
    const { GitHubAuth } = await import("./github/auth.js");
    const auth = new GitHubAuth({ ...config.github, log });
    await auth.logout();
    // Clearing the dotenv entry matters as much as dropping the CLI token: the
    // sync reads `GITHUB_TOKEN` first, so a stale copy would keep it working
    // after the user explicitly signed out.
    upsertEnvVar(path.join(process.cwd(), ".env"), "GITHUB_TOKEN", "");
    console.log("已退出 GitHub 登录（本地凭据与 .env 中的 Token 已清除）。");
    return;
  }

  if (command === "whoami:github") {
    const status = await readGitHubLoginStatus({ ...config.github, log });
    if (!status.loggedIn) {
      console.log("尚未登录 GitHub。运行：npm run cli -- login:github\n");
      if (status.hint) console.log(`提示：${status.hint}`);
      return;
    }
    console.log("已登录 GitHub：\n");
    console.log(`  账号       ${status.login ?? "(未知)"}`);
    console.log(`  授权范围   ${status.scopes.length ? status.scopes.join(", ") : "(未知)"}`);
    console.log(`  凭据来源   ${status.tokenSource ?? "(未知)"}`);
    return;
  }

  if (command === "run") {
    await runAll();
    return;
  }

  if (command === "notify:test") {
    await sendTestNotification();
    return;
  }

  if (command !== "sync" && command !== "publish") {
    fail(`未知命令：${command}\n\n${USAGE}`);
  }

  async function runAll(): Promise<void> {
    const configFile = values.config ?? DEFAULT_SUBSCRIPTIONS_FILE;
    const subscriptions = loadSubscriptions(configFile);
    const authors = activeAuthors(subscriptions);
    if (!authors.length) {
      fail(`订阅文件 ${configFile} 中没有启用任何作者（检查 enabled: true）`);
    }

    log(`=== run（订阅文件 ${configFile}）===\n`);
    log(`启用作者 ${authors.length} 个：${authors.map((a) => a.login).join(", ")}`);
    const started = Date.now();

    const github = createGitHubClient({ token: config.githubToken });
    const model = buildModel();
    const writer = values.local
      ? new LocalFsWriter(path.resolve(values.out ?? "out"), log)
      : new FeishuCliWriter({
          cliPath: config.feishu.cliPath,
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          userToken: config.feishu.userToken,
          log,
        });

    const spaceName = values.space ?? subscriptions.space;
    const spaceId = await writer.ensureSpace(
      spaceName,
      values["space-id"] ?? subscriptions.spaceId ?? config.feishu.spaceId,
      { createIfMissing: values["create-space"] },
    );
    log(`      目标知识库：${spaceId}`);

    const parentNodeToken = values.parent ?? subscriptions.parentNode;
    const result = await runBatch({
      db,
      github,
      writer,
      spaceId,
      authors,
      model,
      parentNodeToken,
      indexParentNodeToken: values["index-parent"] ?? parentNodeToken,
      full: values.full,
      skipClassify: values["no-classify"] || !model,
      // The subscription file is the durable switch; the flag is a one-off
      // override for a run that should skip the board without editing config.
      trending: values["no-trending"] ? false : subscriptions.trending,
      force: values.force,
      log,
    });

    if (values.out) {
      const outDir = path.resolve(values.out);
      await fs.mkdir(outDir, { recursive: true });
      const file = path.join(outDir, "index.md");
      // The rendered landing page, so the CI artifact is readable on its own
      // even when the Feishu write was skipped as unchanged.
      await fs.writeFile(file, result.indexMarkdown, "utf8");
      log(`      已导出汇总 ${file}`);
    }

    if (!values["no-notify"]) {
      // The app channel wins when both are configured: it is the one that needs
      // no webhook to be created and re-pasted whenever it rotates.
      const app = resolveNotifyApp(subscriptions.notifyChat);
      if (app || subscriptions.webhook) {
        if (app) log(`      推送飞书群消息（${subscriptions.notifyChat}）`);
        try {
          await notifyBatchResult(result, {
            ...(app ? { app } : {}),
            webhook: subscriptions.webhook,
            wikiBaseUrl: subscriptions.wikiBaseUrl,
            log,
          });
        } catch (error) {
          // The knowledge base is already updated at this point, and a failed
          // job would also discard the sync cache, turning one broken webhook
          // into a full re-sync the next day. Report it and keep the run green.
          const detail = error instanceof Error ? error.message : String(error);
          log(`      飞书通知失败（不影响本次同步）：${detail}`);
        }
      } else {
        log("      未配置 webhook 或 notify_chat，跳过通知");
      }
    }

    log(`\n完成：新增 ${result.newStars} 个 star，失败 ${result.failed} 个账号`);
    for (const outcome of result.outcomes) {
      const state = outcome.error ? `失败：${outcome.error}` : `${outcome.totalStars} 个仓库`;
      log(`  ${outcome.login.padEnd(24)} ${state}`);
    }
    log(`用时 ${((Date.now() - started) / 1000).toFixed(1)}s`);

    // One broken account should surface as a failed job so GitHub Actions can
    // notify, without hiding that every other author did update.
    if (result.failed) process.exitCode = 1;
  }

  /**
   * Send the money digest on its own.
   *
   * A daily job only proves the channel works once a day, and a full run costs
   * the whole LLM classification budget, so the channel gets its own command.
   */
  async function sendTestNotification(): Promise<void> {
    const subscriptions = loadSubscriptions(values.config ?? DEFAULT_SUBSCRIPTIONS_FILE);
    const app = resolveNotifyApp(subscriptions.notifyChat);
    if (!app && !subscriptions.webhook) {
      fail("订阅文件里既没有 notify_chat 也没有 webhook，无法推送");
    }

    const spaceId = values["space-id"] ?? subscriptions.spaceId ?? config.feishu.spaceId;
    const node = spaceId ? getWikiNode(db, COMMERCIAL_DOC_KEY, spaceId) : undefined;
    const link = node && subscriptions.wikiBaseUrl
      ? `📄 [搞钱项目精选 Top 20](${subscriptions.wikiBaseUrl.replace(/\/+$/, "")}/${node.nodeToken})`
      : "📄 搞钱项目精选 Top 20（知识库文档，首次同步后生成）";

    const card = buildSimpleCard({
      title: "搞钱项目精选 Top 20 · 推送测试",
      template: "blue",
      content: [summarizeCommercialBoard(new Date()), link].join("\n\n"),
    });

    const channel = app ? `应用机器人（${subscriptions.notifyChat}）` : "自定义机器人 webhook";
    log(`      推送到：${channel}`);
    await notifyCard(card, {
      ...(app ? { app } : {}),
      webhook: subscriptions.webhook,
      log,
    });
    log("\n推送完成，去飞书看看是否收到卡片。");
  }

  /** App credentials are only usable as a channel when a target chat is set. */
  function resolveNotifyApp(chatId: string | undefined) {
    if (!chatId || !config.feishu.appId || !config.feishu.appSecret) return undefined;
    return { appId: config.feishu.appId, appSecret: config.feishu.appSecret, chatId };
  }

  function buildModel() {
    if (values["no-classify"]) return undefined;
    if (!config.llm.apiKey) {
      console.warn("警告：未配置 LLM_API_KEY，将跳过分类（等同 --no-classify）\n");
      return undefined;
    }
    return createLanguageModel(config);
  }

  const login = positionals[1];
  if (!login) fail(`请提供 GitHub 账号，例如：npm run cli -- ${command} karpathy`);

  const github = createGitHubClient({ token: config.githubToken });

  // Only build a model when classification is actually requested, so --no-classify
  // works without an API key.
  let model;
  if (!values["no-classify"]) {
    if (!config.llm.apiKey) {
      console.warn("警告：未配置 LLM_API_KEY，将跳过分类（等同 --no-classify）\n");
    } else {
      model = createLanguageModel(config);
    }
  }

  log(`=== ${command} ${login} ===\n`);
  const started = Date.now();

  const result = await syncAuthor({
    db,
    github,
    model,
    login,
    full: values.full,
    skipClassify: values["no-classify"] || !model,
    isSelf: values.self,
    log,
  });

  if (values.out) {
    const outDir = path.resolve(values.out);
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `${login}-stars.md`);
    await fs.writeFile(file, result.markdown, "utf8");
    log(`      已导出 ${file}`);
  }

  if (command === "publish") {
    const spaceName = values.space ?? "GitHub Star 精选";
    const writer = values.local
      ? new LocalFsWriter(path.resolve(values.out ?? "out"), log)
      : new FeishuCliWriter({
          cliPath: config.feishu.cliPath,
          appId: config.feishu.appId,
          appSecret: config.feishu.appSecret,
          userToken: config.feishu.userToken,
          log,
        });

    const spaceId = await writer.ensureSpace(
      spaceName,
      values["space-id"] ?? config.feishu.spaceId,
      { createIfMissing: values["create-space"] },
    );
    log(`      目标知识库：${spaceId}`);

    const title = result.author.isSelf
      ? `我的 Star 精选`
      : `${result.author.login} 的 Star 精选`;

    const published = await publishDocument({
      db,
      writer,
      authorId: result.author.id,
      login: result.author.login,
      spaceId,
      title,
      markdown: result.markdown,
      parentNodeToken: values.parent,
      force: values.force,
      log,
    });

    log(
      published.skipped
        ? `\n完成：内容未变化，已跳过（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`
        : `\n完成：已写入知识库 ${published.nodeToken}（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`,
    );
    return;
  }

  log(`\n完成（用时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
  log(`新增 ${result.newStars} 个 star，累计 ${result.totalStars} 个已整理仓库`);
  for (const [category, count] of Object.entries(result.counts)) {
    log(`  ${category}: ${count}`);
  }
}

main().catch((error: unknown) => {
  if (error instanceof GitHubUserNotFoundError) {
    fail(`找不到 GitHub 账号 ${error.message.replace(/^GitHub user not found: /, "")}，请检查拼写`);
  }
  if (error instanceof GitHubStarsUnavailableError) {
    fail(error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\n失败：${message}`);
  if (error instanceof Error && error.stack) console.error(error.stack);
  process.exit(1);
});
