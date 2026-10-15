import { describe, expect, it, vi } from "vitest";
import type { FeishuAuth, LoginOutcome, StreamHandle } from "../src/feishu/auth.js";
import { FeishuLoginManager } from "../src/feishu/login-session.js";

/** A device-flow step the test resolves by hand, so timing is deterministic. */
function deferred(): { handle: StreamHandle; resolve: (outcome: LoginOutcome) => void } {
  let settle: (outcome: LoginOutcome) => void = () => {};
  const done = new Promise<LoginOutcome>((resolve) => {
    settle = resolve;
  });
  return {
    handle: { done, cancel: () => {} },
    resolve: (outcome) => settle(outcome),
  };
}

const ok: LoginOutcome = { ok: true, error: null, output: "" };

interface StubOptions {
  appId?: string | null;
  prompts?: boolean;
}

function stubAuth(options: StubOptions = {}) {
  const createAppStep = deferred();
  const loginStep = deferred();
  const createApp = vi.fn(() => createAppStep.handle);
  const login = vi.fn(() => loginStep.handle);
  const auth = {
    currentAppId: vi.fn(async () => options.appId ?? null),
    createApp,
    login,
    logout: vi.fn(async () => {}),
  } as unknown as FeishuAuth;
  return { auth, createApp, login, createAppStep, loginStep };
}

function createManager(auth: FeishuAuth) {
  const renderQr = vi.fn(async (url: string) => `data:image/png;base64,${url.length}`);
  const manager = new FeishuLoginManager({
    cliPath: "feishu-cli",
    auth,
    renderQr,
    log: () => {},
  });
  return { manager, renderQr };
}

/** Let queued microtasks (and the manager's internal awaits) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("FeishuLoginManager", () => {
  it("registers an app first when the machine has no credentials", async () => {
    const { auth, createAppStep, loginStep } = stubAuth({ appId: null });
    const { manager } = createManager(auth);

    const session = await manager.start();
    await flush();

    expect(manager.get(session.id)?.step).toBe("create_app");
    createAppStep.resolve(ok);
    await flush();
    expect(manager.get(session.id)?.step).toBe("authorize");

    loginStep.resolve(ok);
    await flush();

    const done = manager.get(session.id);
    expect(done?.state).toBe("success");
    expect(done?.createdApp).toBe(true);
  });

  it("skips app registration when one already exists", async () => {
    const { auth, createApp, createAppStep } = stubAuth({ appId: "cli_existing" });
    const { manager } = createManager(auth);

    const session = await manager.start();
    await flush();

    expect(createApp).not.toHaveBeenCalled();
    expect(manager.get(session.id)?.step).toBe("authorize");
    expect(manager.get(session.id)?.appId).toBe("cli_existing");
    createAppStep.resolve(ok);
  });

  it("pre-renders the QR image for the prompt it publishes", async () => {
    const { auth, loginStep } = stubAuth({ appId: "cli_existing" });
    const { manager, renderQr } = createManager(auth);

    await manager.start();
    await flush();

    const onPrompt = (auth.login as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      onPrompt: (prompt: { userCode: string; verificationUriComplete: string; verificationUri: string; expiresInSeconds: number }) => void;
    };
    onPrompt.onPrompt({
      userCode: "U3X6-GVDZ",
      verificationUri: "https://open.feishu.cn/page/cli",
      verificationUriComplete: "https://open.feishu.cn/page/cli?user_code=U3X6-GVDZ",
      expiresInSeconds: 3600,
    });
    await flush();

    const session = manager.latest();
    expect(renderQr).toHaveBeenCalledWith("https://open.feishu.cn/page/cli?user_code=U3X6-GVDZ");
    expect(session?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(session?.state).toBe("awaiting_scan");
    loginStep.resolve(ok);
  });

  it("still shows the link when QR rendering fails", async () => {
    const { auth, loginStep } = stubAuth({ appId: "cli_existing" });
    const manager = new FeishuLoginManager({
      cliPath: "feishu-cli",
      auth,
      renderQr: async () => {
        throw new Error("boom");
      },
      log: () => {},
    });

    await manager.start();
    await flush();
    const onPrompt = (auth.login as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      onPrompt: (prompt: { userCode: string | null; verificationUri: string; verificationUriComplete: string; expiresInSeconds: number | null }) => void;
    };
    onPrompt.onPrompt({
      userCode: null,
      verificationUri: "https://open.feishu.cn/page/cli",
      verificationUriComplete: "https://open.feishu.cn/page/cli",
      expiresInSeconds: null,
    });
    await flush();

    const session = manager.latest();
    expect(session?.qrDataUrl).toBeNull();
    expect(session?.prompt?.verificationUri).toContain("open.feishu.cn");
    loginStep.resolve(ok);
  });

  it("does not resurrect a finished session when QR rendering is slow", async () => {
    const { auth, loginStep } = stubAuth({ appId: "cli_existing" });
    let finishRender: ((dataUrl: string) => void) | null = null;
    const manager = new FeishuLoginManager({
      cliPath: "feishu-cli",
      auth,
      renderQr: () =>
        new Promise<string>((resolve) => {
          finishRender = resolve;
        }),
      log: () => {},
    });

    const started = await manager.start();
    await flush();
    const onPrompt = (auth.login as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      onPrompt: (prompt: {
        userCode: string;
        verificationUri: string;
        verificationUriComplete: string;
        expiresInSeconds: number;
      }) => void;
    };
    onPrompt.onPrompt({
      userCode: "U3X6-GVDZ",
      verificationUri: "https://open.feishu.cn/page/cli",
      verificationUriComplete: "https://open.feishu.cn/page/cli?user_code=U3X6-GVDZ",
      expiresInSeconds: 3600,
    });
    await flush();
    expect(finishRender).not.toBeNull();

    // The flow dies while the QR image is still being encoded - exactly what
    // happens when app registration times out mid-render.
    loginStep.resolve({ ok: false, error: "应用注册失败", output: "" });
    await flush();
    expect(manager.get(started.id)?.state).toBe("failed");

    (finishRender as unknown as (dataUrl: string) => void)("data:image/png;base64,late");
    await flush();

    const session = manager.get(started.id);
    expect(session?.state).toBe("failed");
    expect(session?.qrDataUrl).toBeNull();
  });

  it("surfaces a failed device flow as a failed session", async () => {
    const { auth, loginStep } = stubAuth({ appId: "cli_existing" });
    const { manager } = createManager(auth);

    const session = await manager.start();
    await flush();
    loginStep.resolve({ ok: false, error: "设备授权失败", output: "" });
    await flush();

    expect(manager.get(session.id)?.state).toBe("failed");
    expect(manager.get(session.id)?.error).toBe("设备授权失败");
  });

  it("cancels the previous session when a new login starts", async () => {
    // Two concurrent device flows would both write ~/.feishu-cli/config.yaml.
    const { auth } = stubAuth({ appId: "cli_existing" });
    const { manager } = createManager(auth);

    const first = await manager.start();
    await flush();
    const second = await manager.start();
    await flush();

    expect(manager.get(first.id)?.state).toBe("failed");
    expect(manager.get(second.id)?.state).toBe("running");
  });

  it("marks a session failed when the user cancels it", async () => {
    const { auth } = stubAuth({ appId: "cli_existing" });
    const { manager } = createManager(auth);

    const session = await manager.start();
    await flush();

    expect(manager.cancel(session.id)).toBe(true);
    expect(manager.get(session.id)?.state).toBe("failed");
    expect(manager.cancel(session.id)).toBe(false);
  });

  it("returns null for an unknown session", async () => {
    const { auth } = stubAuth();
    const { manager } = createManager(auth);

    expect(manager.get("nope")).toBeNull();
    expect(manager.latest()).toBeNull();
  });
});
