import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiOptions } from "../src/api/app.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { GitHubLoginManager, type LoginSession } from "../src/github/login-session.js";
import type { GitHubLoginStatus } from "../src/github/login-flow.js";
import { createTestDb } from "./helpers.js";

const TOKEN = "test-token";

function testConfig(): AppConfig {
  return {
    githubToken: "gh-token",
    llm: { provider: "zhipu", apiKey: "", model: "glm-4-flash", baseURL: "https://example.com" },
    feishu: {
      appId: undefined,
      appSecret: undefined,
      userToken: undefined,
      spaceId: undefined,
      cliPath: "feishu-cli",
    },
    github: {
      cliPath: "gh",
      configDir: "/tmp/gh",
    },
    dbPath: ":memory:",
    api: { token: TOKEN, port: 8787, host: "127.0.0.1" },
  };
}

const auth = { Authorization: `Bearer ${TOKEN}` };

function session(id: string, overrides: Partial<LoginSession> = {}): LoginSession {
  return {
    id,
    state: "awaiting_scan",
    step: "authorize",
    prompt: null,
    qrDataUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
    login: null,
    envFile: "/repo/.env",
    tokenSaved: false,
    ...overrides,
  };
}

const signedOut: GitHubLoginStatus = {
  loggedIn: false,
  login: null,
  scopes: [],
  tokenSource: null,
  hint: null,
};

/** Minimal stand-in for the real manager, so no gh process is ever spawned. */
function stubManager(overrides: Partial<Record<string, unknown>> = {}) {
  const created = session("g1");
  return {
    start: vi.fn(() => created),
    get: vi.fn(() => created),
    latest: vi.fn(() => created),
    cancel: vi.fn(() => true),
    logout: vi.fn(async () => {}),
    ...overrides,
  } as unknown as GitHubLoginManager;
}

function stubStatus(value: GitHubLoginStatus = signedOut) {
  return {
    get: vi.fn(async () => value),
    invalidate: vi.fn(),
  } as unknown as NonNullable<ApiOptions["githubStatus"]>;
}

function build(options: Partial<ApiOptions> = {}, db: Db) {
  return createApi({
    db,
    config: testConfig(),
    githubLogin: stubManager(),
    githubStatus: stubStatus(),
    ...options,
  });
}

describe("github login routes", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("requires the bearer token", async () => {
    const app = build({}, db);

    expect((await app.request("/api/github/login")).status).toBe(401);
    expect((await app.request("/api/github/login", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/github/status", { headers: auth })).status).toBe(200);
  });

  it("starts a session and returns the QR code", async () => {
    const created = session("g1", {
      qrDataUrl: "data:image/png;base64,AAA",
      prompt: {
        userCode: "A188-CF1E",
        verificationUri: "https://github.com/login/device",
        verificationUriComplete: null,
        expiresInSeconds: null,
      },
    });
    const app = build({ githubLogin: stubManager({ start: vi.fn(() => created) }) }, db);

    const response = await app.request("/api/github/login", { method: "POST", headers: auth });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      session: {
        id: "g1",
        qrDataUrl: "data:image/png;base64,AAA",
        // The code is typed in by hand, so it has to survive the round trip.
        prompt: { userCode: "A188-CF1E" },
      },
    });
  });

  it("returns 404 while polling an unknown session", async () => {
    const app = build({ githubLogin: stubManager({ get: vi.fn(() => null) }) }, db);

    const response = await app.request("/api/github/login/missing", { headers: auth });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("不存在") });
  });

  it("reports the latest session so a reloaded page can resume polling", async () => {
    const app = build({}, db);

    const response = await app.request("/api/github/login", { headers: auth });

    expect(await response.json()).toMatchObject({ session: { id: "g1" } });
  });

  it("rejects cancelling a session that already finished", async () => {
    const app = build({ githubLogin: stubManager({ cancel: vi.fn(() => false) }) }, db);

    expect((await app.request("/api/github/login/g1", { method: "DELETE", headers: auth })).status)
      .toBe(404);
  });

  it("cancels a live session", async () => {
    const app = build({}, db);

    const response = await app.request("/api/github/login/g1", { method: "DELETE", headers: auth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });

  it("reports health from the scanned login, not only from .env", async () => {
    const app = build({}, db);

    expect(await (await app.request("/api/health", { headers: auth })).json()).toMatchObject({
      ok: true,
      github: true,
      githubUser: null,
      githubScopes: [],
    });
  });

  it("reports the scanned account and its scopes", async () => {
    const app = build(
      {
        githubStatus: stubStatus({
          loggedIn: true,
          login: "OliverPanda",
          scopes: ["gist", "repo"],
          tokenSource: "plaintext",
          hint: null,
        }),
      },
      db,
    );

    expect(await (await app.request("/api/health", { headers: auth })).json()).toMatchObject({
      github: true,
      githubUser: "OliverPanda",
      githubScopes: ["gist", "repo"],
    });
  });

  it("surfaces the gh failure reason on health", async () => {
    const app = build(
      { githubStatus: stubStatus({ ...signedOut, hint: "spawn gh ENOENT" }) },
      db,
    );

    expect(await (await app.request("/api/health", { headers: auth })).json()).toMatchObject({
      githubHint: "spawn gh ENOENT",
    });
  });

  it("re-probes status on demand and invalidates the cache after logout", async () => {
    const githubStatus = stubStatus();
    const githubLogin = stubManager();
    const app = build({ githubStatus, githubLogin }, db);

    await app.request("/api/github/status", { headers: auth });
    expect(githubStatus.invalidate).toHaveBeenCalledTimes(1);

    await app.request("/api/github/logout", { method: "POST", headers: auth });
    expect(githubLogin.logout).toHaveBeenCalledTimes(1);
    // Without the second invalidation the health endpoint would keep reporting
    // the account that was just signed out.
    expect(githubStatus.invalidate).toHaveBeenCalledTimes(2);
  });
});
