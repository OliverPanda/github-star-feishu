import path from "node:path";
import type { LanguageModel } from "ai";
import type { AppConfig } from "./config.js";
import type { Db } from "./db/client.js";
import type { SyncRunAuthor } from "./db/schema.js";
import { FeishuCliWriter } from "./feishu/cli.js";
import { LocalFsWriter } from "./feishu/local.js";
import type { WikiWriter } from "./feishu/types.js";
import { createGitHubClient } from "./github/client.js";
import { createLanguageModel } from "./llm/provider.js";
import { runBatch, type BatchResult } from "./batch.js";
import {
  finishSyncRun,
  getSetting,
  listSubscriptions,
  setSetting,
  startSyncRun,
  upsertSubscription,
} from "./store.js";
import type { Subscription, Subscriptions } from "./subscriptions.js";

/** Settings keys that hold the non-author half of a subscription document. */
export const SETTING_KEYS = {
  space: "space",
  spaceId: "space_id",
  parentNode: "parent_node",
  wikiBaseUrl: "wiki_url_base",
  webhook: "webhook",
  notifyChat: "notify_chat",
  trending: "trending",
} as const;

/**
 * Read the subscriptions the API serves. The YAML file remains the CI entry
 * point, but the extension needs to add and remove authors, which a
 * hand-edited file cannot support; both ultimately feed the same batch runner.
 */
export function subscriptionsFromDb(db: Db): Subscriptions {
  const authors: Subscription[] = listSubscriptions(db).map((row) => ({
    login: row.login,
    alias: row.alias ?? undefined,
    self: row.isSelf,
    enabled: row.enabled,
  }));

  return {
    space: getSetting(db, SETTING_KEYS.space) ?? "GitHub Star 精选",
    spaceId: getSetting(db, SETTING_KEYS.spaceId),
    parentNode: getSetting(db, SETTING_KEYS.parentNode),
    wikiBaseUrl: getSetting(db, SETTING_KEYS.wikiBaseUrl),
    webhook: getSetting(db, SETTING_KEYS.webhook),
    notifyChat: getSetting(db, SETTING_KEYS.notifyChat),
    trending: readTrendingSetting(db),
    authors,
  };
}

/**
 * The trending switch, defaulting to on.
 *
 * Stored as a string because the settings table holds free-form text, and
 * anything other than an explicit "false" keeps the board enabled — a missing
 * or hand-edited row should not silently drop a whole page.
 */
function readTrendingSetting(db: Db): boolean {
  return getSetting(db, SETTING_KEYS.trending)?.trim().toLowerCase() !== "false";
}

/**
 * Copy a YAML subscription document into the database so a deployment can be
 * bootstrapped from the file and then edited from the extension. Existing rows
 * are updated rather than replaced, so nothing added through the UI is lost.
 */
export function seedSubscriptions(db: Db, subscriptions: Subscriptions): number {
  let imported = 0;
  for (const author of subscriptions.authors) {
    upsertSubscription(db, {
      login: author.login,
      alias: author.alias ?? null,
      isSelf: author.self,
      enabled: author.enabled,
    });
    imported += 1;
  }

  setSetting(db, SETTING_KEYS.space, subscriptions.space);
  if (subscriptions.spaceId) setSetting(db, SETTING_KEYS.spaceId, subscriptions.spaceId);
  if (subscriptions.parentNode) setSetting(db, SETTING_KEYS.parentNode, subscriptions.parentNode);
  if (subscriptions.wikiBaseUrl) setSetting(db, SETTING_KEYS.wikiBaseUrl, subscriptions.wikiBaseUrl);
  if (subscriptions.webhook) setSetting(db, SETTING_KEYS.webhook, subscriptions.webhook);
  if (subscriptions.notifyChat) setSetting(db, SETTING_KEYS.notifyChat, subscriptions.notifyChat);
  setSetting(db, SETTING_KEYS.trending, subscriptions.trending ? "true" : "false");

  return imported;
}

export interface WriterOptions {
  local?: boolean;
  /** Directory used by the filesystem writer for a dry run. */
  outDir?: string;
  log?: (message: string) => void;
}

export function createWriter(config: AppConfig, options: WriterOptions = {}): WikiWriter {
  if (options.local) {
    return new LocalFsWriter(path.resolve(options.outDir ?? "out"), options.log);
  }
  return new FeishuCliWriter({
    cliPath: config.feishu.cliPath,
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
    userToken: config.feishu.userToken,
    log: options.log,
  });
}

export interface SyncServiceOptions {
  db: Db;
  config: AppConfig;
  subscriptions: Subscriptions;
  /** Restricts the run to these logins; defaults to every enabled author. */
  logins?: string[] | undefined;
  writer?: WikiWriter | undefined;
  local?: boolean;
  outDir?: string;
  /** Overrides the space named in the subscription document. */
  space?: string | undefined;
  spaceId?: string | undefined;
  /**
   * Create the knowledge base when no existing one matches the name.
   *
   * Off by default: the signed-in user usually already owns the space their
   * stars belong in, and creating one implicitly is how a tenant ends up with
   * several identically named spaces each holding part of the content.
   */
  createSpaceIfMissing?: boolean | undefined;
  parentNodeToken?: string | undefined;
  indexParentNodeToken?: string | undefined;
  full?: boolean;
  /** Skips both the LLM call and the API-key warning. */
  skipClassify?: boolean;
  /** Overrides the trending-board switch from the subscription document. */
  trending?: boolean | undefined;
  /** How this run was started, recorded for the status panel. */
  trigger?: string;
  model?: LanguageModel | undefined;
  log?: (message: string) => void;
}

export interface SyncServiceResult extends BatchResult {
  runId: number;
  /** Authors that were skipped because the caller asked for other logins. */
  skipped: string[];
}

/**
 * Run one batch and record it in `sync_runs`.
 *
 * Both the CLI and the API go through here so that a scheduled run and a
 * button press are indistinguishable afterwards, which is what makes the
 * status panel trustworthy.
 */
export async function runSync(options: SyncServiceOptions): Promise<SyncServiceResult> {
  const {
    db,
    config,
    subscriptions,
    logins,
    local = false,
    outDir,
    space,
    spaceId: spaceIdOverride,
    parentNodeToken: parentOverride,
    indexParentNodeToken,
    full = false,
    skipClassify = false,
    trending,
    trigger = "cli",
    log = () => {},
  } = options;

  const wanted = logins?.map((login) => login.toLowerCase());
  const enabled = subscriptions.authors.filter((author) => author.enabled);
  const authors = wanted
    ? enabled.filter((author) => wanted.includes(author.login.toLowerCase()))
    : enabled;
  const skipped = enabled
    .filter((author) => !authors.includes(author))
    .map((author) => author.login);

  const model = options.model ?? buildModel(config, skipClassify, log);
  const writer = options.writer ?? createWriter(config, { local, outDir, log });

  const spaceName = space ?? subscriptions.space;
  const resolvedSpaceId = await writer.ensureSpace(
    spaceName,
    spaceIdOverride ?? subscriptions.spaceId ?? config.feishu.spaceId,
    { createIfMissing: options.createSpaceIfMissing ?? false },
  );
  log(`      目标知识库：${resolvedSpaceId}`);

  const parentNodeToken = parentOverride ?? subscriptions.parentNode;
  const runId = startSyncRun(db, { trigger, totalAuthors: authors.length });

  try {
    const result = await runBatch({
      db,
      // Environment first: a QR scan writes the token into `.env` (and into
      // `process.env`) while this service is already running, so a snapshot
      // taken at startup would ignore the login the user just performed.
      github: createGitHubClient({
        token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || config.githubToken,
      }),
      writer,
      spaceId: resolvedSpaceId,
      authors,
      model,
      parentNodeToken,
      indexParentNodeToken: indexParentNodeToken ?? parentNodeToken,
      full,
      skipClassify: skipClassify || !model,
      trending: trending ?? subscriptions.trending,
      log,
    });

    finishSyncRun(db, runId, {
      status: runStatus(result, authors.length),
      newStars: result.newStars,
      failedAuthors: result.failed,
      authors: result.outcomes.map(toRunAuthor),
    });

    return { ...result, runId, skipped };
  } catch (error) {
    // A throw here means the batch itself fell over (space missing, writer
    // unreachable), which must be recorded before it propagates.
    finishSyncRun(db, runId, {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

function runStatus(result: BatchResult, totalAuthors: number): string {
  if (!totalAuthors) return "success";
  if (!result.failed) return "success";
  return result.failed >= totalAuthors ? "failed" : "partial";
}

function toRunAuthor(outcome: BatchResult["outcomes"][number]): SyncRunAuthor {
  return {
    login: outcome.login,
    newStars: outcome.newStars,
    totalStars: outcome.totalStars,
    unchanged: outcome.unchanged,
    error: outcome.error,
  };
}

/**
 * Build the classifier only when classification was actually requested, so a
 * credential-free environment can still run with `--no-classify`.
 */
export function buildModel(
  config: AppConfig,
  skipClassify: boolean,
  log: (message: string) => void = () => {},
): LanguageModel | undefined {
  if (skipClassify) return undefined;
  if (!config.llm.apiKey) {
    log("警告：未配置 LLM_API_KEY，将跳过分类（等同 --no-classify）\n");
    return undefined;
  }
  return createLanguageModel(config);
}
