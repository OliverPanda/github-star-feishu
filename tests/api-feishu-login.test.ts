import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, type ApiOptions } from "../src/api/app.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { FeishuLoginManager, type LoginSession } from "../src/feishu/login-session.js";
import type { LoginStatus } from "../src/feishu/login-flow.js";
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
    appId: "cli_existing",
    createdApp: false,
    ...overrides,
  };
}

const loggedOut: LoginStatus = {
  loggedIn: false,
  appId: null,
  userName: null,
  scopes: [],
  hint: null,
  missingScopes: [],
};

/** Minimal stand-in for the real manager, so no CLI process is ever spawned. */
function stubManager(overrides: Partial<Record<string, unknown>> = {}) {
  const created = session("s1");
  return {
    start: vi.fn(async () => created),
    get: vi.fn(() => created),
    latest: vi.fn(() => created),
    cancel: vi.fn(() => true),
    logout: vi.fn(async () => {}),
    ...overrides,
  } as unknown as FeishuLoginManager;
}

function stubStatus(value: LoginStatus = loggedOut) {
  return {
    get: vi.fn(async () => value),
    invalidate: vi.fn(),
  } as unknown as NonNullable<ApiOptions["loginStatus"]>;
}

/**
 * Health also probes `gh auth status`, and the real cache would spawn the CLI
 * (against the developer's own GitHub login) on every request. This suite is
 * about Feishu, so the GitHub probe is stubbed as signed out.
 */
function stubGithubStatus() {
  return {
    get: vi.fn(async () => ({
      loggedIn: false,
      login: null,
      scopes: [],
      tokenSource: null,
      hint: null,
    })),
    invalidate: vi.fn(),
  } as unknown as NonNullable<ApiOptions["githubStatus"]>;
}

function build(options: Partial<ApiOptions> = {}, db: Db) {
  return createApi({
    db,
    config: testConfig(),
    feishuLogin: stubManager(),
    loginStatus: stubStatus(),
    githubStatus: stubGithubStatus(),
    ...options,
  });
}

describe("feishu login routes", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("requires the bearer token", async () => {
    const app = build({}, db);

    expect((await app.request("/api/feishu/login")).status).toBe(401);
    expect((await app.request("/api/feishu/login", { method: "POST" })).status).toBe(401);
    expect((await app.request("/api/feishu/status", { headers: auth })).status).toBe(200);
  });

  it("starts a session and returns the QR code", async () => {
    const created = session("s1", { qrDataUrl: "data:image/png;base64,AAA" });
    const app = build({ feishuLogin: stubManager({ start: vi.fn(async () => created) }) }, db);

    const response = await app.request("/api/feishu/login", { method: "POST", headers: auth });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      session: { id: "s1", qrDataUrl: "data:image/png;base64,AAA" },
    });
  });

  it("returns 404 while polling an unknown session", async () => {
    const app = build({ feishuLogin: stubManager({ get: vi.fn(() => null) }) }, db);

    const response = await app.request("/api/feishu/login/missing", { headers: auth });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("不存在") });
  });

  it("reports the latest session so a reloaded page can resume polling", async () => {
    const app = build({}, db);

    const response = await app.request("/api/feishu/login", { headers: auth });

    expect(await response.json()).toMatchObject({ session: { id: "s1" } });
  });

  it("rejects cancelling a session that already finished", async () => {
    const app = build({ feishuLogin: stubManager({ cancel: vi.fn(() => false) }) }, db);

    expect((await app.request("/api/feishu/login/s1", { method: "DELETE", headers: auth })).status)
      .toBe(404);
  });

  it("cancels a live session", async () => {
    const app = build({}, db);

    const response = await app.request("/api/feishu/login/s1", { method: "DELETE", headers: auth });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ cancelled: true });
  });

  it("reports health as disconnected when nobody is signed in", async () => {
    const app = build({}, db);

    expect(await (await app.request("/api/health", { headers: auth })).json()).toMatchObject({
      ok: true,
      github: true,
      feishu: false,
    });
  });

  it("reports health as connected from a scanned login, not from .env secrets", async () => {
    // The config has no FEISHU_APP_ID/SECRET by design; the user token is what
    // the writer actually uses.
    const app = build(
      {
        loginStatus: stubStatus({
          loggedIn: true,
          appId: "cli_personal",
          userName: "张三",
          scopes: ["wiki:wiki"],
          hint: null,
          missingScopes: ["wiki:node:update"],
        }),
      },
      db,
    );

    expect(await (await app.request("/api/health", { headers: auth })).json()).toMatchObject({
      feishu: true,
      feishuAppId: "cli_personal",
      feishuUser: "张三",
      feishuMissingScopes: ["wiki:node:update"],
    });
  });

  it("re-probes status on demand and invalidates the cache after logout", async () => {
    const loginStatus = stubStatus();
    const feishuLogin = stubManager();
    const app = build({ loginStatus, feishuLogin }, db);

    await app.request("/api/feishu/status", { headers: auth });
    expect(loginStatus.invalidate).toHaveBeenCalledTimes(1);

    await app.request("/api/feishu/logout", { method: "POST", headers: auth });
    expect(feishuLogin.logout).toHaveBeenCalledTimes(1);
    expect(loginStatus.invalidate).toHaveBeenCalledTimes(2);
  });
});

describe("feishu knowledge base target", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("lists the spaces the signed-in user can choose from", async () => {
    const app = build(
      {
        listSpaces: async () => [
          {
            spaceId: "sp-real",
            name: "GitHub Star 精选",
            description: null,
            spaceType: "team",
            visibility: "private",
          },
        ],
      },
      db,
    );

    expect(await (await app.request("/api/feishu/spaces", { headers: auth })).json()).toEqual({
      spaces: [
        {
          spaceId: "sp-real",
          name: "GitHub Star 精选",
          description: null,
          spaceType: "team",
          visibility: "private",
        },
      ],
    });
  });

  it("turns a not-signed-in listing failure into the login hint", async () => {
    const app = build(
      {
        listSpaces: async () => {
          throw new Error("未登录，请先执行 feishu-cli auth login");
        },
      },
      db,
    );

    const response = await app.request("/api/feishu/spaces", { headers: auth });
    expect(response.status).toBe(401);
  });

  it("remembers the chosen knowledge base so later syncs reuse it", async () => {
    const app = build({}, db);

    const saved = await app.request("/api/feishu/target", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId: "7684632981146733504", name: "GitHub Star 精选" }),
    });

    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ spaceId: "7684632981146733504" });

    // The stored target is what the sync reads back, so the round trip matters
    // more than the response body.
    const current = await app.request("/api/feishu/target", { headers: auth });
    expect(await current.json()).toEqual({
      spaceId: "7684632981146733504",
      space: "GitHub Star 精选",
    });
  });

  it("rejects an empty space id", async () => {
    const app = build({}, db);

    const response = await app.request("/api/feishu/target", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ spaceId: "  " }),
    });

    expect(response.status).toBe(400);
  });
});
