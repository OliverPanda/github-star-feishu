import { describe, expect, it } from "vitest";
import { hashContent } from "../src/publish.js";
import { renderIndex, type IndexAuthor } from "../src/render/markdown.js";

function author(overrides: Partial<IndexAuthor> & { login: string }): IndexAuthor {
  return {
    displayName: null,
    repoCount: 0,
    ...overrides,
  };
}

const context = { generatedAt: new Date("2026-09-12T03:04:05Z") };

describe("renderIndex", () => {
  it("lists every tracked author with their repo count", () => {
    const markdown = renderIndex(
      [
        author({ login: "karpathy", displayName: "Andrej Karpathy", repoCount: 165 }),
        author({ login: "antfu", repoCount: 42 }),
      ],
      context,
    );

    expect(markdown).toContain("# GitHub Star 知识库");
    expect(markdown).toContain("收录 2 个账号");
    expect(markdown).toContain("[karpathy（Andrej Karpathy）](https://github.com/karpathy)");
    expect(markdown).toContain("[antfu](https://github.com/antfu)");
    expect(markdown).toContain("| 165 |");
    expect(markdown).toContain("| 42 |");
  });

  it("marks the reader's own account as 本人", () => {
    const markdown = renderIndex([author({ login: "me", isSelf: true })], context);
    expect(markdown).toContain("[me（本人）](https://github.com/me)");
  });

  it("links a document by URL, falls back to the node token, then to a dash", () => {
    const markdown = renderIndex(
      [
        author({ login: "a", nodeUrl: "https://example.com/doc" }),
        author({ login: "b", nodeToken: "wikcnAA" }),
        author({ login: "c" }),
      ],
      context,
    );

    expect(markdown).toContain("[打开文档](https://example.com/doc)");
    expect(markdown).toContain("node_token: `wikcnAA`");
    expect(markdown).toMatch(/\| \[c\]\(https:\/\/github\.com\/c\) \| 0 \| 正常 \| - \|/);
  });

  it("reports failures in the header and in the affected row", () => {
    const markdown = renderIndex(
      [author({ login: "ok" }), author({ login: "ghost", error: "找不到该账号" })],
      context,
    );

    expect(markdown).toContain("｜ 1 个账号同步失败");
    expect(markdown).toContain("失败：找不到该账号");
    // A single-pipe cell must not break out into an extra column.
    const row = markdown.split("\n").find((line) => line.startsWith("| [ghost]")) ?? "";
    expect(row.split("|")).toHaveLength(6);
  });

  it("omits the failure note when everything succeeded", () => {
    const markdown = renderIndex([author({ login: "ok" })], context);
    expect(markdown).not.toContain("同步失败");
  });

  it("tells the reader how to start when no author is configured", () => {
    const markdown = renderIndex([], context);
    expect(markdown).toContain("_还没有配置任何作者。");
  });
});

describe("renderIndex idempotency", () => {
  it("hashes the same across runs, so the index page is not rewritten daily", () => {
    const authors = [author({ login: "karpathy", repoCount: 165 })];
    const first = renderIndex(authors, { generatedAt: new Date("2026-09-12T03:04:05Z") });
    const second = renderIndex(authors, { generatedAt: new Date("2026-10-01T22:41:00Z") });

    expect(first).not.toBe(second);
    expect(hashContent(first)).toBe(hashContent(second));
  });

  it("changes the hash when the author list really changed", () => {
    const first = renderIndex([author({ login: "karpathy", repoCount: 165 })], context);
    const second = renderIndex([author({ login: "karpathy", repoCount: 166 })], context);
    expect(hashContent(first)).not.toBe(hashContent(second));
  });
});
