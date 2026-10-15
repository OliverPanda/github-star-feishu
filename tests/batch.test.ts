import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";
import type { BatchOptions } from "../src/batch.js";
import { runBatch, sectionTitle } from "../src/batch.js";
import type { Db } from "../src/db/client.js";
import type {
  ContainerRequest,
  WikiNodeSummary,
  WikiWriteRequest,
  WikiWriteResult,
  WikiWriter,
} from "../src/feishu/types.js";
import { getWikiNode } from "../src/store.js";
import type { Subscription } from "../src/subscriptions.js";
import { readTrendingSnapshot } from "../src/trending-board.js";
import { createTestDb, stubFetch, trendingFixture } from "./helpers.js";

interface FakeStar {
  name: string;
  starredAt: string;
}

/**
 * Serves a per-login star list. `failFor` reproduces the "account renamed or
 * made private" case so the batch continues past a broken author.
 */
function fakeClient(starsByLogin: Record<string, FakeStar[]>, failFor: string[] = []): Octokit {
  const graphql = vi.fn(async (_query: string, variables: { login: string }) => {
    const { login } = variables;
    if (failFor.includes(login)) {
      const error = new Error("boom") as Error & { errors?: unknown[] };
      error.errors = [{ type: "NOT_FOUND", message: `Could not resolve to a User with the login of '${login}'.` }];
      throw error;
    }
    const stars = starsByLogin[login] ?? [];
    return {
      user: {
        login,
        name: `${login} name`,
        avatarUrl: null,
        followers: { totalCount: 100 },
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
    };
  });
  return { graphql } as unknown as Octokit;
}

class FakeWriter implements WikiWriter {
  readonly name = "fake";
  readonly documents: WikiWriteRequest[] = [];
  readonly containers: ContainerRequest[] = [];
  private containerCount = 0;

  async ensureSpace(name: string): Promise<string> {
    return name;
  }

  async listNodes(): Promise<WikiNodeSummary[]> {
    return [];
  }

  async upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult> {
    this.documents.push(request);
    return {
      nodeToken: request.existingNodeToken ?? `doc-${this.documents.length}`,
      documentId: null,
      url: null,
      skipped: false,
    };
  }

  async createContainer(request: ContainerRequest): Promise<WikiWriteResult> {
    this.containers.push(request);
    const nodeToken = request.existingNodeToken ?? `section-${++this.containerCount}`;
    return { nodeToken, documentId: null, url: null, skipped: false };
  }
}

function author(login: string, overrides: Partial<Subscription> = {}): Subscription {
  return { login, alias: undefined, self: false, enabled: true, ...overrides };
}

const stars: Record<string, FakeStar[]> = {
  karpathy: [
    { name: "a/one", starredAt: "2024-07-01T00:00:00Z" },
    { name: "b/two", starredAt: "2024-06-01T00:00:00Z" },
  ],
  antfu: [{ name: "c/three", starredAt: "2024-05-01T00:00:00Z" }],
};

const SPACE = "space-1";

describe("runBatch", () => {
  let db: Db;
  let writer: FakeWriter;

  beforeEach(() => {
    db = createTestDb();
    writer = new FakeWriter();
  });

  function run(options: Partial<BatchOptions> = {}) {
    return runBatch({
      db,
      writer,
      github: fakeClient(stars),
      spaceId: SPACE,
      authors: [author("karpathy"), author("antfu")],
      skipClassify: true,
      retries: 0,
      now: new Date("2026-09-12T03:04:05Z"),
      // The board scrapes github.com; a stub keeps every case hermetic.
      trendingFetch: stubFetch(trendingFixture()),
      ...options,
    });
  }

  it("syncs every author and reports their totals", async () => {
    const result = await run({});

    expect(result.failed).toBe(0);
    expect(result.outcomes.map((o) => o.login)).toEqual(["karpathy", "antfu"]);
    expect(result.outcomes[0]?.totalStars).toBe(2);
    expect(result.outcomes[1]?.totalStars).toBe(1);
    expect(result.newStars).toBe(3);
  });

  it("returns the rendered index page for callers to export", async () => {
    const result = await run({});

    expect(result.indexMarkdown).toContain("# GitHub Star 知识库");
    expect(result.indexMarkdown).toContain("karpathy");
    expect(result.indexMarkdown).toContain("antfu");
  });

  it("builds one subtree per author and files each document inside it", async () => {
    await run({});

    expect(writer.containers).toHaveLength(2);
    expect(writer.containers[0]?.title).toBe("karpathy");

    const karpathyDoc = writer.documents.find((d) => d.docKey === "karpathy__stars");
    expect(karpathyDoc?.parentNodeToken).toBe("section-1");
    expect(getWikiNode(db, "karpathy__section", SPACE)?.nodeToken).toBe("section-1");

    const antfuDoc = writer.documents.find((d) => d.docKey === "antfu__stars");
    expect(antfuDoc?.parentNodeToken).toBe("section-2");
  });

  it("reuses the remembered subtree instead of creating a duplicate", async () => {
    const first = await run({});
    const firstContainers = writer.containers.length;
    const second = await run({});

    // The remembered token short-circuits the whole creation path, so the
    // second run neither asks the writer for a container nor makes a new one.
    expect(writer.containers).toHaveLength(firstContainers);
    expect(second.outcomes[0]?.sectionToken).toBe(first.outcomes[0]?.sectionToken);
    expect(getWikiNode(db, "karpathy__section", SPACE)).toBeDefined();
  });

  it("honours a parent node for the whole set of subtrees", async () => {
    await run({ parentNodeToken: "root-1" });
    expect(writer.containers[0]?.parentNodeToken).toBe("root-1");
  });

  it("keeps going when one author fails and still publishes the index", async () => {
    const result = await run({
      authors: [author("karpathy"), author("ghost"), author("antfu")],
      github: fakeClient(stars, ["ghost"]),
    });

    expect(result.failed).toBe(1);
    expect(result.outcomes.map((o) => o.error !== null)).toEqual([false, true, false]);
    expect(result.outcomes[1]?.error).toMatch(/ghost/);
    // The healthy authors must still land in the knowledge base.
    expect(getWikiNode(db, "karpathy__stars", SPACE)).toBeDefined();
    expect(getWikiNode(db, "antfu__stars", SPACE)).toBeDefined();
    expect(getWikiNode(db, "ghost__stars", SPACE)).toBeUndefined();
    expect(getWikiNode(db, "__index", SPACE)).toBeDefined();
  });

  it("reports a failed author without a document or subtree token", async () => {
    const result = await run({
      authors: [author("ghost")],
      github: fakeClient(stars, ["ghost"]),
    });

    expect(result.outcomes[0]?.nodeToken).toBeNull();
    expect(result.outcomes[0]?.sectionToken).toBeNull();
  });

  it("translates a not-found account into a readable Chinese reason", async () => {
    const result = await run({
      authors: [author("ghost")],
      github: fakeClient(stars, ["ghost"]),
    });

    expect(result.outcomes[0]?.error).toBe("找不到该 GitHub 账号（ghost）");
  });

  it("publishes the landing page after the authors", async () => {
    const result = await run({});

    const index = writer.documents.find((d) => d.docKey === "__index");
    expect(index).toBeDefined();
    expect(index?.title).toBe("GitHub Star 知识库");
    expect(index?.markdown).toContain("karpathy");
    expect(index?.markdown).toContain("antfu");
    expect(result.indexNodeToken).toBeTruthy();
  });

  it("places the landing page under its own parent when one is given", async () => {
    await run({ parentNodeToken: "root-1", indexParentNodeToken: "root-index" });
    const index = writer.documents.find((d) => d.docKey === "__index");
    expect(index?.parentNodeToken).toBe("root-index");
  });

  it("skips rewriting an unchanged author document on the second run", async () => {
    await run({});
    writer.documents.length = 0;
    const second = await run({});

    expect(second.outcomes.every((o) => o.unchanged)).toBe(true);
    expect(second.indexUnchanged).toBe(true);
    expect(second.newStars).toBe(0);
    expect(writer.documents).toHaveLength(0);
  });

  it("marks the self account so its document title reads 本人", async () => {
    await run({ authors: [author("karpathy", { self: true })] });
    const doc = writer.documents.find((d) => d.docKey === "karpathy__stars");
    expect(doc?.title).toBe("我的 Star 精选");
  });

  it("handles an author with no stars at all", async () => {
    const result = await run({ authors: [author("empty")] });
    expect(result.outcomes[0]?.totalStars).toBe(0);
    expect(result.outcomes[0]?.error).toBeNull();
  });

  it("publishes no author document when no author is configured", async () => {
    const result = await run({ authors: [] });

    expect(result.outcomes).toHaveLength(0);
    expect(result.failed).toBe(0);
    // Only the two standalone pages are written; the trending board ships even
    // on a run with nobody subscribed, because it is useful on its own.
    expect(writer.documents.map((d) => d.docKey)).toEqual(["__index", "__trending"]);
  });

  it("keeps authors missing from this run on the index page", async () => {
    await run({});
    writer.documents.length = 0;

    // Scoped runs are how the extension backs "一键整理" for one recommended
    // author; the landing page must not shrink to whoever the run touched.
    const scoped = await run({ authors: [author("karpathy")] });

    expect(scoped.outcomes.map((o) => o.login)).toEqual(["karpathy"]);
    expect(scoped.indexMarkdown).toContain("karpathy");
    expect(scoped.indexMarkdown).toContain("antfu");
    expect(scoped.indexMarkdown).toContain("收录 2 个账号");
  });

  it("lists an author that failed before ever being stored", async () => {
    const result = await run({
      authors: [author("karpathy"), author("ghost")],
      github: fakeClient(stars, ["ghost"]),
    });

    // `ghost` never reaches the authors table, so it is only visible because
    // the index also carries this run's failures.
    expect(result.indexMarkdown).toContain("ghost");
    expect(result.indexMarkdown).toContain("失败：找不到该 GitHub 账号（ghost）");
  });

  it("publishes the trending board as its own document", async () => {
    const result = await run({});

    const board = writer.documents.find((d) => d.docKey === "__trending");
    expect(board?.title).toBe("GitHub 上涨趋势榜");
    expect(board?.markdown).toContain("# GitHub 上涨趋势榜");
    // The ranking is by today's gain, so the fixture's biggest gainer leads.
    expect(board?.markdown).toContain("bilawalsidhu/gods-eye-view");
    expect(board?.markdown).toContain("+2,265");
    expect(result.trendingCount).toBeGreaterThan(0);
    expect(result.trendingError).toBeNull();
    expect(result.trendingNodeToken).toBeTruthy();
  });

  it("files the trending board under the landing page's parent", async () => {
    await run({ indexParentNodeToken: "root-index" });
    const board = writer.documents.find((d) => d.docKey === "__trending");
    expect(board?.parentNodeToken).toBe("root-index");
  });

  it("keeps the trending board beside the space root when it has no parent", async () => {
    await run({});
    const board = writer.documents.find((d) => d.docKey === "__trending");
    expect(board?.parentNodeToken).toBeUndefined();
  });

  it("survives a failed scrape without failing the run", async () => {
    const result = await run({ trendingFetch: stubFetch("", { ok: false, status: 500 }) });

    // The board is the only step that scrapes a page; a GitHub outage there
    // must not be reported as a sync failure when every author landed fine.
    expect(result.failed).toBe(0);
    expect(result.trendingError).toBeNull();
    expect(result.trendingCount).toBe(0);
    expect(getWikiNode(db, "karpathy__stars", SPACE)).toBeDefined();
    expect(writer.documents.find((d) => d.docKey === "__trending")?.markdown).toContain("暂无数据");
  });

  it("reports a throwing fetch as a board error and still publishes the authors", async () => {
    const boom = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;

    const result = await run({ trendingFetch: boom });

    expect(result.failed).toBe(0);
    expect(result.trendingCount).toBe(0);
    expect(getWikiNode(db, "karpathy__stars", SPACE)).toBeDefined();
    expect(getWikiNode(db, "__index", SPACE)).toBeDefined();
  });

  it("caches the board so the API can serve it without re-scraping", async () => {
    await run({});

    const cached = readTrendingSnapshot(db);
    expect(cached?.since).toBe("daily");
    expect(cached?.generatedAt).toBe("2026-09-12T03:04:05.000Z");
    expect(cached?.rows[0]?.fullName).toBe("bilawalsidhu/gods-eye-view");
  });

  it("records the trending window it was asked for", async () => {
    await run({ trendingSince: "weekly" });

    expect(readTrendingSnapshot(db)?.since).toBe("weekly");
    expect(writer.documents.find((d) => d.docKey === "__trending")?.markdown).toContain("每周");
  });

  it("skips the board entirely when it is switched off", async () => {
    const result = await run({ trending: false });

    expect(writer.documents.map((d) => d.docKey)).toEqual(["karpathy__stars", "antfu__stars", "__index"]);
    expect(result.trendingNodeToken).toBeNull();
    expect(result.trendingCount).toBe(0);
    expect(readTrendingSnapshot(db)).toBeNull();
  });
});

describe("sectionTitle", () => {
  it("uses the alias when present so the tree reads like a name", () => {
    expect(sectionTitle(author("karpathy", { alias: "Andrej Karpathy" }))).toBe(
      "Andrej Karpathy（karpathy）",
    );
    expect(sectionTitle(author("antfu"))).toBe("antfu");
  });
});
