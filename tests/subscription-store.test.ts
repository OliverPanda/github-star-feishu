import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import {
  deleteSubscription,
  finishSyncRun,
  getSetting,
  getSubscription,
  listSubscriptions,
  listSyncRuns,
  setSetting,
  startSyncRun,
  upsertSubscription,
} from "../src/store.js";
import { createTestDb } from "./helpers.js";

describe("subscription store", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("adds a subscription with sane defaults", () => {
    const saved = upsertSubscription(db, { login: "karpathy" });

    expect(saved.login).toBe("karpathy");
    expect(saved.alias).toBeNull();
    expect(saved.isSelf).toBe(false);
    expect(saved.enabled).toBe(true);
  });

  it("keeps the original casing when re-adding a login in another case", () => {
    upsertSubscription(db, { login: "Torvalds" });
    upsertSubscription(db, { login: "torvalds", alias: "Linus" });

    const all = listSubscriptions(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.login).toBe("Torvalds");
    expect(all[0]?.alias).toBe("Linus");
  });

  it("finds a subscription regardless of the requested casing", () => {
    upsertSubscription(db, { login: "karpathy" });

    expect(getSubscription(db, "Karpathy")?.login).toBe("karpathy");
    expect(getSubscription(db, "nobody")).toBeUndefined();
  });

  it("updates an existing subscription instead of inserting a second row", () => {
    const first = upsertSubscription(db, { login: "karpathy" });
    const second = upsertSubscription(db, { login: "karpathy", enabled: false, isSelf: true });

    expect(second.id).toBe(first.id);
    expect(second.enabled).toBe(false);
    expect(second.isSelf).toBe(true);
    expect(listSubscriptions(db)).toHaveLength(1);
  });

  it("clears an alias when the update omits it", () => {
    upsertSubscription(db, { login: "karpathy", alias: "Andrej" });
    const updated = upsertSubscription(db, { login: "karpathy" });

    expect(updated.alias).toBeNull();
  });

  it("reports how many rows a delete removed", () => {
    upsertSubscription(db, { login: "karpathy" });

    expect(deleteSubscription(db, "KARPATHY")).toBe(1);
    expect(deleteSubscription(db, "KARPATHY")).toBe(0);
    expect(listSubscriptions(db)).toEqual([]);
  });

  it("lists subscriptions in insertion order so the UI stays stable", () => {
    upsertSubscription(db, { login: "karpathy" });
    upsertSubscription(db, { login: "antfu" });
    upsertSubscription(db, { login: "sindresorhus" });

    expect(listSubscriptions(db).map((s) => s.login)).toEqual([
      "karpathy",
      "antfu",
      "sindresorhus",
    ]);
  });

  it("stores and overwrites settings", () => {
    expect(getSetting(db, "space")).toBeUndefined();

    setSetting(db, "space", "GitHub Star 精选");
    expect(getSetting(db, "space")).toBe("GitHub Star 精选");

    setSetting(db, "space", "另一个知识库");
    expect(getSetting(db, "space")).toBe("另一个知识库");
  });
});

describe("sync run history", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("opens a run as running and closes it with the outcome", () => {
    const id = startSyncRun(db, { trigger: "api", totalAuthors: 2 });

    expect(listSyncRuns(db)[0]?.status).toBe("running");
    expect(listSyncRuns(db)[0]?.finishedAt).toBeNull();

    finishSyncRun(db, id, {
      status: "partial",
      newStars: 7,
      failedAuthors: 1,
      authors: [
        { login: "karpathy", newStars: 7, totalStars: 10, unchanged: false, error: null },
        { login: "antfu", newStars: 0, totalStars: 0, unchanged: false, error: "找不到账号" },
      ],
    });

    const run = listSyncRuns(db)[0];
    expect(run?.status).toBe("partial");
    expect(run?.newStars).toBe(7);
    expect(run?.failedAuthors).toBe(1);
    expect(run?.authors).toHaveLength(2);
    expect(run?.authors[1]?.error).toBe("找不到账号");
    expect(run?.finishedAt).not.toBeNull();
  });

  it("returns the newest run first", () => {
    const first = startSyncRun(db, { trigger: "cli", totalAuthors: 1 });
    finishSyncRun(db, first, { status: "success" });
    const second = startSyncRun(db, { trigger: "api", totalAuthors: 1 });
    finishSyncRun(db, second, { status: "success" });

    const runs = listSyncRuns(db);
    expect(runs[0]?.id).toBe(second);
    expect(runs[1]?.id).toBe(first);
  });

  it("honours the limit", () => {
    for (let index = 0; index < 5; index += 1) {
      finishSyncRun(db, startSyncRun(db, { trigger: "cli", totalAuthors: 1 }), {
        status: "success",
      });
    }

    expect(listSyncRuns(db, 3)).toHaveLength(3);
  });

  it("treats an unset detail as an empty author list", () => {
    const id = startSyncRun(db, { trigger: "cli", totalAuthors: 0 });
    finishSyncRun(db, id, { status: "failed", error: "配置缺失" });

    const run = listSyncRuns(db)[0];
    expect(run?.authors).toEqual([]);
    expect(run?.error).toBe("配置缺失");
  });
});
