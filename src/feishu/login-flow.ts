import { FeishuAuth, loginFailureLine, type LoginPrompt } from "./auth.js";
import { formatLoginQrBlock } from "../qr.js";

export interface LoginFlowOptions {
  cliPath: string;
  appId?: string | undefined;
  appSecret?: string | undefined;
  log?: (message: string) => void;
  /** Injected in tests to avoid spawning `feishu-cli`. */
  auth?: FeishuAuth;
}

export interface LoginFlowResult {
  ok: boolean;
  /** True when a new personal app had to be registered first. */
  createdApp: boolean;
  appId: string | null;
  error: string | null;
}

/**
 * Drive the full "you only scan QR codes" onboarding.
 *
 * Step 1 registers a personal Feishu app when the machine has no credentials
 * yet; step 2 asks that app for a user token covering the wiki scopes. Both
 * steps are device flows, so the user's entire job is scanning with the Feishu
 * mobile app - no trip to the open-platform console, and no secret shipped by
 * this project.
 */
export async function runLoginFlow(options: LoginFlowOptions): Promise<LoginFlowResult> {
  const log = options.log ?? (() => {});
  const auth = options.auth ?? new FeishuAuth(options);

  const before = await auth.currentAppId();
  let createdApp = false;

  if (!before) {
    log("尚未检测到飞书应用，先创建属于你自己的个人应用。\n");
    const appStep = auth.createApp((prompt) => log(renderStep(prompt, 1, "创建你的飞书应用")));
    const appResult = await appStep.done;
    if (!appResult.ok) {
      return {
        ok: false,
        createdApp: false,
        appId: null,
        error: appResult.error ?? "创建飞书应用失败",
      };
    }
    createdApp = true;
    log("\n✓ 应用创建成功，已写入 feishu-cli 配置。\n");
  } else {
    log(`检测到已有飞书应用：${before}\n`);
  }

  const loginStep = auth.login({
    onPrompt: (prompt) =>
      log(renderStep(prompt, createdApp ? 2 : 1, "授权访问你的知识库")),
  });
  const loginResult = await loginStep.done;
  if (!loginResult.ok) {
    return {
      ok: false,
      createdApp,
      appId: await auth.currentAppId(),
      error: loginResult.error ?? "飞书授权失败",
    };
  }

  const appId = (await auth.currentAppId()) ?? options.appId ?? null;
  log("✓ 授权成功，已获得用户身份（User Access Token）。\n");
  return { ok: true, createdApp, appId, error: null };
}

function renderStep(prompt: LoginPrompt, step: number, title: string): string {
  const url = prompt.verificationUriComplete ?? prompt.verificationUri;
  if (!url) return `第 ${step} 步：${title}\n  等待 feishu-cli 返回授权链接…`;
  return formatLoginQrBlock({
    title: `第 ${step} 步：${title}`,
    instruction: "请用手机飞书扫描下面的二维码：",
    url,
    userCode: prompt.userCode,
    expiresInSeconds: prompt.expiresInSeconds,
  });
}

export interface LoginStatus {
  loggedIn: boolean;
  appId: string | null;
  userName: string | null;
  scopes: string[];
  hint: string | null;
  /** Empty when the token covers everything the wiki pipeline needs. */
  missingScopes: string[];
}

/**
 * Scopes the wiki write path actually exercises.
 *
 * These are the granted names as reported by `feishu-cli auth check`. Two
 * plausible-looking spellings must NOT be used here: `wiki:wiki` and
 * `docx:document` are not real grants, and `auth check` reports *any* unknown
 * name as missing, so including them made every healthy login look broken.
 */
export const REQUIRED_WIKI_SCOPES = [
  "wiki:space:read",
  "wiki:space:write_only",
  "wiki:node:read",
  "wiki:node:retrieve",
  "wiki:node:create",
  "wiki:node:update",
  "docs:document:import",
];

export async function readLoginStatus(options: LoginFlowOptions): Promise<LoginStatus> {
  const auth = options.auth ?? new FeishuAuth(options);
  const state = await auth.status();
  const check = state.loggedIn
    ? await auth.checkScopes(REQUIRED_WIKI_SCOPES)
    : { ok: false, missing: [] };

  return {
    loggedIn: state.loggedIn,
    appId: state.appId ?? (await auth.currentAppId()),
    userName: state.userName ?? (state.loggedIn ? await readUserName(auth) : null),
    scopes: state.scopes,
    hint: state.hint,
    // Not logged in means "no token", not "missing permissions", so the list
    // stays empty there. Once a token exists, an older CLI can report a scope
    // failure without naming the culprits; echoing the required set keeps the
    // warning actionable instead of a bare "缺少权限：" with nothing after it.
    missingScopes:
      !state.loggedIn || check.ok
        ? []
        : check.missing.length
          ? check.missing
          : REQUIRED_WIKI_SCOPES,
  };
}

/**
 * Best-effort account name for the status line.
 *
 * Only `authen/v1/user_info` carries it, and a failure there must not turn a
 * working login into "未登录": the name is a label on the options page, not a
 * permission the sync path needs.
 */
async function readUserName(auth: FeishuAuth): Promise<string | null> {
  try {
    return await auth.userName();
  } catch {
    return null;
  }
}

/** Render the friendly "run login first" message used by the sync path. */
export function describeLoginRequired(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/未登录|not_logged_in|token_expired|缺少 app_id|缺少 app_secret/.test(message)) {
    return "尚未登录飞书。请先运行 `npm run cli -- login`，用手机飞书扫码授权。";
  }
  const line = loginFailureLine(message);
  return line ? `${line}（可运行 npm run cli -- login 重新授权）` : null;
}

/**
 * Caches `auth status` so the health endpoint stays cheap.
 *
 * Every probe spawns a `feishu-cli` process (hundreds of milliseconds), and the
 * options page polls health on each open, so results are reused for a while.
 */
export class LoginStatusCache {
  private cached: { value: LoginStatus; at: number } | null = null;
  private inFlight: Promise<LoginStatus> | null = null;

  constructor(
    private readonly options: LoginFlowOptions,
    private readonly ttlMs = 15_000,
  ) {}

  /** Drop the cached value, e.g. right after a successful login. */
  invalidate(): void {
    this.cached = null;
  }

  async get(now = Date.now()): Promise<LoginStatus> {
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.value;
    if (this.inFlight) return this.inFlight;

    const startedAt = now;
    // A missing or broken CLI must not turn /api/health into a 500: the whole
    // point of that endpoint is to tell the user what is misconfigured.
    this.inFlight = readLoginStatus(this.options)
      .catch((error: unknown) => anonymousStatus(error))
      .then((value) => {
        this.cached = { value, at: startedAt };
        this.inFlight = null;
        return value;
      });
    return this.inFlight;
  }
}

function anonymousStatus(error: unknown): LoginStatus {
  return {
    loggedIn: false,
    appId: null,
    userName: null,
    scopes: [],
    hint: error instanceof Error ? error.message : String(error),
    missingScopes: [],
  };
}
