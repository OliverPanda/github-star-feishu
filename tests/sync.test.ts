import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";
import type { Db } from "../src/db/client.js";
import { syncAuthor } from "../src/sync.js";
import { getSyncState } from "../src/store.js";
import { createTestDb } from "./helpers.js";

interface FakeStar {
  name: string;
  starredAt: string;
}

/**
 * Serves the current contents of `stars` on every page request. Watermark
 * filtering happens inside `fetchStarredRepos`, so the fake ignores `since`;
 * tests mutate the array between runs to simulate newly starred repos.
 */
function fakeClient(stars: FakeStar[]): Octokit {
  const graphql = vi.fn(async () => ({
    user: {
      login: "karpathy",
      name: "Andrej",
      avatarUrl: null,
      followers: { totalCount: 221175 },
      starredRepositories: {
        totalCount: stars.length,
        pageInfo: { hasNextPage: false, endCursor: null },
        edges: stars.map((star) => ({
          starredAt: star.starredAt,
          node: {
            nameWithOwner: star.name,
            description: `${star.name} description`,
            primaryLanguage: { name: "Python" },
            stargazerCount: 1000,
            forkCount: 10,
            homepageUrl: null,
            pushedAt: "2024-01-01T00:00:00Z",
            isArchived: false,
            repositoryTopics: { nodes: [] },
          },
        })),
      },
    },
  }));
  return { graphql } as unknown as Octokit;
}

const initialStars: FakeStar[] = [
  { name: "new/one", starredAt: "2024-07-01T00:00:00Z" },
  { name: "old/two", starredAt: "2024-06-01T00:00:00Z" },
];

let stars: FakeStar[];

describe("syncAuthor", () => {
  let db: Db;

  beforeEach(() => {
    db = createTestDb();
    stars = [...initialStars];
  });

  it("does a full walk on the first run and stores every star", async () => {
    const result = await syncAuthor({
      db,
      github: fakeClient(stars),
      login: "karpathy",
      skipClassify: true,
    });

    expect(result.incremental).toBe(false);
    expect(result.newStars).toBe(2);
    expect(result.totalStars).toBe(2);
    expect(result.author.login).toBe("karpathy");
  });

  it("goes incremental once a full walk has completed", async () => {
    // First run only knows the older star, so the watermark lands on 2024-06-01.
    const oldestOnly: FakeStar[] = [{ name: "old/two", starredAt: "2024-06-01T00:00:00Z" }];
    const github = fakeClient(oldestOnly);
    await syncAuthor({ db, github, login: "karpathy", skipClassify: true });

    // A repo starred after the watermark is the only one the next run should pull.
    oldestOnly.unshift({ name: "new/one", starredAt: "2024-07-01T00:00:00Z" });
    const second = await syncAuthor({ db, github, login: "karpathy", skipClassify: true });

    expect(second.incremental).toBe(true);
    expect(second.newStars).toBe(1);
    expect(second.totalStars).toBe(2);
  });

  it("re-walks everything when --full is passed", async () => {
    const github = fakeClient(stars);
    await syncAuthor({ db, github, login: "karpathy", skipClassify: true });
    const full = await syncAuthor({ db, github, login: "karpathy", skipClassify: true, full: true });

    expect(full.incremental).toBe(false);
    expect(full.newStars).toBe(2);
  });

  it("does not arm the watermark when the first walk found nothing", async () => {
    const empty = fakeClient([]);
    await syncAuthor({ db, github: empty, login: "karpathy", skipClassify: true });

    const author = db.query.authors.findFirst();
    const state = getSyncState(db, (author as never as { id: number }).id ?? 1);
    expect(state?.lastStarredAt ?? null).toBeNull();

    const again = await syncAuthor({ db, github: empty, login: "karpathy", skipClassify: true });
    expect(again.incremental).toBe(false);
  });

  it("renders unclassified repos under the fallback category", async () => {
    const result = await syncAuthor({
      db,
      github: fakeClient(stars),
      login: "karpathy",
      skipClassify: true,
    });

    expect(result.counts).toEqual({ 其他: 2 });
    expect(result.markdown).toContain("## 其他");
  });

  it("classifies pending repos through the provided model", async () => {
    const reply = JSON.stringify([
      {
        full_name: "new/one",
        category: "AI应用与变现",
        monetization: "API 用量计费",
        money_score: 5,
        summary: "推理框架",
      },
      {
        full_name: "old/two",
        category: "学习资源与技能",
        monetization: "教学与课程",
        money_score: 2,
        summary: "教程合集",
      },
    ]);
    const model = {
      specificationVersion: "v3",
      provider: "test",
      modelId: "test-model",
      doGenerate: async () => ({
        content: [{ type: "text", text: reply }],
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      }),
      doStream: async () => {
        throw new Error("not implemented");
      },
    };

    const result = await syncAuthor({
      db,
      github: fakeClient(stars),
      login: "karpathy",
      model: model as never,
    });

    expect(result.classified).toBe(2);
    expect(result.counts).toEqual({ AI应用与变现: 1, 学习资源与技能: 1 });
    // The money ranking is fed by the model's score, so a real sync must fill it.
    expect(result.markdown).toContain("## 变现机会榜");
  });
});
