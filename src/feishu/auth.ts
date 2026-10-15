import { spawn } from "node:child_process";
import { parseCliJson } from "./cli.js";

/**
 * Login prompt produced by the Feishu device flow.
 *
 * `verificationUriComplete` is the one to render as a QR code: it already
 * embeds the user code, so the user only has to confirm the request instead of
 * typing it. `verificationUri` is the bare link the code is typed into.
 */
export interface LoginPrompt {
  userCode: string | null;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  expiresInSeconds: number | null;
}

export interface LoginOutcome {
  ok: boolean;
  error: string | null;
  /** Full captured output, used for diagnostics when parsing found nothing. */
  output: string;
}

/** A long-running CLI call that keeps printing while it polls the server. */
export interface StreamHandle {
  /** Resolves when the process exits; cancel() makes it resolve as failed. */
  done: Promise<LoginOutcome>;
  cancel(): void;
}

export interface AuthState {
  loggedIn: boolean;
  identity: string;
  appId: string | null;
  scopes: string[];
  expiresAt: string | null;
  userName: string | null;
  hint: string | null;
}

export interface CommandStream {
  cancel(): void;
  /** Output buffered so far. */
  output(): string;
  done: Promise<{ code: number | null; output: string }>;
}

export type SpawnProcess = (
  args: string[],
  onChunk: (text: string) => void,
) => CommandStream;

export interface FeishuAuthOptions {
  cliPath: string;
  appId?: string | undefined;
  appSecret?: string | undefined;
  log?: (message: string) => void;
  /** Injected in tests so the suite never spawns a real process. */
  spawnProcess?: SpawnProcess;
}

/** Business domains whose user scopes the wiki pipeline needs. */
export const WIKI_LOGIN_DOMAINS = ["wiki", "docs"];

/** Reported instead of a null exit code when the caller stops the flow. */
export const CANCEL_MESSAGE = "已取消登录";

const URL_PATTERN = /https?:\/\/[^\s"'<>()（）【】，,]+/g;
const USER_CODE_PATTERN = /(?:用户码|user[_ ]?code)\s*[:：]?\s*([A-Za-z0-9][A-Za-z0-9-]{3,})/i;
const EXPIRES_PATTERN = /(?:有效期\s*[:：]?\s*(\d+)\s*秒|(\d+)\s*秒后过期)/;

/** `?user_code=` is often printed before the "用户码:" line, so read both. */
function readUserCodeFromUrl(url: string): string | null {
  const match = /[?&]user_code=([^&#\s]+)/.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const found = key.split(".").reduce<unknown>(
      (current, part) => (current === null || typeof current !== "object"
        ? undefined
        : (current as Record<string, unknown>)[part]),
      record,
    );
    if (typeof found === "string" && found.trim()) return found.trim();
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]): number | null {
  const raw = readString(record, keys);
  if (raw === null) {
    for (const key of keys) {
      const found = asRecord(record)[key];
      if (typeof found === "number" && Number.isFinite(found)) return found;
    }
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Extract the device-flow prompt from CLI output.
 *
 * `feishu-cli` mixes human-readable banners with JSON events (and prints the
 * human form to stderr even under `--json`), so both shapes are scanned and
 * whichever appears first wins.
 */
export function parseLoginPrompt(text: string): LoginPrompt {
  let userCode: string | null = null;
  let verificationUri: string | null = null;
  let verificationUriComplete: string | null = null;
  let expiresInSeconds: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    userCode ??= readString(record, ["user_code", "userCode", "data.user_code"]);
    verificationUri ??= readString(record, [
      "verification_uri",
      "verificationUri",
      "data.verification_uri",
    ]);
    verificationUriComplete ??= readString(record, [
      "verification_uri_complete",
      "verificationUriComplete",
      "data.verification_uri_complete",
    ]);
    expiresInSeconds ??= readNumber(record, ["expires_in", "expiresIn", "data.expires_in"]);
  }

  userCode ??= USER_CODE_PATTERN.exec(text)?.[1] ?? null;

  const expiresMatch = EXPIRES_PATTERN.exec(text);
  if (expiresMatch) {
    const seconds = Number(expiresMatch[1] ?? expiresMatch[2]);
    if (Number.isFinite(seconds)) expiresInSeconds ??= seconds;
  }

  for (const [match] of text.matchAll(URL_PATTERN)) {
    const url = match.replace(/[.,;、]+$/, "");
    if (url.includes("user_code=")) {
      verificationUriComplete ??= url;
      verificationUri ??= url;
      // The link is printed a line before "用户码:", so streamed callers that
      // only ever see this first chunk would otherwise report a null code.
      userCode ??= readUserCodeFromUrl(url);
      continue;
    }
    verificationUri ??= url;
  }

  if (!verificationUriComplete && verificationUri && userCode) {
    verificationUriComplete = `${verificationUri}?user_code=${encodeURIComponent(userCode)}`;
  }

  return { userCode, verificationUri, verificationUriComplete, expiresInSeconds };
}

/**
 * True when `next` carries something `previous` was missing.
 *
 * The banner is emitted in pieces, so the link can be parsed before the code
 * and expiry lines arrive. Re-publishing on those gaps is what keeps the QR
 * card from being stuck with a permanently blank user code.
 */
function isPromptRicher(next: LoginPrompt, previous: LoginPrompt): boolean {
  if (!previous.userCode && next.userCode) return true;
  if (!previous.expiresInSeconds && next.expiresInSeconds) return true;
  if (!previous.verificationUriComplete && next.verificationUriComplete) return true;
  return false;
}

function readScopes(...sources: Record<string, unknown>[]): string[] {
  for (const source of sources) {
    for (const key of ["scopes", "scope", "granted_scopes", "granted"]) {
      const found = source[key];
      if (Array.isArray(found)) {
        return found.filter((item): item is string => typeof item === "string");
      }
      if (typeof found === "string" && found.trim()) return found.trim().split(/\s+/);
    }
  }
  return [];
}

/** Map `feishu-cli auth status -o json` onto the shape the UI renders. */
export function parseAuthState(value: unknown): AuthState {
  const record = asRecord(value);
  const token = asRecord(record.token);
  const profile = asRecord(record.profile);
  // `auth status -o json` nests the account under `cached_user`; `user` and
  // `profile` are older shapes kept for compatibility.
  const user = asRecord(record.cached_user ?? record.user);

  return {
    loggedIn: record.logged_in === true,
    identity: readString(record, ["identity"]) ?? "unknown",
    appId: readString(record, ["app_id", "profile.app_id"]),
    scopes: readScopes(record, token, profile),
    expiresAt: readString(record, ["expires_at", "token.expires_at"]),
    userName:
      readString(record, [
        "user_name",
        "cached_user.name",
        "user.name",
        "profile.name",
        "profile.user_name",
      ]) ??
      readString(user, ["name"]),
    hint: readString(record, ["hint"]),
  };
}

/**
 * User-facing login wrapper around `feishu-cli`.
 *
 * Feishu has no "sign in as a user without an app" flow: the device-flow
 * `client_id` identifies who is *asking* for consent. The CLI closes that gap
 * with `config create-app`, which registers a personal app through the same
 * scan-to-approve flow, so a user still only ever scans a QR code.
 */
export class FeishuAuth {
  private readonly options: FeishuAuthOptions;
  private readonly log: (message: string) => void;

  constructor(options: FeishuAuthOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  /** Spawn the CLI, merging stdout and stderr into one ordered buffer. */
  private run(args: string[], onChunk?: (text: string) => void): CommandStream {
    if (this.options.spawnProcess) {
      return this.options.spawnProcess(args, onChunk ?? (() => {}));
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.options.appId) env.FEISHU_APP_ID = this.options.appId;
    if (this.options.appSecret) env.FEISHU_APP_SECRET = this.options.appSecret;

    let buffer = "";
    const emit = (text: string): void => {
      buffer += text;
      onChunk?.(text);
    };

    const child = spawn(this.options.cliPath, args, { env, windowsHide: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);

    const done = new Promise<{ code: number | null; output: string }>((resolve) => {
      child.on("error", (error: NodeJS.ErrnoException) => {
        emit(
          error.code === "ENOENT"
            ? `\n找不到 feishu-cli（${this.options.cliPath}）。请先安装，或用 FEISHU_CLI_PATH 指定绝对路径。`
            : `\n${error.message}`,
        );
        resolve({ code: -1, output: buffer });
      });
      child.on("close", (code) => resolve({ code, output: buffer }));
    });

    return {
      cancel: () => child.kill(),
      output: () => buffer,
      done,
    };
  }

  /** Run to completion and return the merged output, ignoring the exit code. */
  private async collect(args: string[]): Promise<string> {
    return (await this.run(args).done).output;
  }

  /**
   * Wrap a device-flow command, surfacing the prompt as soon as the CLI prints
   * it so the caller can show a QR code while the process keeps polling.
   */
  private startDeviceFlow(
    args: string[],
    onPrompt?: (prompt: LoginPrompt) => void,
  ): StreamHandle {
    let announced: LoginPrompt | null = null;
    // `child.kill()` closes the process with a null exit code, which would
    // otherwise surface to the user as the opaque "feishu-cli 退出码 null".
    let cancelled = false;
    // Accumulate locally: `stream` is still in its temporal dead zone while the
    // first chunk arrives, and the prompt is often split across chunks anyway.
    let seen = "";
    const stream = this.run(args, (text) => {
      seen += text;
      if (!onPrompt) return;
      const prompt = parseLoginPrompt(seen);
      // A code or a link is what makes the prompt actionable; banners alone are
      // not, so keep waiting until one of them shows up.
      if (!prompt.userCode && !prompt.verificationUri) return;
      // The banner arrives in pieces, so the link line can land before the code
      // and expiry lines. Publish only when a chunk actually fills a gap, which
      // keeps the QR card from being stuck with a permanently missing code.
      if (announced && !isPromptRicher(prompt, announced)) return;
      announced = prompt;
      onPrompt(prompt);
    });

    return {
      cancel: () => {
        cancelled = true;
        stream.cancel();
      },
      done: stream.done.then(({ code, output }) => {
        const failure = loginFailureLine(output);
        const ok = code === 0 && !(failure && /失败|错误|error/i.test(failure));
        return {
          ok,
          // The user's own cancellation is the real reason, so it outranks any
          // partial output that happened to look like a failure line.
          error: ok ? null : cancelled ? CANCEL_MESSAGE : failure ?? `feishu-cli 退出码 ${code}`,
          output,
        };
      }),
    };
  }

  /**
   * Register a personal Feishu app for this user via device flow.
   *
   * This is what makes "scan once and you are done" possible: the app is owned
   * by the user, so no shared client secret ever has to be shipped.
   */
  createApp(onPrompt?: (prompt: LoginPrompt) => void): StreamHandle {
    return this.startDeviceFlow(["config", "create-app", "--save"], onPrompt);
  }

  /** Obtain a user access token for the wiki scopes. */
  login(options: {
    domains?: string[];
    onPrompt?: (prompt: LoginPrompt) => void;
  } = {}): StreamHandle {
    const args = ["auth", "login", "--json", "--recommend"];
    for (const domain of options.domains ?? WIKI_LOGIN_DOMAINS) {
      args.push("--domain", domain);
    }
    return this.startDeviceFlow(args, options.onPrompt);
  }

  async status(): Promise<AuthState> {
    return parseAuthState(parseSafeJson(await this.collect(["auth", "status", "-o", "json"])));
  }

  /**
   * Display name of the signed-in account.
   *
   * `auth status` reports the app, scopes and expiry but never the account
   * itself, so the name has to come from the OpenAPI passthrough. `--as user`
   * is not optional: the default `auto` silently falls back to the tenant bot
   * when no user token is present, which would label the connection with the
   * wrong identity instead of failing.
   *
   * Note that `api` reuses `-o` for "write the response to this file", so this
   * call must not be given the `-o json` used by the other subcommands.
   */
  async userName(): Promise<string | null> {
    const output = await this.collect([
      "api",
      "GET",
      "/open-apis/authen/v1/user_info",
      "--as",
      "user",
    ]);
    const data = asRecord(asRecord(parseSafeJson(output)).data);
    return readString(data, ["name", "en_name"]);
  }

  /** True when a user token is present and covers every required scope. */
  async checkScopes(scope: string[]): Promise<{ ok: boolean; missing: string[] }> {
    const output = await this.collect(["auth", "check", "--scope", scope.join(" ")]);
    const parsed = asRecord(parseSafeJson(output));
    if (typeof parsed.ok === "boolean") {
      return {
        ok: parsed.ok,
        missing: Array.isArray(parsed.missing)
          ? parsed.missing.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
    // Older builds only report through the exit code and human text.
    return { ok: !!output.trim() && !/not_logged_in|token_expired|"ok":\s*false/.test(output), missing: [] };
  }

  async logout(): Promise<void> {
    await this.collect(["auth", "logout"]);
  }

  /** Resolve the app_id currently in effect (env, then config file). */
  async currentAppId(): Promise<string | null> {
    const configured = await this.collect(["config", "get", "app_id"]);
    const match = /cli_[A-Za-z0-9]+/.exec(configured);
    return match?.[0] ?? this.options.appId ?? null;
  }
}

/** `auth status` exits non-zero when logged out, so parse defensively. */
function parseSafeJson(output: string): unknown {
  try {
    return parseCliJson<unknown>(output);
  } catch {
    return {};
  }
}

/** Pull the one line that explains a failure out of the CLI output. */
export function loginFailureLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^(?:设备授权失败|授权失败|应用注册失败|错误|error)/i.test(line)) return line;
  }
  const missing = lines.find((line) => /缺少 (?:app_id|app_secret)/.test(line));
  return missing ?? null;
}
