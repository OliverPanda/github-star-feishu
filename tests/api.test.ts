import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApi as createApiWithDeps, type ApiOptions } from "../src/api/app.js";
import type { runSync } from "../src/service.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { createTestDb, profile, starEdge } from "./helpers.js";
import {
  getRepoEndorsements,
  getUnclassifiedRepos,
  saveClassifications,
  setSetting,
  upsertAuthor,
  upsertRepos,
  upsertStars,
  upsertSubscription,
} from "../src/store.js";
import { saveTrendingSnapshot } from "../src/trending-board.js";
import {
  buildWeeklyMoneyReport,
  saveWeeklyMoneySnapshot,
} from "../src/weekly-money.js";

const TOKEN = "test-token";

/**
 * Health probes `gh auth status` with a cached CLI call, so the real dependency
 * would spawn `gh` (against the developer's own login) on every request. These
 * route tests only care about the HTTP contract, so the probe is stubbed here
 * once instead of at all sixteen call sites.
 */
function createApi(options: ApiOptions) {
  return createApiWithDeps({
    githubStatus: {
      get: vi.fn(async () => ({
        loggedIn: false,
        login: null,
        scopes: [],
        tokenSource: null,
        hint: null,
      })),
      invalidate: vi.fn(),
    } as unknown as NonNullable<ApiOptions["githubStatus"]>,
    ...options,
  });
}

function testConfig(overrides: Partial<AppConfig["api"]> = {}): AppConfig {
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
    api: { token: TOKEN, port: 8787, host: "127.0.0.1", ...overrides },
  };
}

function auth(headers: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${TOKEN}`, ...headers };
}

function json(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: auth({ "Content-Type": "application/json" }),
    body: JSON.stringify(body),
  };
}

describe("api", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("reports health", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/health", { headers: auth() });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, github: true, llm: false });
  });

  it("refuses every protected route without the bearer token", async () => {
    const app = createApi({ db, config: testConfig() });

    for (const path of ["/api/subscriptions", "/api/runs", "/api/health"]) {
      expect((await app.request(path)).status).toBe(401);
    }
    expect(
      (await app.request("/api/subscriptions", { headers: { Authorization: "Bearer wrong" } })).status,
    ).toBe(401);
  });

  it("refuses to serve at all when no token is configured", async () => {
    const app = createApi({ db, config: testConfig({ token: undefined }) });
    const response = await app.request("/api/subscriptions", { headers: auth() });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("API_TOKEN") });
  });

  it("adds a subscription after verifying it against GitHub", async () => {
    const verifyLogin = vi.fn(async () => profile);
    const app = createApi({ db, config: testConfig(), verifyLogin });
    const response = await app.request(
      "/api/subscriptions",
      json({ login: "karpathy", alias: "Andrej" }),
    );

    expect(response.status).toBe(201);
    expect(verifyLogin).toHaveBeenCalledWith("karpathy");
    const body = (await response.json()) as {
      subscription: { login: string; alias: string; starredCount: number };
    };
    expect(body.subscription.login).toBe("karpathy");
    expect(body.subscription.alias).toBe("Andrej");
    expect(body.subscription.starredCount).toBe(2);
  });

  it("rejects an invalid login before calling GitHub", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/subscriptions", json({ login: "not a login!" }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("deletes a subscription and reports a missing one", async () => {
    upsertSubscription(db, { login: "karpathy" });

    const app = createApi({ db, config: testConfig() });
    const first = await app.request("/api/subscriptions/karpathy", { method: "DELETE", headers: auth() });
    expect(first.status).toBe(200);

    const second = await app.request("/api/subscriptions/karpathy", { method: "DELETE", headers: auth() });
    expect(second.status).toBe(404);
  });

  it("lists subscriptions with their sync numbers", async () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));
    upsertSubscription(db, { login: "karpathy", alias: "Andrej" });

    const app = createApi({ db, config: testConfig() });
    const body = (await (
      await app.request("/api/subscriptions", { headers: auth() })
    ).json()) as {
      subscriptions: Array<{ login: string; syncedRepos: number; followers: number | null }>;
    };

    expect(body.subscriptions).toHaveLength(1);
    expect(body.subscriptions[0]).toMatchObject({
      login: "karpathy",
      syncedRepos: 1,
      followers: 221175,
    });
  });

  it("reports endorsements for a repo that a tracked author starred", async () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("karpathy/nanoGPT", "2024-01-01T00:00:00Z")];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    const result = getRepoEndorsements(db, "karpathy/nanogpt");
    expect(result?.endorsements.map((entry) => entry.login)).toEqual(["karpathy"]);
  });

  it("returns an untracked repo as an empty endorsement list", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/repos/nobody/nothing/endorsements", {
      headers: auth(),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tracked: false, endorsements: [] });
  });

  it("refuses a run when nothing is subscribed", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/runs", json({}));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "还没有任何启用中的订阅" });
  });

  it("returns an empty run history before anything has run", async () => {
    const app = createApi({ db, config: testConfig() });
    const body = (await (await app.request("/api/runs", { headers: auth() })).json()) as {
      runs: unknown[];
    };

    expect(body.runs).toEqual([]);
  });

  it("runs every enabled subscription and forwards the logins subset", async () => {
    upsertSubscription(db, { login: "karpathy" });
    upsertSubscription(db, { login: "torvalds" });
    upsertSubscription(db, { login: "paused", enabled: false });

    type RunnerOptions = Parameters<typeof runSync>[0];
    const runner = vi.fn(async (options: RunnerOptions) => ({
      runId: 7,
      spaceId: "space-1",
      newStars: 3,
      failed: 0,
      skipped: [],
      outcomes: [],
      skippedAuthors: options.logins ?? [],
      trigger: options.trigger ?? "cli",
    }));
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });

    const body = (await (
      await app.request("/api/runs", json({ logins: ["karpathy"], trigger: "api" }))
    ).json()) as { runId: number; newStars: number };

    expect(body).toMatchObject({ runId: 7, newStars: 3 });
    const passed = runner.mock.calls[0]?.[0];
    expect(passed?.logins).toEqual(["karpathy"]);
    expect(passed?.trigger).toBe("api");
    // The runner receives the full intent list; runSync drops disabled rows,
    // but the API must still hand over the stored aliases and self flags.
    expect(passed?.subscriptions.authors.map((author: { login: string }) => author.login)).toEqual([
      "karpathy",
      "torvalds",
      "paused",
    ]);
  });

  it("refuses a run when every subscription is disabled", async () => {
    upsertSubscription(db, { login: "karpathy", enabled: false });

    const runner = vi.fn();
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });
    const response = await app.request("/api/runs", json({}));

    expect(response.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("syncs a recommended author that was never subscribed when allowed", async () => {
    upsertSubscription(db, { login: "karpathy" });

    type RunnerOptions = Parameters<typeof runSync>[0];
    const runner = vi.fn(async (options: RunnerOptions) => ({
      runId: 9,
      spaceId: "space-1",
      newStars: 1,
      failed: 0,
      skipped: [],
      outcomes: [],
      skippedAuthors: [],
      trigger: options.trigger ?? "cli",
    }));
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });

    const response = await app.request(
      "/api/runs",
      json({ logins: ["karpathy", "ggerganov"], allowUnsubscribed: true }),
    );

    expect(response.status).toBe(200);
    const passed = runner.mock.calls[0]?.[0];
    // The temporary author is appended so runSync, which only looks at enabled
    // rows, can actually reach it.
    expect(passed?.subscriptions.authors.map((author: { login: string }) => author.login)).toEqual([
      "karpathy",
      "ggerganov",
    ]);
  });

  it("still refuses an unsubscribed run when allowUnsubscribed is not set", async () => {
    const runner = vi.fn();
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });
    const response = await app.request("/api/runs", json({ logins: ["ggerganov"] }));

    expect(response.status).toBe(400);
    expect(runner).not.toHaveBeenCalled();
  });

  it("turns a signed-out Feishu run into an actionable scan hint", async () => {
    upsertSubscription(db, { login: "karpathy" });

    const runner = vi.fn(async () => {
      throw new Error("未登录，请先执行 feishu-cli auth login");
    });
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });
    const response = await app.request("/api/runs", json({}));

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("npm run cli -- login"),
    });
  });

  it("keeps the real error for unrelated run failures", async () => {
    upsertSubscription(db, { login: "karpathy" });

    const runner = vi.fn(async () => {
      throw new Error("知识库空间不存在");
    });
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });
    const response = await app.request("/api/runs", json({}));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "知识库空间不存在" });
  });

  it("does not ask for a Feishu login during a local dry run", async () => {
    upsertSubscription(db, { login: "karpathy" });

    const runner = vi.fn(async () => {
      throw new Error("未登录，请先执行 feishu-cli auth login");
    });
    const app = createApi({
      db,
      config: testConfig(),
      runner: runner as unknown as typeof runSync,
    });
    const response = await app.request("/api/runs", json({ local: true }));

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("未登录") });
  });
});

describe("author library api", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  /** Star two repos and classify them, so the route has grouped data to serve. */
  function seedClassifiedAuthor() {
    const author = upsertAuthor(db, profile);
    const edges = [
      starEdge("karpathy/nanoGPT", "2024-02-01T00:00:00Z", { stars: 20_000 }),
      starEdge("karpathy/llm.c", "2024-01-01T00:00:00Z", { stars: 10_000 }),
    ];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));
    saveClassifications(
      db,
      getUnclassifiedRepos(db, author.id),
      new Map([
        [
          "karpathy/nanoGPT",
          {
            category: "AI模型与训练基建" as const,
            summaryZh: "从零训练 GPT",
            monetization: "教学与课程" as const,
            moneyScore: 5,
          },
        ],
        [
          "karpathy/llm.c",
          {
            category: "AI应用与变现" as const,
            summaryZh: "纯 C 训练",
            monetization: "服务与咨询" as const,
            moneyScore: 4,
          },
        ],
      ]),
    );
    return author;
  }

  it("groups a tracked author's stars by money track for the in-app page", async () => {
    seedClassifiedAuthor();
    upsertSubscription(db, { login: "karpathy", alias: "Andrej" });

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/authors/karpathy/stars", { headers: auth() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      author: {
        login: string;
        alias: string;
        followers: number;
        unclassified: number;
        categories: Array<{ name: string; count: number; averageMoneyScore: string | null }>;
        topPicks: Array<{ fullName: string; moneyScore: number }>;
      };
    };

    expect(body.author).toMatchObject({
      login: "karpathy",
      alias: "Andrej",
      followers: 221175,
      unclassified: 0,
    });
    // Taxonomy order decides the section order, not the insert order.
    expect(body.author.categories.map((category) => category.name)).toEqual([
      "AI应用与变现",
      "AI模型与训练基建",
    ]);
    // A single scored repo averages to its own score.
    expect(body.author.categories[0]?.averageMoneyScore).toBe("4.0");
    expect(body.author.topPicks.map((repo) => repo.fullName)).toEqual([
      "karpathy/nanoGPT",
      "karpathy/llm.c",
    ]);
  });

  it("still serves repos whose classification is missing, and counts them", async () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/authors/karpathy/stars", { headers: auth() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      author: { unclassified: number; categories: Array<{ name: string; repos: unknown[] }> };
    };
    // Hiding unclassified rows would make the list look emptier than the
    // database is, so they render under the fallback category and are counted.
    expect(body.author.unclassified).toBe(1);
    expect(body.author.categories[0]?.name).toBe("其他");
    expect(body.author.categories[0]?.repos).toHaveLength(1);
  });

  it("answers 404 with an actionable hint for an author that was never synced", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/authors/nobody/stars", { headers: auth() });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("nobody"),
    });
  });
});

describe("roster api", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("serves the curated list with a live count once an author is stored", async () => {
    const author = upsertAuthor(db, profile);
    const edges = [
      starEdge("karpathy/nanoGPT", "2024-02-01T00:00:00Z", { stars: 20_000 }),
      starEdge("karpathy/llm.c", "2024-01-01T00:00:00Z", { stars: 10_000 }),
    ];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));
    saveClassifications(
      db,
      getUnclassifiedRepos(db, author.id),
      new Map([
        [
          "karpathy/nanoGPT",
          {
            category: "AI模型与训练基建" as const,
            summaryZh: "从零训练 GPT",
            monetization: "教学与课程" as const,
            moneyScore: 5,
          },
        ],
        [
          "karpathy/llm.c",
          {
            category: "AI模型与训练基建" as const,
            summaryZh: "纯 C 训练",
            monetization: "服务与咨询" as const,
            moneyScore: 4,
          },
        ],
      ]),
    );

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/roster", { headers: auth() });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      authors: Array<{
        login: string;
        followers: number;
        followersLive: boolean;
        tracked: boolean;
        syncedRepos: number;
        topCategories: Array<{ name: string; count: number }>;
      }>;
    };
    const karpathy = body.authors.find((entry) => entry.login === "karpathy");
    // The stored profile wins over the roster snapshot, and the two rows both
    // land in one track, so the card can show "AI模型与训练基建 ×2".
    expect(karpathy).toMatchObject({
      followers: 221175,
      followersLive: true,
      tracked: true,
      syncedRepos: 2,
    });
    expect(karpathy?.topCategories).toEqual([{ name: "AI模型与训练基建", count: 2 }]);

    const untouched = body.authors.find((entry) => entry.login === "ggerganov");
    expect(untouched).toMatchObject({ followersLive: false, tracked: false, syncedRepos: 0 });
    expect(untouched?.topCategories).toEqual([]);
  });
});

describe("trending api", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("reports an empty board before the first sync", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/trending", { headers: auth() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generatedAt: null,
      since: "daily",
      repos: [],
      rows: [],
    });
  });

  it("serves the board the last sync cached, without re-scraping", async () => {
    saveTrendingSnapshot(db, {
      generatedAt: "2026-09-12T03:04:05.000Z",
      since: "daily",
      repos: [
        {
          fullName: "a/one",
          url: "https://github.com/a/one",
          description: "desc",
          language: "Python",
          starsToday: 500,
          stars: 5000,
          forks: 50,
        },
      ],
      rows: [
        {
          fullName: "a/one",
          url: "https://github.com/a/one",
          starsToday: 500,
          stars: 5000,
          language: "Python",
          description: "desc",
          category: "AI应用与变现",
          summaryZh: "摘要",
          monetization: "SaaS 订阅",
          moneyScore: 5,
        },
      ],
    });

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/trending", { headers: auth() });
    const body = (await response.json()) as {
      generatedAt: string;
      since: string;
      repos: Array<{ fullName: string }>;
      rows: Array<{ fullName: string; category: string; moneyScore: number }>;
    };

    expect(body.generatedAt).toBe("2026-09-12T03:04:05.000Z");
    expect(body.since).toBe("daily");
    expect(body.repos.map((repo) => repo.fullName)).toEqual(["a/one"]);
    expect(body.rows[0]).toMatchObject({ category: "AI应用与变现", moneyScore: 5 });
  });

  it("treats a corrupted cache as an empty board rather than an error", async () => {
    setSetting(db, "trending_cache", "{not json");

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/trending", { headers: auth() });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ generatedAt: null, rows: [] });
  });

  it("requires the bearer token", async () => {
    const app = createApi({ db, config: testConfig() });
    expect((await app.request("/api/trending")).status).toBe(401);
  });
});

describe("weekly money api", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("reports an empty weekly board before the first sync", async () => {
    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/weekly-money", { headers: auth() });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      generatedAt: null,
      period: null,
      candidateCount: 0,
      picks: [],
      pushedAt: null,
    });
  });

  it("serves the exact Top 10 snapshot used for the Feishu push", async () => {
    const report = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    saveWeeklyMoneySnapshot(db, {
      report,
      pushedAt: "2026-10-19T02:00:00.000Z",
    });

    const app = createApi({ db, config: testConfig() });
    const response = await app.request("/api/weekly-money", { headers: auth() });
    const body = (await response.json()) as {
      period: { key: string; label: string };
      picks: Array<{ rank: number; reason: string; score: number }>;
      pushedAt: string;
    };

    expect(response.status).toBe(200);
    expect(body.period.key).toBe("2026-10-12_2026-10-18");
    expect(body.picks).toHaveLength(10);
    expect(body.picks[0]).toMatchObject({
      rank: 1,
      reason: expect.stringContaining("收入来自"),
    });
    expect(body.pushedAt).toBe("2026-10-19T02:00:00.000Z");
  });

  it("requires the bearer token", async () => {
    const app = createApi({ db, config: testConfig() });
    expect((await app.request("/api/weekly-money")).status).toBe(401);
  });
});
