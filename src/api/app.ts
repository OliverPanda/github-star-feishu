import path from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { createGitHubClient } from "../github/client.js";
import {
  GitHubLoginStatusCache,
  describeGitHubLoginRequired,
} from "../github/login-flow.js";
import { GitHubLoginManager } from "../github/login-session.js";
import { fetchAuthorProfile } from "../github/stars.js";
import type { AuthorProfile } from "../github/stars.js";
import { GitHubStarsUnavailableError, GitHubUserNotFoundError } from "../github/stars.js";
import { FeishuLoginManager } from "../feishu/login-session.js";
import { describeLoginRequired, LoginStatusCache } from "../feishu/login-flow.js";
import type { SpaceSummary } from "../feishu/types.js";
import { buildAuthorLibrary } from "../library.js";
import { buildRosterView } from "../roster-view.js";
import { createWriter, runSync, SETTING_KEYS, subscriptionsFromDb } from "../service.js";
import type { Subscription, Subscriptions } from "../subscriptions.js";
import { readTrendingSnapshot, type TrendingSince } from "../trending-board.js";
import { readWeeklyMoneySnapshot } from "../weekly-money.js";
import { SyncBusyError } from "../scheduler.js";
import {
  deleteSubscription,
  getAuthorSyncSummary,
  getRepoEndorsements,
  getSubscription,
  getSetting,
  listTrackedLogins,
  listSubscriptions,
  listSyncRuns,
  setSetting,
  upsertAuthor,
  upsertSubscription,
} from "../store.js";

export interface ApiOptions {
  db: Db;
  config: AppConfig;
  /** Called for each run; injected by the server entry point. */
  log?: (message: string) => void;
  /**
   * Resolves a login to a GitHub profile. Injected so tests can exercise the
   * routes without standing up Octokit's HTTP transport.
   */
  verifyLogin?: (login: string) => Promise<AuthorProfile>;
  /** Sync entry point; injected so route tests avoid real network and Feishu. */
  runner?: typeof runSync;
  /**
   * Feishu device-flow sessions. Injected so route tests never spawn the CLI;
   * the server entry point leaves it undefined and gets a real manager.
   */
  feishuLogin?: FeishuLoginManager;
  /** Cached `auth status` probe backing the health endpoint. */
  loginStatus?: LoginStatusCache;
  /**
   * GitHub device-flow sessions. Injected so route tests never spawn `gh`; the
   * server entry point leaves it undefined and gets a real manager.
   */
  githubLogin?: GitHubLoginManager;
  /** Cached `gh auth status` probe backing the health endpoint. */
  githubStatus?: GitHubLoginStatusCache;
  /** Knowledge-base listing; injected so route tests never spawn the CLI. */
  listSpaces?: () => Promise<SpaceSummary[]>;
}

const SubscriptionInput = z.object({
  login: z
    .string()
    .trim()
    .min(1, "login 不能为空")
    // Mirrors GitHub's own rule, so an invalid login fails here rather than
    // burning an API call and surfacing as a confusing "user not found".
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/, "不是合法的 GitHub 用户名"),
  alias: z.string().trim().min(1).nullish(),
  isSelf: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

const RunInput = z.object({
  /** Optional subset; omitted means every enabled author. */
  logins: z.array(z.string().trim().min(1)).min(1).optional(),
  full: z.boolean().optional(),
  skipClassify: z.boolean().optional(),
  local: z.boolean().optional(),
  /**
   * Allows logins that are not subscriptions, for the recommendation list's
   * "一键整理" button. Such an author is synced without being subscribed, so a
   * one-off整理 does not silently change what the daily run covers.
   */
  allowUnsubscribed: z.boolean().optional(),
});

/**
 * The knowledge base the sync writes into. `name` is optional so a caller that
 * only knows the id does not wipe the human-readable label.
 */
const TargetInput = z.object({
  spaceId: z.string().trim().min(1, "space_id 不能为空"),
  name: z.string().trim().min(1).optional(),
  parentNodeToken: z.string().trim().min(1).nullish(),
});

/**
 * Partial by design: the extension sends only the field being changed, so a
 * pause toggle cannot accidentally clear an alias it never displayed.
 */
const SubscriptionPatch = z.object({
  alias: z.string().trim().min(1).nullable().optional(),
  isSelf: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

/**
 * JSON API behind the browser extension.
 *
 * A shared bearer token is the whole auth model: the service is meant to run on
 * localhost or a private host next to the database, so full OAuth would add
 * moving parts without changing who can reach it.
 */
export function createApi(options: ApiOptions): Hono {
  const { db, config, log = () => {} } = options;
  // `config` is a snapshot taken at startup, but the scan-to-login flow writes a
  // freshly obtained token into `.env` while the service keeps running. Reading
  // the environment first means a token pasted by hand and one captured by a QR
  // scan both take effect without a restart.
  const githubToken = () => process.env.GITHUB_TOKEN || process.env.GH_TOKEN || config.githubToken;
  const verifyLogin =
    options.verifyLogin ??
    ((login: string) => fetchAuthorProfile(createGitHubClient({ token: githubToken() }), login));
  const runner = options.runner ?? runSync;
  const feishuLogin = options.feishuLogin ?? new FeishuLoginManager({ ...config.feishu, log });
  const loginStatus = options.loginStatus ?? new LoginStatusCache({ ...config.feishu, log });
  const githubLogin =
    options.githubLogin ??
    new GitHubLoginManager({
      ...config.github,
      envFile: path.join(process.cwd(), ".env"),
      log,
    });
  const githubStatus =
    options.githubStatus ?? new GitHubLoginStatusCache({ ...config.github, log });
  // The signed-in user picks a knowledge base once and every later sync reuses
  // it; listing needs a user identity, so it goes through the same CLI writer
  // the sync itself uses.
  const listSpaces =
    options.listSpaces ??
    (() => createWriter(config, { log }).listSpaces?.() ?? Promise.resolve([]));
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "Authorization"] }));

  // Declared before every route so no handler can end up outside the check:
  // Hono only applies a middleware to routes registered after it, and a route
  // placed above this line would be served to anyone who can reach the port.
  app.use("/api/*", async (c, next) => {
    if (!config.api.token) {
      return c.json({ error: "服务端未配置 API_TOKEN，拒绝服务" }, 500);
    }
    const header = c.req.header("Authorization") ?? "";
    if (header !== `Bearer ${config.api.token}`) {
      return c.json({ error: "未授权" }, 401);
    }
    await next();
  });

  // Readiness means "a credential is usable", not "a value exists in .env": the
  // whole point of the QR onboarding is that nothing is configured by hand, and
  // a token obtained by scanning is equally usable. Each probe is cached, so
  // polling this endpoint does not spawn a CLI process per request.
  //
  // It names the signed-in accounts and their scopes, so it sits behind the
  // bearer token like every other route. The options page already sends one.
  app.get("/api/health", async (c) => {
    const [status, gh] = await Promise.all([loginStatus.get(), githubStatus.get()]);
    return c.json({
      ok: true,
      github: gh.loggedIn || Boolean(githubToken()),
      githubUser: gh.login,
      githubScopes: gh.scopes,
      githubHint: gh.hint,
      llm: Boolean(config.llm.apiKey),
      feishu: status.loggedIn,
      feishuAppId: status.appId,
      feishuUser: status.userName,
      feishuScopes: status.scopes,
      feishuMissingScopes: status.missingScopes,
    });
  });

  app.get("/api/subscriptions", (c) => c.json({ subscriptions: listSubscriptionViews(db) }));

  app.post("/api/subscriptions", async (c) => {
    const body = SubscriptionInput.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: firstIssue(body.error) }, 400);

    // Verified against GitHub before saving so a typo cannot silently occupy a
    // subscription slot and fail on every later scheduled run.
    try {
      const profile = await verifyLogin(body.data.login);
      // Caching the verified profile means the extension shows real numbers
      // right after adding an author, before the first sync has run.
      upsertAuthor(db, profile, body.data.isSelf ?? false);
      const saved = upsertSubscription(db, {
        login: profile.login,
        alias: body.data.alias ?? null,
        isSelf: body.data.isSelf ?? false,
        enabled: body.data.enabled ?? true,
      });
      log(`添加订阅 ${saved.login}（${profile.starredCount} stars）`);
      return c.json({ subscription: decorate(db, saved) }, 201);
    } catch (error) {
      return c.json({ error: describeGitHubError(error, body.data.login) }, 400);
    }
  });

  app.delete("/api/subscriptions/:login", (c) => {
    const removed = deleteSubscription(db, c.req.param("login"));
    if (!removed) return c.json({ error: "该订阅不存在" }, 404);
    return c.json({ removed });
  });

  // Pausing or renaming an existing subscription must not re-verify against
  // GitHub: the account was already validated when it was added, and a toggle
  // should keep working even while rate-limited or offline.
  app.patch("/api/subscriptions/:login", async (c) => {
    const login = c.req.param("login");
    const existing = getSubscription(db, login);
    if (!existing) return c.json({ error: "该订阅不存在" }, 404);

    const body = SubscriptionPatch.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: firstIssue(body.error) }, 400);

    const saved = upsertSubscription(db, {
      login: existing.login,
      alias: body.data.alias === undefined ? existing.alias : body.data.alias,
      isSelf: body.data.isSelf ?? existing.isSelf,
      enabled: body.data.enabled ?? existing.enabled,
    });
    return c.json({ subscription: decorate(db, saved) });
  });

  app.get("/api/repos/:owner/:name/endorsements", (c) => {
    const fullName = `${c.req.param("owner")}/${c.req.param("name")}`;
    const result = getRepoEndorsements(db, fullName);
    return c.json({
      fullName,
      tracked: Boolean(result),
      endorsements: result?.endorsements ?? [],
      stars: result?.stars ?? null,
      language: result?.language ?? null,
    });
  });

  // Answers "show me what this author starred, grouped by money track" without
  // leaving the extension. The same grouping backs the Feishu document, so the
  // page and the wiki cannot disagree about which folder a repo belongs to.
  app.get("/api/authors/:login/stars", (c) => {
    const login = c.req.param("login");
    const library = buildAuthorLibrary(db, login);
    if (!library) {
      return c.json({ error: `还没有 ${login} 的数据，请先添加订阅并同步一次` }, 404);
    }
    return c.json({ author: library });
  });

  app.get("/api/runs", (c) => c.json({ runs: listSyncRuns(db) }));

  // Onboarding is two scans at most: register the user's personal app, then
  // grant it wiki access. Both steps are device flows, so the service holds the
  // process open and the options page just polls for the QR code.
  app.post("/api/feishu/login", async (c) => {
    const session = await feishuLogin.start();
    log(`飞书登录会话已创建：${session.id}（步骤 ${session.step}）`);
    return c.json({ session }, 201);
  });

  app.get("/api/feishu/login/:id", (c) => {
    const session = feishuLogin.get(c.req.param("id"));
    if (!session) return c.json({ error: "登录会话不存在或已过期" }, 404);
    return c.json({ session });
  });

  app.get("/api/feishu/login", (c) => c.json({ session: feishuLogin.latest() }));

  app.delete("/api/feishu/login/:id", (c) => {
    const cancelled = feishuLogin.cancel(c.req.param("id"));
    if (!cancelled) return c.json({ error: "登录会话不存在或已结束" }, 404);
    return c.json({ cancelled: true });
  });

  app.get("/api/feishu/status", async (c) => {
    loginStatus.invalidate();
    return c.json(await loginStatus.get());
  });

  app.post("/api/feishu/logout", async (c) => {
    await feishuLogin.logout();
    loginStatus.invalidate();
    return c.json({ loggedOut: true });
  });

  // GitHub needs a single scan: it already has a device flow, so there is no
  // personal app to register first. The token the CLI stores is copied into
  // `.env`, which is what the sync reads on every later run.
  app.post("/api/github/login", (c) => {
    const session = githubLogin.start();
    log(`GitHub 登录会话已创建：${session.id}`);
    return c.json({ session }, 201);
  });

  app.get("/api/github/login/:id", (c) => {
    const session = githubLogin.get(c.req.param("id"));
    if (!session) return c.json({ error: "登录会话不存在或已过期" }, 404);
    return c.json({ session });
  });

  app.get("/api/github/login", (c) => c.json({ session: githubLogin.latest() }));

  app.delete("/api/github/login/:id", (c) => {
    const cancelled = githubLogin.cancel(c.req.param("id"));
    if (!cancelled) return c.json({ error: "登录会话不存在或已结束" }, 404);
    return c.json({ cancelled: true });
  });

  app.get("/api/github/status", async (c) => {
    githubStatus.invalidate();
    return c.json(await githubStatus.get());
  });

  app.post("/api/github/logout", async (c) => {
    await githubLogin.logout();
    githubStatus.invalidate();
    return c.json({ loggedOut: true });
  });

  // The picker in the extension reads these, so an existing knowledge base can
  // be chosen instead of letting each sync invent a new one.
  app.get("/api/feishu/spaces", async (c) => {
    try {
      return c.json({ spaces: await listSpaces() });
    } catch (error) {
      const hint = describeLoginRequired(error);
      if (hint) return c.json({ error: hint }, 401);
      throw error;
    }
  });

  app.get("/api/feishu/target", (c) =>
    c.json({
      spaceId: getSetting(db, SETTING_KEYS.spaceId) ?? null,
      space: getSetting(db, SETTING_KEYS.space) ?? null,
    }),
  );

  /**
   * Remember which knowledge base to sync into.
   *
   * Stored as a setting rather than passed on every run so a scheduled sync and
   * a button press land in the same place.
   */
  app.post("/api/feishu/target", async (c) => {
    const body = TargetInput.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: firstIssue(body.error) }, 400);

    setSetting(db, SETTING_KEYS.spaceId, body.data.spaceId);
    if (body.data.name) setSetting(db, SETTING_KEYS.space, body.data.name);
    if (body.data.parentNodeToken !== undefined) {
      setSetting(db, SETTING_KEYS.parentNode, body.data.parentNodeToken ?? "");
    }
    log(`飞书同步目标已设为 ${body.data.name ?? body.data.spaceId}`);

    return c.json({
      spaceId: body.data.spaceId,
      space: body.data.name ?? getSetting(db, SETTING_KEYS.space) ?? null,
    });
  });

  app.post("/api/runs", async (c) => {
    const body = RunInput.safeParse(await readJson(c));
    if (!body.success) return c.json({ error: firstIssue(body.error) }, 400);

    const stored = subscriptionsFromDb(db);
    const enabled = stored.authors.filter((author) => author.enabled);
    if (!enabled.length && !body.data.allowUnsubscribed) {
      return c.json({ error: "还没有任何启用中的订阅" }, 400);
    }

    // Recommended accounts can be整理 without being subscribed, so any
    // requested login that has no row is added as a temporary enabled author.
    // `runSync` only ever looks at enabled authors, so this is enough to let it
    // through without writing a subscription the user never asked for.
    const subscriptions = body.data.allowUnsubscribed
      ? withTemporaryAuthors(stored, body.data.logins ?? [])
      : stored;

    let result: Awaited<ReturnType<typeof runSync>>;
    try {
      result = await runner({
        db,
        config,
        subscriptions,
        logins: body.data.logins,
        full: body.data.full,
        skipClassify: body.data.skipClassify,
        local: body.data.local,
        trigger: "api",
        log,
      });
    } catch (error) {
      // "Not signed in yet" is the expected first-run failure, and the raw CLI
      // message tells the user nothing about scanning a QR code.
      // Either provider can be the missing one, so both hints are consulted; a
      // null answer from one simply means the failure is not its business.
      const loginHint = body.data.local
        ? null
        : (describeLoginRequired(error) ?? describeGitHubLoginRequired(error));
      if (loginHint) return c.json({ error: loginHint }, 401);
      throw error;
    }

    return c.json({
      runId: result.runId,
      spaceId: result.spaceId,
      newStars: result.newStars,
      failed: result.failed,
      skipped: result.skipped,
      outcomes: result.outcomes,
    });
  });

  /**
   * The curated recommendation list.
   *
   * Served from a checked-in roster rather than from GitHub so the page opens
   * instantly and does not burn API quota; the per-entry numbers are enriched
   * with whatever the database already knows.
   */
  app.get("/api/roster", (c) => {
    const tracked = new Set(listTrackedLogins(db).map((login) => login.toLowerCase()));
    return c.json({
      authors: buildRosterView(db, (login) => tracked.has(login.toLowerCase())),
    });
  });

  /**
   * Today's GitHub trending board, most-gained first.
   *
   * Served from the copy the daily sync cached rather than scraped per request:
   * the page is HTML with no API behind it, and a page load must not depend on
   * github.com answering — nor hammer it once per open. An empty cache is a
   * normal first-run state and is reported as an empty board, not an error.
   */
  app.get("/api/trending", (c) => {
    const snapshot = readTrendingSnapshot(db);
    return c.json({
      generatedAt: snapshot?.generatedAt ?? null,
      since: (snapshot?.since ?? "daily") satisfies TrendingSince,
      repos: snapshot?.repos ?? [],
      rows: snapshot?.rows ?? [],
    });
  });

  /**
   * Latest weekly editorial report.
   *
   * The report is generated once per Monday-Sunday period during a sync and
   * cached in SQLite. Serving the snapshot keeps the extension page fast and
   * makes the page show exactly the same ten picks that were pushed to Feishu.
   */
  app.get("/api/weekly-money", (c) => {
    const snapshot = readWeeklyMoneySnapshot(db);
    return c.json({
      generatedAt: snapshot?.report.generatedAt ?? null,
      period: snapshot?.report.period ?? null,
      candidateCount: snapshot?.report.candidateCount ?? 0,
      fallbackCount: snapshot?.report.fallbackCount ?? 0,
      methodology: snapshot?.report.methodology ?? "",
      picks: snapshot?.report.picks ?? [],
      pushedAt: snapshot?.pushedAt ?? null,
    });
  });

  app.onError((error, c) => {
    if (error instanceof SyncBusyError) return c.json({ error: error.message }, 409);
    log(`API 错误：${error instanceof Error ? error.message : String(error)}`);
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500);
  });

  return app;
}

function listSubscriptionViews(db: Db) {
  return listSubscriptions(db).map((row) => decorate(db, row));
}

/**
 * Add one-off authors the caller asked to整理 but never subscribed to.
 *
 * Existing rows are left untouched so a subscription's alias and self flag
 * still win; only logins with no row at all are appended.
 */
function withTemporaryAuthors(
  subscriptions: Subscriptions,
  logins: string[],
): Subscriptions {
  const known = new Set(subscriptions.authors.map((author) => author.login.toLowerCase()));
  const extra: Subscription[] = [];

  for (const login of logins) {
    const trimmed = login.trim();
    if (!trimmed || known.has(trimmed.toLowerCase())) continue;
    known.add(trimmed.toLowerCase());
    extra.push({ login: trimmed, alias: undefined, self: false, enabled: true });
  }

  return extra.length
    ? { ...subscriptions, authors: [...subscriptions.authors, ...extra] }
    : subscriptions;
}

/** Adds the sync-derived numbers the extension shows next to each author. */
function decorate(db: Db, row: { login: string; alias: string | null; isSelf: boolean; enabled: boolean }) {
  const summary = getAuthorSyncSummary(db, row.login);
  return {
    login: row.login,
    alias: row.alias,
    isSelf: row.isSelf,
    enabled: row.enabled,
    followers: summary?.followers ?? null,
    starredCount: summary?.starredCount ?? null,
    syncedRepos: summary?.syncedRepos ?? 0,
    lastSyncedAt: summary?.lastSyncedAt ?? null,
  };
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "请求参数不合法";
  const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

function describeGitHubError(error: unknown, login: string): string {
  if (error instanceof GitHubUserNotFoundError) return `找不到 GitHub 账号 ${login}`;
  if (error instanceof GitHubStarsUnavailableError) {
    return `${login} 未公开 star 列表，无法整理`;
  }
  return error instanceof Error ? error.message : String(error);
}
