import { describe, expect, it } from "vitest";
import { renderMarkdown, type RenderContext, type RenderedRepo } from "../src/render/markdown.js";
import type { Category } from "../src/taxonomy.js";

function repo(overrides: Partial<RenderedRepo> & { fullName: string }): RenderedRepo {
  return {
    url: `https://github.com/${overrides.fullName}`,
    description: "desc",
    language: "Python",
    stars: 100,
    starredAt: "2024-01-01T00:00:00Z",
    category: "AI应用与变现" as Category,
    summaryZh: "摘要",
    endorsedBy: 1,
    ...overrides,
  };
}

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    login: "karpathy",
    displayName: "Andrej",
    followers: 221175,
    starredCount: 165,
    isSelf: false,
    generatedAt: new Date("2026-09-12T03:04:05Z"),
    dataUpdatedAt: "2024-06-01T00:00:00Z",
    trackedAuthors: ["karpathy"],
    ...overrides,
  };
}

describe("renderMarkdown", () => {
  it("groups repos by taxonomy order and counts them", () => {
    const result = renderMarkdown(
      [
        repo({ fullName: "a/b", category: "开发者工具与云服务" }),
        repo({ fullName: "c/d", category: "AI应用与变现" }),
        repo({ fullName: "e/f", category: "AI应用与变现" }),
      ],
      context(),
    );

    expect(result.counts).toEqual({ AI应用与变现: 2, 开发者工具与云服务: 1 });
    expect(result.markdown.indexOf("## AI应用与变现")).toBeLessThan(
      result.markdown.indexOf("## 开发者工具与云服务"),
    );
    expect(result.markdown).toContain("- AI应用与变现（2）");
  });

  it("orders repos by stars then star date", () => {
    const result = renderMarkdown(
      [
        repo({ fullName: "low/stars", stars: 10 }),
        repo({ fullName: "high/stars", stars: 9000 }),
        repo({ fullName: "mid/newer", stars: 500, starredAt: "2024-05-01T00:00:00Z" }),
        repo({ fullName: "mid/older", stars: 500, starredAt: "2024-01-01T00:00:00Z" }),
      ],
      context(),
    );

    const order = ["high/stars", "mid/newer", "mid/older", "low/stars"].map((name) =>
      result.markdown.indexOf(name),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("is byte-identical across runs so the writer can skip no-op updates", () => {
    const repos = [
      repo({ fullName: "a/b" }),
      repo({ fullName: "c/d", category: "学习资源与技能" }),
    ];
    const first = renderMarkdown(repos, context({ generatedAt: new Date("2026-09-12T03:04:05Z") }));
    const second = renderMarkdown(repos, context({ generatedAt: new Date("2026-09-12T03:04:05Z") }));
    expect(first.markdown).toBe(second.markdown);
  });

  it("keeps the data date stable while the run timestamp varies", () => {
    const repos = [repo({ fullName: "a/b" })];
    const first = renderMarkdown(repos, context({ generatedAt: new Date("2026-09-12T03:04:05Z") }));
    const second = renderMarkdown(repos, context({ generatedAt: new Date("2026-09-13T21:30:00Z") }));

    expect(first.markdown).toContain("数据更新至 2024-06-01");
    expect(second.markdown).toContain("数据更新至 2024-06-01");
    expect(first.markdown).not.toBe(second.markdown);
  });

  it("escapes pipes and newlines so table cells stay intact", () => {
    const result = renderMarkdown(
      [repo({ fullName: "a/b", summaryZh: "含 | 竖线\n和换行" })],
      context(),
    );
    expect(result.markdown).toContain("含 \\| 竖线 和换行");
  });

  it("surfaces cross-endorsed repos only when several authors are tracked", () => {
    const repos = [repo({ fullName: "shared/lib", endorsedBy: 3 })];
    const many = renderMarkdown(repos, context({ trackedAuthors: ["karpathy", "ggerganov"] }));
    const one = renderMarkdown(repos, context({ trackedAuthors: ["karpathy"] }));

    expect(many.markdown).toContain("## 多位关注对象共同收藏");
    expect(many.markdown).toContain("shared/lib");
    expect(one.markdown).not.toContain("## 多位关注对象共同收藏");
  });

  it("renders the self variant with its own heading", () => {
    const result = renderMarkdown([repo({ fullName: "a/b" })], context({ isSelf: true }));
    expect(result.markdown).toContain("# 我的 GitHub Star 精选");
  });

  it("handles an empty library without producing a broken table", () => {
    const result = renderMarkdown([], context());
    expect(result.markdown).toContain("_暂无可展示的条目。_");
    expect(result.counts).toEqual({});
  });

  it("splits a large category so no table exceeds the Feishu cell limit", () => {
    // Feishu rejects any table with more than 2000 cells, which a prolific
    // account blows through in a single category.
    const repos = Array.from({ length: 900 }, (_, index) =>
      repo({ fullName: `big/repo-${index}` }),
    );
    const result = renderMarkdown(repos, context());

    const tables = result.markdown.split("\n\n").filter((block) => block.startsWith("|"));
    expect(tables.length).toBeGreaterThan(1);
    for (const table of tables) {
      const rows = table.trim().split("\n");
      const cells = rows.reduce((sum, row) => sum + row.split("|").length - 2, 0);
      expect(cells).toBeLessThanOrEqual(2000);
    }

    // Every repository survives the split, and the parts are labelled.
    for (const index of [0, 450, 899]) {
      expect(result.markdown).toContain(`big/repo-${index}`);
    }
    expect(result.markdown).toMatch(/## AI应用与变现（1\/\d+）/);
  });

  it("keeps the plain heading when a category fits in one table", () => {
    const result = renderMarkdown([repo({ fullName: "a/b" })], context());
    expect(result.markdown).toContain("## AI应用与变现\n");
    expect(result.markdown).not.toMatch(/## AI应用与变现（1\/1）/);
  });

  it("lists the repo table under the money-oriented columns", () => {
    const result = renderMarkdown([repo({ fullName: "a/b" })], context());
    expect(result.markdown).toContain("| 仓库 | 变现路径 | 潜力 | 语言 | Stars | 收藏时间 | 一句话说明 |");
  });

  it("ranks only repos scored at or above the headline threshold", () => {
    const result = renderMarkdown(
      [
        repo({ fullName: "rich/one", moneyScore: 5, monetization: "交易与投资" }),
        repo({ fullName: "solid/two", moneyScore: 4 }),
        repo({ fullName: "meh/three", moneyScore: 3 }),
      ],
      context(),
    );

    expect(result.markdown).toContain("## 变现机会榜");
    expect(result.markdown).toContain("交易与投资");
    const ranking = result.markdown.slice(
      result.markdown.indexOf("## 变现机会榜"),
      result.markdown.indexOf("## 目录"),
    );
    expect(ranking).toContain("rich/one");
    expect(ranking).toContain("solid/two");
    expect(ranking).not.toContain("meh/three");
    // Higher score sorts first, so the strongest opportunity leads the page.
    expect(ranking.indexOf("rich/one")).toBeLessThan(ranking.indexOf("solid/two"));
  });

  it("renders the score as filled dots and a dash when never judged", () => {
    const result = renderMarkdown(
      [
        repo({ fullName: "scored/one", moneyScore: 4, monetization: "SaaS 订阅" }),
        repo({ fullName: "unscored/two" }),
      ],
      context(),
    );
    expect(result.markdown).toContain("SaaS 订阅 | ●●●●○ 4");
    // A legacy row has no score, so it shows a dash rather than an invented 1.
    expect(result.markdown).toContain("暂不明朗 | - |");
  });

  it("omits the ranking when nothing was scored", () => {
    const result = renderMarkdown([repo({ fullName: "a/b" })], context());
    expect(result.markdown).not.toContain("## 变现机会榜");
  });

  it("shows the average potential per category in the table of contents", () => {
    const result = renderMarkdown(
      [
        repo({ fullName: "a/b", moneyScore: 5 }),
        repo({ fullName: "c/d", moneyScore: 3 }),
        repo({ fullName: "e/f", category: "学习资源与技能" }),
      ],
      context(),
    );
    expect(result.markdown).toContain("- AI应用与变现（2，平均潜力 4.0）");
    // An unscored category has nothing to average, so it keeps the plain count.
    expect(result.markdown).toContain("- 学习资源与技能（1）");
  });
});
