import { randomUUID } from "node:crypto";
import { upsertEnvVar } from "../config.js";
import { renderQrDataUrl } from "../qr.js";
import { GitHubAuth, type LoginPrompt } from "./auth.js";
import { persistGitHubToken } from "./login-flow.js";

export type LoginStep = "authorize";
export type LoginState = "running" | "awaiting_scan" | "success" | "failed";

/**
 * A single in-progress GitHub sign-in.
 *
 * The browser extension cannot run `gh` itself, so the service keeps the device
 * flow alive and exposes the prompt; the user approves it in a browser and the
 * same session reports completion on the next poll.
 */
export interface LoginSession {
  id: string;
  state: LoginState;
  step: LoginStep;
  prompt: LoginPrompt | null;
  /** PNG data URL, pre-rendered so the extension only has to set an img src. */
  qrDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /** GitHub login of the account that was just authorized. */
  login: string | null;
  /** Where the token was written, so the user knows what changed on disk. */
  envFile: string;
  /** True once the token has been persisted to `.env`. */
  tokenSaved: boolean;
}

export interface LoginManagerOptions {
  cliPath: string;
  configDir: string;
  /** Dotenv file the scanned token is written into. */
  envFile: string;
  log?: (message: string) => void;
  /** Injected in tests. */
  auth?: GitHubAuth;
  renderQr?: (url: string) => Promise<string>;
}

/** Cap retained sessions so a long-lived service cannot grow without bound. */
const MAX_SESSIONS = 10;

/**
 * Owns at most one active device flow at a time.
 *
 * Two concurrent flows would both write the same `gh` hosts file, and the
 * losing approval would silently overwrite the winner's token.
 */
export class GitHubLoginManager {
  private readonly auth: GitHubAuth;
  private readonly renderQr: (url: string) => Promise<string>;
  private readonly sessions = new Map<string, LoginSession>();
  private active: { id: string; cancel: () => void } | null = null;

  constructor(private readonly options: LoginManagerOptions) {
    this.auth = options.auth ?? new GitHubAuth(options);
    this.renderQr = options.renderQr ?? renderQrDataUrl;
  }

  get(id: string): LoginSession | null {
    return this.sessions.get(id) ?? null;
  }

  latest(): LoginSession | null {
    let newest: LoginSession | null = null;
    for (const session of this.sessions.values()) {
      if (!newest || session.createdAt >= newest.createdAt) newest = session;
    }
    return newest;
  }

  /**
   * Begin onboarding. Returns immediately with the session the caller polls;
   * the device flow continues in the background.
   */
  start(): LoginSession {
    this.cancelActive();

    const now = new Date().toISOString();
    const session: LoginSession = {
      id: randomUUID(),
      state: "running",
      step: "authorize",
      prompt: null,
      qrDataUrl: null,
      createdAt: now,
      updatedAt: now,
      error: null,
      login: null,
      envFile: this.options.envFile,
      tokenSaved: false,
    };
    this.remember(session);

    void this.runSequence(session).catch((error: unknown) => {
      this.finish(session, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return session;
  }

  private async runSequence(session: LoginSession): Promise<void> {
    const handle = this.auth.login((prompt) => void this.showPrompt(session, prompt));
    if (this.setActive(session.id, handle.cancel)) return;

    const result = await handle.done;
    this.clearActive(session.id);
    // A cancel or a newer session already wrote the outcome for this one, and
    // its message is more accurate than "the process I just killed failed".
    if (!this.isLive(session.id)) return;
    if (!result.ok) {
      this.finish(session, { state: "failed", error: result.error ?? "GitHub 授权失败" });
      return;
    }

    // `gh auth login` exiting 0 only means the process finished; the token is
    // what the sync actually uses, so both are confirmed before reporting
    // success.
    const state = await this.auth.status();
    if (!this.isLive(session.id)) return;
    if (!state.loggedIn) {
      this.finish(session, {
        state: "failed",
        error: state.hint ?? "授权未生效，请重新扫码登录",
      });
      return;
    }

    // Shares the writer with the CLI flow, so both entry points persist the
    // token in exactly the same way.
    const token = await persistGitHubToken(this.auth, this.options.envFile);
    if (!this.isLive(session.id)) return;
    if (!token) {
      this.finish(session, { state: "failed", error: "未能读取 gh 保存的 Token" });
      return;
    }

    this.options.log?.(
      `GitHub 已登录${state.login ? `：${state.login}` : ""}，Token 已写入 ${this.options.envFile}`,
    );
    session.login = state.login;
    session.tokenSaved = true;
    this.finish(session, { state: "success", error: null });
  }

  /** Publish the scan prompt, rendering the QR image before the poll sees it. */
  private async showPrompt(session: LoginSession, prompt: LoginPrompt): Promise<void> {
    if (!this.isLive(session.id)) return;
    session.prompt = prompt;
    session.state = "awaiting_scan";
    this.touch(session);

    const url = prompt.verificationUriComplete ?? prompt.verificationUri;
    if (!url) return;
    try {
      const qrDataUrl = await this.renderQr(url);
      // Rendering is async, so the flow can fail or be cancelled while it runs.
      // Writing here unconditionally would resurrect a finished session and
      // leave the options page showing a QR code for a dead login attempt.
      if (!this.isLive(session.id)) return;
      session.qrDataUrl = qrDataUrl;
    } catch (error) {
      // The URL is still shown as text, so a QR failure is not fatal.
      this.options.log?.(
        `生成二维码失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.touch(session);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    // Only a live session can be cancelled; reporting success for one that
    // already finished would tell the UI to keep waiting for a process that is
    // no longer running.
    if (!session || (session.state !== "running" && session.state !== "awaiting_scan")) {
      return false;
    }
    // Kill only if this session owns the process; otherwise cancelActive would
    // finish whichever session is running and mislabel its error.
    if (this.active?.id === id) {
      const { cancel } = this.active;
      this.active = null;
      cancel();
    }
    this.finish(session, { state: "failed", error: "用户已取消登录" });
    return true;
  }

  /**
   * Sign out of the scanned account.
   *
   * The token in `.env` is cleared too: leaving it behind would keep the sync
   * working after a logout, which is the opposite of what the button promises.
   */
  async logout(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.state === "running" || session.state === "awaiting_scan") {
        this.finish(session, { state: "failed", error: "已退出登录" });
      }
    }
    this.cancelActive();
    await this.auth.logout();
    upsertEnvVar(this.options.envFile, "GITHUB_TOKEN", "");
  }

  private cancelActive(): void {
    if (!this.active) return;
    const { id, cancel } = this.active;
    this.active = null;
    cancel();
    const session = this.sessions.get(id);
    if (session && session.state !== "success") {
      this.finish(session, { state: "failed", error: "登录已被新的登录请求取代" });
    }
  }

  /** Returns true when a newer session took over while we were starting up. */
  private setActive(id: string, cancel: () => void): boolean {
    if (!this.isLive(id)) {
      cancel();
      return true;
    }
    this.active = { id, cancel };
    return false;
  }

  /** A session stops being live once it is finished, cancelled, or evicted. */
  private isLive(id: string): boolean {
    const session = this.sessions.get(id);
    return !!session && (session.state === "running" || session.state === "awaiting_scan");
  }

  private clearActive(id: string): void {
    if (this.active?.id === id) this.active = null;
  }

  private remember(session: LoginSession): void {
    this.sessions.set(session.id, session);
    while (this.sessions.size > MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )[0];
      if (!oldest) break;
      this.sessions.delete(oldest.id);
    }
  }

  private touch(session: LoginSession): void {
    session.updatedAt = new Date().toISOString();
  }

  private finish(session: LoginSession, patch: Pick<LoginSession, "state" | "error">): void {
    session.state = patch.state;
    session.error = patch.error;
    if (patch.state !== "success") {
      session.prompt = null;
      session.qrDataUrl = null;
    }
    this.touch(session);
  }
}
