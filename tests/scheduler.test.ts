import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSyncGate, createSyncScheduler, SyncBusyError } from "../src/scheduler.js";
import { readLoginStatus } from "../src/feishu/login-flow.js";
import { readGitHubLoginStatus } from "../src/github/login-flow.js";
import { notifyText } from "../src/feishu/notify.js";
import { getSetting, setSetting, upsertSubscription } from "../src/store.js";
import { createTestDb } from "./helpers.js";
import type { AppConfig } from "../src/config.js";
import type { runSync, SyncServiceResult } from "../src/service.js";

vi.mock("../src/feishu/login-flow.js", () => ({ readLoginStatus: vi.fn() }));
vi.mock("../src/github/login-flow.js", () => ({ readGitHubLoginStatus: vi.fn() }));
vi.mock("../src/feishu/notify.js", () => ({ notifyText: vi.fn() }));

const config: AppConfig = {
  githubToken: undefined, github: { cliPath: "gh", configDir: "unused" },
  feishu: { cliPath: "feishu-cli", appId: undefined, appSecret: undefined, userToken: undefined, spaceId: undefined },
  llm: { provider: "zhipu", apiKey: "", model: "", baseURL: "" },
  dbPath: ":memory:", api: { token: "test", host: "127.0.0.1", port: 8787 },
};
const success: SyncServiceResult = {
  spaceId: "space", outcomes: [], indexNodeToken: "index", indexUnchanged: true,
  indexMarkdown: "", trendingNodeToken: "board", trendingUnchanged: false,
  trendingCount: 10, trendingError: null, commercialNodeToken: "money",
  commercialUnchanged: false, commercialSummary: "", commercialError: null,
  newStars: 0, failed: 0, runId: 1, skipped: [],
};

describe("service daily scheduler", () => {
  const tasks: NonNullable<ReturnType<typeof createSyncScheduler>>[] = [];
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(readLoginStatus).mockResolvedValue({ loggedIn: true, appId: null, userName: null, scopes: [], hint: null, missingScopes: [] });
    vi.mocked(readGitHubLoginStatus).mockResolvedValue({ loggedIn: true, login: "tester", scopes: [], hint: null, tokenSource: null });
    vi.mocked(notifyText).mockResolvedValue(true);
  });
  afterEach(async () => {
    for (const task of tasks.splice(0)) await task.destroy();
    vi.useRealTimers();
  });

  function setup(env: NodeJS.ProcessEnv = {}) {
    const db = createTestDb();
    setSetting(db, "webhook", "https://example.com/test-webhook");
    upsertSubscription(db, { login: "karpathy", enabled: true });
    const runner = vi.fn<typeof runSync>().mockResolvedValue({ ...success });
    const log = vi.fn();
    const exclusive = createSyncGate();
    const task = createSyncScheduler({ db, config, exclusive, runner, log, env });
    if (task) tasks.push(task);
    return { db, runner, log, task, exclusive };
  }

  it("starts only when requested and schedules 09:00 in Shanghai", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T00:59:59Z"));
    const { task, runner } = setup();
    expect(task!.getStatus()).toBe("stopped");
    await task!.start();
    expect(task!.getNextRun()?.toISOString()).toBe("2026-09-14T01:00:00.000Z");
    await vi.advanceTimersByTimeAsync(1100);
    expect(runner).toHaveBeenCalledOnce();
    await task!.destroy();
    await vi.advanceTimersByTimeAsync(86400000);
    expect(runner).toHaveBeenCalledOnce();
  });

  it("can be disabled and rejects invalid schedules/timezones", () => {
    expect(setup({ SYNC_SCHEDULE_ENABLED: "false" }).task).toBeNull();
    expect(() => setup({ SYNC_CRON: "invalid" })).toThrow("SYNC_CRON");
    expect(() => setup({ SYNC_TIMEZONE: "Not/AZone" })).toThrow();
  });

  it("reads current subscriptions and keeps successful empty runs quiet", async () => {
    const { task, runner, db } = setup();
    upsertSubscription(db, { login: "antfu", enabled: true });
    await task!.execute();
    expect(runner.mock.calls[0]![0].subscriptions.authors.map(a => a.login)).toContain("antfu");
    expect(runner.mock.calls[0]![0].trigger).toBe("schedule");
    expect(notifyText).not.toHaveBeenCalled();
    expect(JSON.parse(getSetting(db, "scheduler_last_result")!).status).toBe("success");
  });

  it.each(["feishu", "github"])("stops when %s login expires and records a scan prompt", async (provider) => {
    const { task, runner, db } = setup();
    if (provider === "feishu") vi.mocked(readLoginStatus).mockResolvedValue({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null, missingScopes: [] });
    else vi.mocked(readGitHubLoginStatus).mockResolvedValue({ loggedIn: false, login: null, scopes: [], hint: null, tokenSource: null });
    await task!.execute();
    expect(runner).not.toHaveBeenCalled();
    expect(notifyText).toHaveBeenCalledWith(expect.stringContaining("重新扫码登录"), expect.anything());
    expect(JSON.parse(getSetting(db, "scheduler_last_result")!).status).toBe("failed");
  });

  it.each([
    { newStars: 3 }, { trendingCount: 0 }, { trendingError: "fetch failed" },
    { failed: 1, outcomes: [{ login: "antfu", error: "unexpected EOF" }] },
  ])("notifies on actionable results %j", async (overrides) => {
    const { task, runner } = setup();
    runner.mockResolvedValue({ ...success, ...overrides } as SyncServiceResult);
    await task!.execute();
    expect(notifyText).toHaveBeenCalledOnce();
    if (overrides.failed) expect(vi.mocked(notifyText).mock.calls[0]![0]).toContain("antfu：unexpected EOF");
  });

  it("records batch errors and survives webhook errors for the next run", async () => {
    const { task, runner, db, log } = setup();
    runner.mockRejectedValueOnce(new Error("index unexpected EOF"));
    vi.mocked(notifyText).mockRejectedValueOnce(new Error("webhook offline"));
    await task!.execute();
    expect(getSetting(db, "scheduler_last_result")).toContain("index unexpected EOF");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("webhook offline"));
    await task!.execute();
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it("skips a tick during manual sync and rejects manual sync during a scheduled run", async () => {
    const { task, runner, exclusive } = setup();
    await exclusive(async () => { await task!.execute(); });
    expect(runner).not.toHaveBeenCalled();
    runner.mockImplementationOnce(async () => {
      await expect(exclusive(async () => success)).rejects.toBeInstanceOf(SyncBusyError);
      return success;
    });
    await task!.execute();
    expect(runner).toHaveBeenCalledOnce();
  });
});
