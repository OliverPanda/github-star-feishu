import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  githubToken: string | undefined;
  github: {
    cliPath: string;
    /**
     * Isolated `GH_CONFIG_DIR` for the scan-to-login flow.
     *
     * `gh` falls back to the OS credential store when its config directory has
     * no token, which would silently hand this project the developer's own
     * global login. Pointing `GH_CONFIG_DIR` at a project-local directory keeps
     * the scanned account separate from whatever `gh` is already signed into.
     */
    configDir: string;
  };
  llm: {
    provider: string;
    apiKey: string;
    model: string;
    baseURL: string;
  };
  feishu: {
    appId: string | undefined;
    appSecret: string | undefined;
    /** User access token used for wiki writes; falls back to the CLI login when empty. */
    userToken: string | undefined;
    spaceId: string | undefined;
    cliPath: string;
  };
  dbPath: string;
  api: {
    /** Shared secret the extension sends as a bearer token. */
    token: string | undefined;
    port: number;
    host: string;
  };
}

/** Minimal .env loader (no dependency needed, and avoids polluting process env globally). */
function loadDotEnv(file: string): void {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * Locate the `feishu-cli` binary.
 *
 * Its installer drops the binary in `~/.local/bin`, which is not on PATH by
 * default on Windows and is often missing from a GUI-launched shell elsewhere.
 * A bare command name then fails with ENOENT right after a successful install,
 * which reads as "I signed in but nothing syncs". Probing the known install
 * directories keeps a fresh setup working without hand-editing PATH.
 */
export interface ResolveCliPathOptions {
  /** Platform to resolve for; injected because the installer layout is per-OS. */
  platform?: NodeJS.Platform;
  /** Directories probed in order before falling back to a PATH lookup. */
  dirs?: string[];
  /** Injected in tests so the probe never touches the real filesystem. */
  exists?: (candidate: string) => boolean;
}

/** Known install locations for the GitHub CLI, which its installers choose. */
export const GH_CANDIDATE_DIRS: Record<string, string[]> = {
  win32: [
    "C:\\Program Files\\GitHub CLI",
    "C:\\Program Files (x86)\\GitHub CLI",
    path.join(os.homedir(), "AppData", "Local", "GitHubCLI"),
  ],
  darwin: ["/opt/homebrew/bin", "/usr/local/bin"],
  linux: ["/usr/bin", "/usr/local/bin", "/snap/bin"],
};

/**
 * Locate the `gh` binary.
 *
 * The Windows installer does not put `gh` on PATH for a shell that was already
 * open, and a GUI-launched service often inherits a stale PATH, so the failure
 * would surface as an opaque ENOENT right after the user installed it.
 */
export function resolveGhPath(
  configured: string | undefined,
  options: ResolveCliPathOptions = {},
): string {
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
  const name = platform === "win32" ? "gh.exe" : "gh";
  const dirs = options.dirs ?? GH_CANDIDATE_DIRS[platform] ?? [];
  const exists = options.exists ?? existsSync;
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }
  return "gh";
}

export function resolveCliPath(
  configured: string | undefined,
  options: ResolveCliPathOptions = {},
): string {
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
  const name = platform === "win32" ? "feishu-cli.exe" : "feishu-cli";
  const dirs =
    options.dirs ??
    [
      path.join(os.homedir(), ".local", "bin"),
      path.join(os.homedir(), "bin"),
      "/usr/local/bin",
      "/opt/homebrew/bin",
    ];
  const exists = options.exists ?? existsSync;
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (exists(candidate)) return candidate;
  }

  // Fall back to a PATH lookup, so a globally installed CLI still resolves.
  return "feishu-cli";
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  loadDotEnv(path.join(cwd, ".env"));

  return {
    githubToken: process.env.GITHUB_TOKEN || process.env.GH_TOKEN || undefined,
    github: {
      cliPath: resolveGhPath(process.env.GH_CLI_PATH),
      configDir: process.env.GH_CONFIG_DIR || path.join(cwd, "data", "gh"),
    },
    llm: {
      provider: process.env.LLM_PROVIDER || "zhipu",
      apiKey: process.env.LLM_API_KEY || process.env.ZHIPU_API_KEY || "",
      model: process.env.LLM_MODEL || "glm-4-flash",
      baseURL: process.env.LLM_BASE_URL || "https://open.bigmodel.cn/api/paas/v4",
    },
    feishu: {
      appId: process.env.FEISHU_APP_ID || undefined,
      appSecret: process.env.FEISHU_APP_SECRET || undefined,
      userToken: process.env.FEISHU_USER_ACCESS_TOKEN || undefined,
      spaceId: process.env.FEISHU_SPACE_ID || undefined,
      cliPath: resolveCliPath(process.env.FEISHU_CLI_PATH),
    },
    dbPath: process.env.DB_PATH || path.join(cwd, "data", "stars.db"),
    api: {
      token: process.env.API_TOKEN || undefined,
      port: Number(process.env.API_PORT || 8787),
      host: process.env.API_HOST || "127.0.0.1",
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Render a value the way `loadDotEnv` reads it back.
 *
 * Tokens and ids are all `[A-Za-z0-9_-]`, so the common case stays unquoted and
 * human-readable; quoting is reserved for values the parser would otherwise
 * mangle (whitespace, `#`, empty). Escapes are deliberately not emitted because
 * the reader strips quotes without unescaping them.
 */
function formatEnvValue(value: string): string {
  if (/^[A-Za-z0-9_@./:+-]*$/.test(value)) return value;
  return `"${value}"`;
}

/**
 * Write `data` via a sibling temp file plus a rename.
 *
 * A crash or a full disk partway through a direct write would truncate the
 * user's `.env`, taking unrelated keys with it. The rename is atomic on both
 * POSIX and Windows, so the file is either the old one or the complete new one.
 */
function writeFileAtomic(file: string, data: string): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, data, "utf8");
    renameSync(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Never created, or already renamed into place; either way it is gone.
    }
    throw error;
  }
}

/**
 * Set `key=value` in a dotenv file, creating the file when it does not exist.
 *
 * The `.env` is the user's own hand-maintained config, so this edits it
 * surgically instead of re-serialising it: comments, blank lines, the existing
 * line ending, and the order of every unrelated key survive untouched. A key
 * that is already present is replaced in place, which keeps repeat logins
 * idempotent rather than appending the same key again.
 *
 * `process.env` is updated too: the service already loaded the old value at
 * startup, and `loadDotEnv` never overwrites an existing entry, so a fresh
 * login would otherwise not take effect until the next restart.
 */
export function upsertEnvVar(file: string, key: string, value: string): void {
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // First run: there is nothing to preserve, the file is created below.
  }

  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${escapeRegExp(key)}\\s*=`);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw === "" ? [] : raw.split(/\r?\n/);
  // Splitting a file that ends with a newline yields a trailing empty element
  // that is not a real line; keeping it would add a blank line on every write.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let replaced = false;
  const next = lines.map((line) => {
    if (replaced || !keyPattern.test(line)) return line;
    replaced = true;
    return `${key}=${formatEnvValue(value)}`;
  });
  if (!replaced) next.push(`${key}=${formatEnvValue(value)}`);

  writeFileAtomic(file, `${next.join(eol)}${eol}`);
  process.env[key] = value;
}
