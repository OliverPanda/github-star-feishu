import { describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError, normalizeBaseUrl } from "../lib/api.js";

const SETTINGS = { baseUrl: "http://127.0.0.1:8787", token: "secret-token" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("normalizeBaseUrl", () => {
  it.each([
    ["http://127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["http://127.0.0.1:8787/", "http://127.0.0.1:8787"],
    ["http://127.0.0.1:8787///", "http://127.0.0.1:8787"],
    ["127.0.0.1:8787", "http://127.0.0.1:8787"],
    ["  https://box.local  ", "https://box.local"],
    ["HTTPS://box.local", "HTTPS://box.local"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });

  it("falls back to the local default when blank", () => {
    expect(normalizeBaseUrl("   ")).toBe("http://127.0.0.1:8787");
  });
});

describe("ApiClient", () => {
  it("sends the bearer token and parses the payload", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ subscriptions: [{ login: "karpathy" }] }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    const result = await client.listSubscriptions();

    expect(result).toEqual([{ login: "karpathy" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/subscriptions");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    expect(init.body).toBeUndefined();
  });

  it("reads health through the accessor without a body", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, github: true, llm: false, feishu: false }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.health).resolves.toEqual({
      ok: true,
      github: true,
      llm: false,
      feishu: false,
    });
  });

  it("sends a JSON body for writes and escapes the login in the path", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ subscription: { login: "a/b" } }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await client.updateSubscription("a/b", { enabled: false });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/subscriptions/a%2Fb");
    expect(init.method).toBe("PATCH");
    expect(init.body).toBe(JSON.stringify({ enabled: false }));
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  });

  it("refuses to call the service when no token is configured", async () => {
    const fetchImpl = vi.fn();
    const client = new ApiClient({ ...SETTINGS, token: "" }, fetchImpl as unknown as typeof fetch);

    await expect(client.listSubscriptions()).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces the service's Chinese error message", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "订阅不存在" }, 404));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.removeSubscription("ghost")).rejects.toThrow("订阅不存在");
  });

  it("falls back to a status message when the error body is not JSON", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>oops</html>", { status: 502 }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.listRuns()).rejects.toThrow("请求失败（HTTP 502）");
  });

  it("explains a refused connection instead of leaking 'failed to fetch'", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.listSubscriptions()).rejects.toThrow("npm run api");
  });
});

describe("ApiClient Feishu login", () => {
  const SESSION = {
    id: "s-1",
    state: "awaiting_scan" as const,
    step: "create_app" as const,
    prompt: null,
    qrDataUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
    appId: null,
    createdApp: false,
  };

  it("starts a login session with a bodyless POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: SESSION }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.startFeishuLogin()).resolves.toEqual(SESSION);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/feishu/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("polls one session by escaped id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: SESSION }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.feishuLoginSession("a/b")).resolves.toEqual(SESSION);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/feishu/login/a%2Fb");
    expect(init.method).toBe("GET");
  });

  it("cancels a session with DELETE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ cancelled: true }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.cancelFeishuLogin("s-1")).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/feishu/login/s-1");
    expect(init.method).toBe("DELETE");
  });

  it("surfaces a missing session as the service's Chinese error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "登录会话不存在或已过期" }, 404));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.feishuLoginSession("gone")).rejects.toThrow("登录会话不存在或已过期");
  });

  it("reads the login status payload as-is", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        loggedIn: true,
        appId: "cli_a1",
        userName: "张三",
        scopes: ["wiki:wiki"],
        hint: null,
        missingScopes: [],
      }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.feishuStatus()).resolves.toMatchObject({
      loggedIn: true,
      appId: "cli_a1",
      userName: "张三",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/feishu/status");
    expect(init.method).toBe("GET");
  });

  it("logs out with a bodyless POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ loggedOut: true }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.feishuLogout()).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/feishu/logout");
    expect(init.method).toBe("POST");
  });

  it("refuses to start a login without a token", async () => {
    const fetchImpl = vi.fn();
    const client = new ApiClient({ ...SETTINGS, token: "" }, fetchImpl as unknown as typeof fetch);

    await expect(client.startFeishuLogin()).rejects.toBeInstanceOf(ApiError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("ApiClient GitHub login", () => {
  const SESSION = {
    id: "g-1",
    state: "awaiting_scan" as const,
    step: "authorize" as const,
    prompt: {
      userCode: "A188-CF1E",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: null,
      expiresInSeconds: null,
    },
    qrDataUrl: "data:image/png;base64,AAAA",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    error: null,
    login: null,
    envFile: "D:/repo/.env",
    tokenSaved: false,
  };

  it("starts a login session with a bodyless POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: SESSION }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.startGitHubLogin()).resolves.toEqual(SESSION);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/github/login");
    expect(init.method).toBe("POST");
    expect(init.body).toBeUndefined();
  });

  it("polls one session by escaped id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ session: SESSION }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.githubLoginSession("a/b")).resolves.toEqual(SESSION);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/github/login/a%2Fb");
    expect(init.method).toBe("GET");
  });

  it("cancels a session with DELETE", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ cancelled: true }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.cancelGitHubLogin("g-1")).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/github/login/g-1");
    expect(init.method).toBe("DELETE");
  });

  it("reads the GitHub status payload as-is", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        loggedIn: true,
        login: "OliverPanda",
        scopes: ["repo", "read:org"],
        tokenSource: "keyring",
        hint: null,
      }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.githubStatus()).resolves.toMatchObject({
      loggedIn: true,
      login: "OliverPanda",
      tokenSource: "keyring",
    });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/github/status");
    expect(init.method).toBe("GET");
  });

  it("logs out with a bodyless POST", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ loggedOut: true }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.githubLogout()).resolves.toBeUndefined();

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/github/logout");
    expect(init.method).toBe("POST");
  });

  it("calls fetchImpl with a global receiver", async () => {
    // Chrome's native fetch throws "Illegal invocation" when called as a method
    // of an arbitrary object, so the default implementation must stay bound to
    // globalThis. A wrapper records the receiver the way a native fetch would.
    const receivers: unknown[] = [];
    const nativeLikeFetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(jsonResponse({ ok: true }));
    } as unknown as typeof fetch;

    const client = new ApiClient(SETTINGS, nativeLikeFetch);
    await client.health;

    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(globalThis);
  });

  it("binds the built-in fetch to the global object by default", async () => {
    const originalFetch = globalThis.fetch;
    const receivers: unknown[] = [];
    globalThis.fetch = function (this: unknown) {
      receivers.push(this);
      return Promise.resolve(jsonResponse({ ok: true }));
    } as unknown as typeof fetch;

    try {
      const client = new ApiClient(SETTINGS);
      await client.health;
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(receivers).toHaveLength(1);
    expect(receivers[0]).toBe(globalThis);
  });
});

describe("ApiClient author library", () => {
  it("unwraps the author payload and escapes the login in the path", async () => {
    const author = {
      login: "karpathy",
      name: "Andrej Karpathy",
      alias: null,
      isSelf: false,
      followers: 221175,
      starredCount: 165,
      syncedRepos: 165,
      lastSyncedAt: "2026-01-01 00:00:00",
      dataUpdatedAt: "2026-01-01T00:00:00Z",
      categories: [],
      unclassified: 0,
      topPicks: [],
      shared: [],
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ author }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    // Returns the inner object, not the `{ author }` envelope, so callers do
    // not have to know how the service wraps its responses.
    await expect(client.authorLibrary("a/b")).resolves.toEqual(author);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/authors/a%2Fb/stars");
    expect(init.method).toBe("GET");
  });

  it("surfaces the 'not synced yet' hint from the service", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: "还没有 ghost 的数据，请先添加订阅并同步一次" }, 404),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.authorLibrary("ghost")).rejects.toThrow("请先添加订阅并同步一次");
  });

  it("keeps the 404 status so the page can offer '一键整理' instead of an error", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "还没有 ghost 的数据" }, 404));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    const failure = await client.authorLibrary("ghost").catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(404);
  });
});

describe("ApiClient roster", () => {
  it("unwraps the roster payload", async () => {
    const author = {
      login: "karpathy",
      name: "Andrej Karpathy",
      tag: "AI 教学与开源",
      blurb: "从零训练 GPT",
      followers: 221293,
      followersLive: false,
      tracked: false,
      syncedRepos: 0,
      lastSyncedAt: null,
      topCategories: [],
    };
    const fetchImpl = vi.fn(async () => jsonResponse({ authors: [author] }));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.listRoster()).resolves.toEqual([author]);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/roster");
    expect(init.method).toBe("GET");
  });

  it("reads the cached trending board", async () => {
    const board = {
      generatedAt: "2026-09-12T03:04:05.000Z",
      since: "daily" as const,
      rows: [
        {
          fullName: "a/one",
          url: "https://github.com/a/one",
          starsToday: 2265,
          stars: 30777,
          language: "JavaScript",
          description: "desc",
          category: "AI应用与变现",
          summaryZh: "摘要",
          monetization: "SaaS 订阅",
          moneyScore: 5,
        },
      ],
    };
    const fetchImpl = vi.fn(async () => jsonResponse(board));
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.listTrending()).resolves.toEqual(board);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/trending");
    expect(init.method).toBe("GET");
  });

  it("surfaces an empty board without inventing rows", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ generatedAt: null, since: "daily", repos: [], rows: [] }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await expect(client.listTrending()).resolves.toMatchObject({
      generatedAt: null,
      rows: [],
    });
  });

  it("forwards allowUnsubscribed so a recommended author can be arranged", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        runId: 1,
        spaceId: "space-1",
        newStars: 2,
        failed: 0,
        skipped: [],
        outcomes: [],
      }),
    );
    const client = new ApiClient(SETTINGS, fetchImpl as unknown as typeof fetch);

    await client.run({ logins: ["ggerganov"], allowUnsubscribed: true });

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      logins: ["ggerganov"],
      allowUnsubscribed: true,
    });
  });
});
