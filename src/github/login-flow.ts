import { upsertEnvVar } from "../config.js";
import { formatLoginQrBlock } from "../qr.js";
import { GitHubAuth, loginFailureLine, type LoginPrompt } from "./auth.js";

export interface GitHubLoginFlowOptions {
  cliPath: string;
  configDir: string;
  /** When set, the token captured by a successful scan is written here. */
  envFile?: string;
  log?: (message: string) => void;
  /** Injected in tests to avoid spawning `gh`. */
  auth?: GitHubAuth;
}

export interface GitHubLoginFlowResult {
  ok: boolean;
  /** GitHub login of the account that was authorized. */
  login: string | null;
  error: string | null;
}

/**
 * Drive the one-and-only GitHub scan step.
 *
 * GitHub already ships a device flow, so there is nothing to register first:
 * `gh auth login --web` prints a one-time code, the user approves it in a
 * browser, and the CLI stores the token in its own config directory. The whole
 * onboarding is therefore a single QR code, with no app console in between.
 */
export async function runGitHubLoginFlow(
  options: GitHubLoginFlowOptions,
): Promise<GitHubLoginFlowResult> {
  const log = options.log ?? (() => {});
  const auth = options.auth ?? new GitHubAuth(options);

  const step = auth.login((prompt) => log(renderStep(prompt)));
  const result = await step.done;
  if (!result.ok) {
    return { ok: false, login: null, error: result.error ?? "GitHub 授权失败" };
  }

  // Exiting 0 only means the process finished. The account name comes from the
  // status probe so a flow that ended without storing a usable token is
  // reported as the failure it is, not as a success.
  const state = await auth.status();
  if (!state.loggedIn) {
    return {
      ok: false,
      login: null,
      error: state.hint ?? "授权未生效，请重新扫码登录",
    };
  }

  // The token is the part the sync actually spends, and it is what makes the
  // whole flow self-serve: copying it into `.env` here means the user never has
  // to open GitHub's settings page and paste a PAT by hand.
  if (options.envFile) {
    const token = await persistGitHubToken(auth, options.envFile);
    if (!token) return { ok: false, login: state.login, error: "未能读取 gh 保存的 Token" };
    log(`  Token 已写入 ${options.envFile}\n`);
  }

  log(`✓ 授权成功，已登录 GitHub${state.login ? `：${state.login}` : ""}。\n`);
  return { ok: true, login: state.login, error: null };
}

/**
 * Copy the stored token into a dotenv file, returning what was written.
 *
 * Shared with the service's login manager so both entry points agree on where
 * the token lives rather than drifting into two slightly different writes.
 */
export async function persistGitHubToken(
  auth: GitHubAuth,
  envFile: string,
): Promise<string | null> {
  const token = await auth.token();
  if (!token) return null;
  upsertEnvVar(envFile, "GITHUB_TOKEN", token);
  return token;
}

/**
 * The browser link is shown next to the code rather than encoded into it:
 * GitHub's device URL ignores a `user_code` parameter and would drop the user
 * on the sign-in page instead of the approval page.
 */
function renderStep(prompt: LoginPrompt): string {
  const url = prompt.verificationUriComplete ?? prompt.verificationUri;
  if (!url) return "等待 gh 返回设备码…";
  return formatLoginQrBlock({
    title: "扫码登录 GitHub",
    instruction: "用手机相机扫描下面的二维码（会打开 GitHub 授权页）：",
    url,
    userCode: prompt.userCode,
    expiresInSeconds: prompt.expiresInSeconds,
    scanHint: "  在浏览器打开上面的链接，输入设备码后点 Authorize 即可。",
  });
}

export interface GitHubLoginStatus {
  loggedIn: boolean;
  login: string | null;
  scopes: string[];
  tokenSource: string | null;
  hint: string | null;
}

export async function readGitHubLoginStatus(
  options: GitHubLoginFlowOptions,
): Promise<GitHubLoginStatus> {
  const auth = options.auth ?? new GitHubAuth(options);
  const state = await auth.status();
  return {
    loggedIn: state.loggedIn,
    login: state.login,
    scopes: state.scopes,
    tokenSource: state.tokenSource,
    hint: state.hint,
  };
}

/**
 * Render the friendly "sign in first" message used by the sync path.
 *
 * Returns null when the error has nothing to do with GitHub auth, so callers
 * can fall back to the raw message instead of blaming a login that is fine.
 */
export function describeGitHubLoginRequired(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (/未配置|GITHUB_TOKEN|GH_TOKEN|Bad credentials|401/.test(message)) {
    return "尚未配置 GitHub 访问凭据。请运行 `npm run cli -- login:github` 扫码登录，或在 .env 里设置 GITHUB_TOKEN。";
  }
  const line = loginFailureLine(message);
  return line ? `${line}（可运行 npm run cli -- login:github 重新授权）` : null;
}

/**
 * Caches `gh auth status` so the health endpoint stays cheap.
 *
 * Every probe spawns a `gh` process (and on Windows that is a few hundred
 * milliseconds), while the options page polls health on each open.
 */
export class GitHubLoginStatusCache {
  private cached: { value: GitHubLoginStatus; at: number } | null = null;
  private inFlight: Promise<GitHubLoginStatus> | null = null;

  constructor(
    private readonly options: GitHubLoginFlowOptions,
    private readonly ttlMs = 15_000,
  ) {}

  /** Drop the cached value, e.g. right after a successful login. */
  invalidate(): void {
    this.cached = null;
  }

  async get(now = Date.now()): Promise<GitHubLoginStatus> {
    if (this.cached && now - this.cached.at < this.ttlMs) return this.cached.value;
    if (this.inFlight) return this.inFlight;

    const startedAt = now;
    // A missing `gh` must not turn /api/health into a 500: telling the user
    // what is misconfigured is exactly what that endpoint is for.
    this.inFlight = readGitHubLoginStatus(this.options)
      .catch((error: unknown) => anonymousStatus(error))
      .then((value) => {
        this.cached = { value, at: startedAt };
        this.inFlight = null;
        return value;
      });
    return this.inFlight;
  }
}

function anonymousStatus(error: unknown): GitHubLoginStatus {
  return {
    loggedIn: false,
    login: null,
    scopes: [],
    tokenSource: null,
    hint: error instanceof Error ? error.message : String(error),
  };
}
