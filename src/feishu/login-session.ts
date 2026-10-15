import { randomUUID } from "node:crypto";
import { FeishuAuth, type LoginPrompt } from "./auth.js";
import { renderQrDataUrl } from "../qr.js";

export type LoginStep = "create_app" | "authorize";
export type LoginState = "running" | "awaiting_scan" | "success" | "failed";

/**
 * A single in-progress onboarding.
 *
 * The browser extension cannot run `feishu-cli` itself, so the service keeps
 * the process alive and exposes the prompt; the user scans from the options
 * page and the same session reports completion on the next poll.
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
  appId: string | null;
  /** True when this session had to register a personal app first. */
  createdApp: boolean;
}

export interface LoginManagerOptions {
  cliPath: string;
  appId?: string | undefined;
  appSecret?: string | undefined;
  log?: (message: string) => void;
  /** Injected in tests. */
  auth?: FeishuAuth;
  renderQr?: (url: string) => Promise<string>;
}

/** Cap retained sessions so a long-lived service cannot grow without bound. */
const MAX_SESSIONS = 10;

/**
 * Owns at most one active device flow at a time.
 *
 * Two concurrent device flows would both write `~/.feishu-cli/config.yaml`, and
 * the losing scan would silently overwrite the winner's app credentials.
 */
export class FeishuLoginManager {
  private readonly auth: FeishuAuth;
  private readonly renderQr: (url: string) => Promise<string>;
  private readonly sessions = new Map<string, LoginSession>();
  private active: { id: string; cancel: () => void } | null = null;

  constructor(private readonly options: LoginManagerOptions) {
    this.auth = options.auth ?? new FeishuAuth(options);
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
   * Begin onboarding. Returns immediately with the session that the caller
   * polls; the device flow continues in the background.
   */
  async start(): Promise<LoginSession> {
    this.cancelActive();

    const now = new Date().toISOString();
    const session: LoginSession = {
      id: randomUUID(),
      state: "running",
      step: "create_app",
      prompt: null,
      qrDataUrl: null,
      createdAt: now,
      updatedAt: now,
      error: null,
      appId: this.options.appId ?? null,
      createdApp: false,
    };
    this.remember(session);

    // Deciding whether an app already exists is a CLI call too, so the whole
    // sequence runs in the background and the caller only ever polls.
    void this.runSequence(session).catch((error: unknown) => {
      this.finish(session, {
        state: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    });

    return session;
  }

  private async runSequence(session: LoginSession): Promise<void> {
    const existingAppId = await this.auth.currentAppId();
    if (!this.isLive(session.id)) return;

    if (!existingAppId) {
      session.step = "create_app";
      this.touch(session);
      const handle = this.auth.createApp((prompt) => void this.showPrompt(session, prompt));
      if (this.setActive(session.id, handle.cancel)) return;
      const result = await handle.done;
      this.clearActive(session.id);
      // A cancel or a newer session already wrote the outcome for this one, and
      // its message is more accurate than "the process I just killed failed".
      if (!this.isLive(session.id)) return;
      if (!result.ok) {
        this.finish(session, { state: "failed", error: result.error ?? "创建飞书应用失败" });
        return;
      }
      session.createdApp = true;
      this.touch(session);
    } else {
      // Record it now so the UI can show which app is being authorized while
      // the user is still scanning.
      session.appId = existingAppId;
      this.touch(session);
    }

    session.step = "authorize";
    session.prompt = null;
    session.qrDataUrl = null;
    this.touch(session);

    const handle = this.auth.login({
      onPrompt: (prompt) => void this.showPrompt(session, prompt),
    });
    if (this.setActive(session.id, handle.cancel)) return;
    const result = await handle.done;
    this.clearActive(session.id);
    if (!this.isLive(session.id)) return;

    if (!result.ok) {
      this.finish(session, { state: "failed", error: result.error ?? "飞书授权失败" });
      return;
    }

    session.appId = (await this.auth.currentAppId()) ?? session.appId;
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

  /** Drop the stored user token; the personal app stays registered. */
  async logout(): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.state === "running" || session.state === "awaiting_scan") {
        this.finish(session, { state: "failed", error: "已退出登录" });
      }
    }
    this.cancelActive();
    await this.auth.logout();
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
