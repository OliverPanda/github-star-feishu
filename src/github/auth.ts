import { spawn } from "node:child_process";

/**
 * Login prompt produced by `gh auth login --web`.
 *
 * Unlike Feishu's device flow, GitHub's verification URL does not accept the
 * user code as a query parameter - pre-filling it lands on the sign-in page
 * instead of the approval page. So `verificationUriComplete` is always null
 * here and the UI must show the code and the bare link side by side.
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

/**
 * What `gh auth status --json hosts` reports for github.com.
 *
 * `state` is the field that decides everything: an expired or revoked token is
 * reported as `"error"` rather than as an absent host, so a logged-out check
 * has to look at both an empty host list and a non-success state.
 */
export interface GitHubAuthState {
  loggedIn: boolean;
  login: string | null;
  scopes: string[];
  tokenSource: string | null;
  gitProtocol: string | null;
  hint: string | null;
}

export interface GitHubAuthOptions {
  cliPath: string;
  /**
   * Isolated `GH_CONFIG_DIR`.
   *
   * `gh` falls back to the OS credential store when its config directory has
   * no token, which would hand this project the developer's own global login
   * instead of the account that was just scanned.
   */
  configDir: string;
  log?: (message: string) => void;
  /** Injected in tests so the suite never spawns a real process. */
  spawnProcess?: SpawnProcess;
}

/** Reported instead of a null exit code when the caller stops the flow. */
export const CANCEL_MESSAGE = "已取消登录";

/** The only host this project talks to. */
export const GITHUB_HOST = "github.com";

/**
 * The device-flow URL `gh` prints.
 *
 * Kept as a constant fallback because the URL is the one part of the prompt
 * that is worth showing even if parsing the code failed.
 */
export const DEVICE_URL = `https://${GITHUB_HOST}/login/device`;

const URL_PATTERN = /https?:\/\/[^\s"'<>()（）【】，,]+/g;

/**
 * `gh` prints the code as `First copy your one-time code: A188-CF1E`.
 *
 * The pattern tolerates both the English text and a bare 8-character code in
 * `XXXX-XXXX` shape, because a localized build would drop the label.
 */
const USER_CODE_PATTERN =
  /(?:one-time code|一次性代码|设备码|user code)\s*[:：]?\s*([A-Za-z0-9]{4}-[A-Za-z0-9]{4})\b/i;
const BARE_CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const found = record[key];
  return typeof found === "string" && found.trim() ? found.trim() : null;
}

/**
 * Extract the outermost JSON value from output that may carry banner lines.
 *
 * `gh auth status` prints "You are not logged into any GitHub hosts..." before
 * the JSON payload, and it still exits 0, so the payload cannot be located by
 * trusting the exit code.
 */
function parseJsonObject(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  if (!trimmed) return {};
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return {};
  try {
    return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
  } catch {
    return {};
  }
}

/**
 * Extract the device-flow prompt from `gh` output.
 *
 * `gh` prints the code and the link on separate lines, and a streamed caller
 * can see one before the other, so each field is filled independently.
 */
export function parseLoginPrompt(text: string): LoginPrompt {
  const userCode =
    USER_CODE_PATTERN.exec(text)?.[1] ?? BARE_CODE_PATTERN.exec(text)?.[1] ?? null;

  let sawUrl = false;
  for (const [match] of text.matchAll(URL_PATTERN)) {
    const url = match.replace(/[.,;、]+$/, "");
    // The code is typed into the approval page, not appended to it, so the
    // device URL has to stay free of query parameters.
    if (url.includes("/login/device")) sawUrl = true;
  }

  // `gh` always points at the same approval page, so the constant is a safe
  // stand-in when the code parsed but the link line has not arrived yet. A
  // prompt with neither a code nor a link is not worth showing.
  const verificationUri = sawUrl || userCode ? DEVICE_URL : null;

  return {
    userCode,
    verificationUri,
    verificationUriComplete: null,
    expiresInSeconds: null,
  };
}

/**
 * True when `next` carries something `previous` was missing.
 *
 * The prompt arrives in pieces, so the link can be parsed before the code.
 * Re-publishing on those gaps is what keeps the QR card from being stuck with
 * a permanently blank device code.
 */
function isPromptRicher(next: LoginPrompt, previous: LoginPrompt): boolean {
  if (!previous.userCode && next.userCode) return true;
  if (!previous.verificationUri && next.verificationUri) return true;
  return false;
}

/** Map `gh auth status --json hosts` onto the shape the UI renders. */
export function parseAuthState(output: string): GitHubAuthState {
  const record = parseJsonObject(output);
  const hosts = asRecord(record.hosts);
  const entries = hosts[GITHUB_HOST];
  const entry = Array.isArray(entries)
    ? asRecord(entries.find((item) => asRecord(item).state === "success") ?? entries[0])
    : {};

  const state = readString(entry, "state");
  const scopes = (readString(entry, "scopes") ?? "")
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  const error = readString(entry, "error");

  return {
    // A token that GitHub rejects is still listed as a host, so "logged in"
    // has to mean "the reported state is success" and not merely "a host row
    // exists".
    loggedIn: state === "success",
    login: readString(entry, "login"),
    scopes,
    tokenSource: readString(entry, "tokenSource"),
    gitProtocol: readString(entry, "gitProtocol"),
    hint: error ?? null,
  };
}

/**
 * User-facing login wrapper around the GitHub CLI.
 *
 * GitHub has a first-class device flow, so the whole onboarding is one scan:
 * `gh auth login --web` shows a code, the user approves it in a browser, and
 * the CLI stores the resulting token itself.
 */
export class GitHubAuth {
  private readonly options: GitHubAuthOptions;
  private readonly log: (message: string) => void;

  constructor(options: GitHubAuthOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  /** Environment shared by every call, so all of them hit the same config dir. */
  private env(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      // Without this, `gh` reads the developer's own global login and the
      // scanned account would appear to be missing.
      GH_CONFIG_DIR: this.options.configDir,
      // `gh` otherwise opens a TTY prompt that a background service cannot answer.
      GH_PROMPT_DISABLED: "1",
    };
  }

  /** Spawn the CLI, merging stdout and stderr into one ordered buffer. */
  private run(args: string[], onChunk?: (text: string) => void): CommandStream {
    if (this.options.spawnProcess) {
      return this.options.spawnProcess(args, onChunk ?? (() => {}));
    }

    let buffer = "";
    const emit = (text: string): void => {
      buffer += text;
      onChunk?.(text);
    };

    const child = spawn(this.options.cliPath, args, { env: this.env(), windowsHide: true });
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);

    const done = new Promise<{ code: number | null; output: string }>((resolve) => {
      child.on("error", (error: NodeJS.ErrnoException) => {
        emit(
          error.code === "ENOENT"
            ? `\n找不到 gh（${this.options.cliPath}）。请先安装 GitHub CLI，或用 GH_CLI_PATH 指定绝对路径。`
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
   * Wrap the device-flow login, surfacing the prompt as soon as `gh` prints it
   * so the caller can show a QR code while the process keeps polling.
   */
  login(onPrompt?: (prompt: LoginPrompt) => void): StreamHandle {
    const args = [
      "auth",
      "login",
      "--web",
      "--skip-ssh-key",
      "--hostname",
      GITHUB_HOST,
      "--git-protocol",
      "https",
      // Keyring storage would keep the token out of reach of `gh auth token`
      // in a service account, and this config dir is project-local anyway.
      "--insecure-storage",
    ];

    let announced: LoginPrompt | null = null;
    // `child.kill()` closes the process with a null exit code, which would
    // otherwise surface as the opaque "gh 退出码 null".
    let cancelled = false;
    // Accumulate locally: the stream is still in its temporal dead zone while
    // the first chunk arrives, and the prompt is split across chunks anyway.
    let seen = "";
    const stream = this.run(args, (text) => {
      seen += text;
      if (!onPrompt) return;
      const prompt = parseLoginPrompt(seen);
      // The code is what makes the prompt actionable; the banner alone is not.
      if (!prompt.userCode && !prompt.verificationUri) return;
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
        const ok = code === 0 && !failure;
        return {
          ok,
          // The user's own cancellation is the real reason, so it outranks any
          // partial output that happened to look like a failure line.
          error: ok ? null : cancelled ? CANCEL_MESSAGE : failure ?? `gh 退出码 ${code}`,
          output,
        };
      }),
    };
  }

  async status(): Promise<GitHubAuthState> {
    return parseAuthState(
      await this.collect([
        "auth",
        "status",
        "--hostname",
        GITHUB_HOST,
        "--json",
        "hosts",
      ]),
    );
  }

  /**
   * Read the stored token for the scanned account.
   *
   * `gh auth token` happily returns the machine's *global* token when the
   * isolated config dir holds nothing, so callers must confirm `status()` first
   * rather than treating any output as a successful login.
   */
  async token(): Promise<string | null> {
    const output = await this.collect(["auth", "token", "--hostname", GITHUB_HOST]);
    const token = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("!"));
    return token ?? null;
  }

  /** Drop the stored token; the account itself is untouched on GitHub. */
  async logout(): Promise<void> {
    await this.collect(["auth", "logout", "--hostname", GITHUB_HOST]);
  }
}

/**
 * Pull the one line that explains a failure out of the CLI output.
 *
 * `gh` prefixes its errors with "error: " and its warnings with "!", and the
 * banner is otherwise full of harmless progress text.
 */
export function loginFailureLine(output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.replace(/^[!\s]+/, "").trim())
    .filter(Boolean);
  for (const line of lines) {
    if (/^(?:error|错误|failed|失败)/i.test(line)) return line;
  }
  return null;
}
