import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  GitHubAuth,
  GitHubAuthState,
  LoginOutcome,
  StreamHandle,
} from "../src/github/auth.js";
import { GitHubLoginManager } from "../src/github/login-session.js";

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

function signedIn(overrides: Partial<GitHubAuthState> = {}): GitHubAuthState {
  return {
    loggedIn: true,
    login: "OliverPanda",
    scopes: ["repo"],
    tokenSource: "plaintext",
    gitProtocol: "https",
    hint: null,
    ...overrides,
  };
}

/** One throwaway directory per test, so no case can see another's .env. */
const tempDirs: string[] = [];

function tempEnv(contents?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gsr-gh-login-"));
  tempDirs.push(dir);
  const file = path.join(dir, ".env");
  if (contents !== undefined) writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.GITHUB_TOKEN;
});

interface StubOptions {
  token?: string | null;
  state?: GitHubAuthState;
}

function stubAuth(options: StubOptions = {}) {
  const loginStep = deferred();
  const login = vi.fn(() => loginStep.handle);
  const auth = {
    login,
    status: vi.fn(async () => options.state ?? signedIn()),
    token: vi.fn(async () => (options.token === undefined ? "gho_scanned123" : options.token)),
    logout: vi.fn(async () => {}),
  } as unknown as GitHubAuth;
  return { auth, login, loginStep };
}

function createManager(auth: GitHubAuth, envFile = tempEnv()) {
  const renderQr = vi.fn(async (url: string) => `data:image/png;base64,${url.length}`);
  const manager = new GitHubLoginManager({
    cliPath: "gh",
    configDir: "/tmp/gh",
    envFile,
    auth,
    renderQr,
    log: () => {},
  });
  return { manager, renderQr, envFile };
}

/** Reach into the stub's recorded callback so the test can drive the prompt. */
function promptHandler(auth: GitHubAuth) {
  return (auth.login as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as (
    prompt: {
      userCode: string | null;
      verificationUri: string | null;
      verificationUriComplete: string | null;
      expiresInSeconds: number | null;
    },
  ) => void;
}

/** Let queued microtasks (and the manager's internal awaits) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("GitHubLoginManager", () => {
  it("writes the scanned token into .env and reports the account", async () => {
    const { auth, loginStep } = stubAuth();
    const { manager, envFile } = createManager(auth);

    const session = await manager.start();
    await flush();
    loginStep.resolve(ok);
    await flush();

    const done = manager.get(session.id);
    expect(done?.state).toBe("success");
    expect(done?.login).toBe("OliverPanda");
    expect(done?.tokenSaved).toBe(true);
    expect(readFileSync(envFile, "utf8")).toContain("GITHUB_TOKEN=gho_scanned123");
  });

  it("keeps the rest of .env intact when it writes the token", async () => {
    const { auth, loginStep } = stubAuth();
    const { manager, envFile } = createManager(auth, tempEnv("API_TOKEN=keep-me\nAPI_PORT=8787\n"));

    await manager.start();
    await flush();
    loginStep.resolve(ok);
    await flush();

    const written = readFileSync(envFile, "utf8");
    expect(written).toContain("API_TOKEN=keep-me");
    expect(written).toContain("API_PORT=8787");
    expect(written).toContain("GITHUB_TOKEN=gho_scanned123");
  });

  it("pre-renders the QR image for the prompt it publishes", async () => {
    const { auth, loginStep } = stubAuth();
    const { manager, renderQr } = createManager(auth);

    await manager.start();
    await flush();
    promptHandler(auth)({
      userCode: "A188-CF1E",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      expiresInSeconds: null,
    });
    await flush();

    const session = manager.latest();
    // GitHub's device URL takes no code parameter, so the bare link is what the
    // QR image has to encode.
    expect(renderQr).toHaveBeenCalledWith("https://github.com/login/device");
    expect(session?.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(session?.state).toBe("awaiting_scan");
    loginStep.resolve(ok);
  });

  it("still shows the code when QR rendering fails", async () => {
    const { auth, loginStep } = stubAuth();
    const manager = new GitHubLoginManager({
      cliPath: "gh",
      configDir: "/tmp/gh",
      envFile: tempEnv(),
      auth,
      renderQr: async () => {
        throw new Error("boom");
      },
      log: () => {},
    });

    await manager.start();
    await flush();
    promptHandler(auth)({
      userCode: "A188-CF1E",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      expiresInSeconds: null,
    });
    await flush();

    const session = manager.latest();
    expect(session?.qrDataUrl).toBeNull();
    expect(session?.prompt?.userCode).toBe("A188-CF1E");
    expect(session?.prompt?.verificationUri).toContain("github.com/login/device");
    loginStep.resolve(ok);
  });

  it("does not resurrect a finished session when QR rendering is slow", async () => {
    const { auth, loginStep } = stubAuth();
    let finishRender: ((dataUrl: string) => void) | null = null;
    const manager = new GitHubLoginManager({
      cliPath: "gh",
      configDir: "/tmp/gh",
      envFile: tempEnv(),
      auth,
      renderQr: () =>
        new Promise<string>((resolve) => {
          finishRender = resolve;
        }),
      log: () => {},
    });

    const started = manager.start();
    await flush();
    promptHandler(auth)({
      userCode: "A188-CF1E",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      expiresInSeconds: null,
    });
    await flush();
    expect(finishRender).not.toBeNull();

    // The flow dies while the QR image is still being encoded.
    loginStep.resolve({ ok: false, error: "设备授权失败", output: "" });
    await flush();
    expect(manager.get(started.id)?.state).toBe("failed");

    (finishRender as unknown as (dataUrl: string) => void)("data:image/png;base64,late");
    await flush();

    const session = manager.get(started.id);
    expect(session?.state).toBe("failed");
    expect(session?.qrDataUrl).toBeNull();
  });

  it("reports a failed device flow as a failed session", async () => {
    const { auth, loginStep } = stubAuth();
    const { manager } = createManager(auth);

    const session = manager.start();
    await flush();
    loginStep.resolve({ ok: false, error: "设备授权失败", output: "" });
    await flush();

    expect(manager.get(session.id)?.state).toBe("failed");
    expect(manager.get(session.id)?.error).toBe("设备授权失败");
  });

  it("fails when the CLI exits cleanly but stored nothing", async () => {
    // Exit code 0 only means the process finished; without a host entry in the
    // isolated config dir nothing was actually authorized.
    const { auth, loginStep } = stubAuth({ state: signedIn({ loggedIn: false, hint: "HTTP 401: Bad credentials" }) });
    const { manager } = createManager(auth);

    const session = manager.start();
    await flush();
    loginStep.resolve(ok);
    await flush();

    expect(manager.get(session.id)?.state).toBe("failed");
    expect(manager.get(session.id)?.error).toContain("Bad credentials");
  });

  it("fails when the stored token cannot be read back", async () => {
    const { auth, loginStep } = stubAuth({ token: null });
    const { manager, envFile } = createManager(auth, tempEnv("API_PORT=8787\n"));

    const session = manager.start();
    await flush();
    loginStep.resolve(ok);
    await flush();

    expect(manager.get(session.id)?.state).toBe("failed");
    expect(manager.get(session.id)?.error).toContain("Token");
    expect(readFileSync(envFile, "utf8")).not.toContain("GITHUB_TOKEN=");
  });

  it("cancels the previous session when a new login starts", async () => {
    // Two concurrent device flows would both write the same gh hosts file, and
    // the losing approval would silently overwrite the winner's token.
    const { auth } = stubAuth();
    const { manager } = createManager(auth);

    const first = manager.start();
    await flush();
    const second = manager.start();
    await flush();

    expect(manager.get(first.id)?.state).toBe("failed");
    expect(manager.get(second.id)?.state).toBe("running");
  });

  it("marks a session failed when the user cancels it", async () => {
    const { auth } = stubAuth();
    const { manager } = createManager(auth);

    const session = manager.start();
    await flush();

    expect(manager.cancel(session.id)).toBe(true);
    expect(manager.get(session.id)?.state).toBe("failed");
    // Cancelling twice must not report a second success for a dead session.
    expect(manager.cancel(session.id)).toBe(false);
  });

  it("clears the stored token and the active session on logout", async () => {
    const { auth } = stubAuth();
    const { manager, envFile } = createManager(auth, tempEnv("GITHUB_TOKEN=gho_scanned123\n"));

    const session = manager.start();
    await flush();

    await manager.logout();

    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(manager.get(session.id)?.state).toBe("failed");
    // Leaving the token behind would keep the sync working after a logout,
    // which is the opposite of what the button promises.
    expect(readFileSync(envFile, "utf8")).toContain("GITHUB_TOKEN=");
    expect(readFileSync(envFile, "utf8")).not.toContain("gho_scanned123");
  });

  it("reports the newest session so a reloaded page can resume polling", async () => {
    const { auth } = stubAuth();
    const { manager } = createManager(auth);

    expect(manager.latest()).toBeNull();
    manager.start();
    await flush();
    const second = manager.start();
    await flush();

    expect(manager.latest()?.id).toBe(second.id);
    expect(manager.get("nope")).toBeNull();
  });
});
