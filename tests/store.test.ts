import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import {
  getAuthorStars,
  getSyncState,
  getUnclassifiedRepos,
  saveClassifications,
  updateSyncState,
  upsertAuthor,
  upsertRepos,
  upsertStars,
} from "../src/store.js";
import { createTestDb, profile, starEdge } from "./helpers.js";

describe("store", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
  });

  it("upserts an author without duplicating the login", () => {
    const first = upsertAuthor(db, profile);
    const second = upsertAuthor(db, { ...profile, followers: 300000 });

    expect(second.id).toBe(first.id);
    expect(second.followers).toBe(300000);
  });

  it("ignores a repeated star edge so re-syncing is safe", () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];

    upsertStars(db, author.id, edges, upsertRepos(db, edges));
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    expect(getAuthorStars(db, author.id)).toHaveLength(1);
  });

  it("shares repo metadata across authors and counts cross-endorsement", () => {
    const karpathy = upsertAuthor(db, profile);
    const other = upsertAuthor(db, { ...profile, login: "ggerganov", name: "Georgi" });
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];

    upsertStars(db, karpathy.id, edges, upsertRepos(db, edges));
    upsertStars(db, other.id, edges, upsertRepos(db, edges));

    expect(getAuthorStars(db, karpathy.id)[0]?.endorsedBy).toBe(2);
  });

  it("tracks waterfall state so a later run can go incremental", () => {
    const author = upsertAuthor(db, profile);
    expect(getSyncState(db, author.id)).toBeUndefined();

    updateSyncState(db, author.id, {
      lastStarredAt: "2024-06-01T00:00:00Z",
      fullSyncCompletedAt: "2024-06-01T00:00:00Z",
      status: "ok",
    });
    updateSyncState(db, author.id, { lastStarredAt: "2024-07-01T00:00:00Z", status: "ok" });

    const state = getSyncState(db, author.id);
    expect(state?.lastStarredAt).toBe("2024-07-01T00:00:00Z");
    expect(state?.fullSyncCompletedAt).toBe("2024-06-01T00:00:00Z");
  });

  it("clears a previous error when a later run succeeds", () => {
    const author = upsertAuthor(db, profile);
    updateSyncState(db, author.id, { status: "error", error: "boom" });
    updateSyncState(db, author.id, { status: "ok", error: null });
    expect(getSyncState(db, author.id)?.status).toBe("ok");
  });

  it("classifies only unclassified repos and then stops reporting them", () => {
    const author = upsertAuthor(db, profile);
    const edges = [
      starEdge("a/b", "2024-01-01T00:00:00Z"),
      starEdge("c/d", "2024-01-02T00:00:00Z"),
    ];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    const pending = getUnclassifiedRepos(db, author.id);
    expect(pending).toHaveLength(2);

    saveClassifications(db, pending, new Map());
    expect(getUnclassifiedRepos(db, author.id)).toHaveLength(0);
  });

  it("falls back to 其他 for a repo the model did not answer for", () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    saveClassifications(db, getUnclassifiedRepos(db, author.id), new Map());

    expect(getAuthorStars(db, author.id)[0]?.category).toBe("其他");
  });

  it("keeps the model hint when one is returned", () => {
    const author = upsertAuthor(db, profile);
    const edges = [starEdge("a/b", "2024-01-01T00:00:00Z")];
    upsertStars(db, author.id, edges, upsertRepos(db, edges));

    saveClassifications(
      db,
      getUnclassifiedRepos(db, author.id),
      new Map([
        [
          "a/b",
          {
            category: "AI应用与变现" as const,
            summaryZh: "推理框架",
            monetization: "API 用量计费" as const,
            moneyScore: 5,
          },
        ],
      ]),
    );

    const row = getAuthorStars(db, author.id)[0];
    expect(row?.category).toBe("AI应用与变现");
    expect(row?.summaryZh).toBe("推理框架");
    expect(row?.monetization).toBe("API 用量计费");
    expect(row?.moneyScore).toBe(5);
  });
});
