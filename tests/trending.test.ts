import { describe, expect, it, vi } from "vitest";
import { fetchTrending, parseTrending, TRENDING_URL } from "../src/github/trending.js";
import { renderTrending, type TrendingRow } from "../src/render/markdown.js";
import type { Category } from "../src/taxonomy.js";
import { stubFetch, trendingFixture } from "./helpers.js";

describe("parseTrending", () => {
  it("reads every trending card out of a real page", () => {
    const repos = parseTrending(trendingFixture());

    expect(repos).toHaveLength(2);
    expect(repos[0]).toEqual({
      fullName: "bilawalsidhu/gods-eye-view",
      url: "https://github.com/bilawalsidhu/gods-eye-view",
      description: expect.stringContaining("spy satellite simulator"),
      language: "JavaScript",
      starsToday: 2265,
      stars: 30777,
      forks: expect.any(Number),
    });
    expect(repos[1]?.fullName).toBe("melgarafael/DeskcommCRM");
    expect(repos[1]?.starsToday).toBe(504);
  });

  it("takes the repository name from the link, not the anchor text", () => {
    // The anchor renders "owner /\nname" across two spans, so parsing the text
    // would need to special case the separator; the href is authoritative.
    const repos = parseTrending(trendingFixture());
    expect(repos.every((repo) => !repo.fullName.includes("\n"))).toBe(true);
  });

  it("returns nothing when the page markup changes shape", () => {
    expect(parseTrending("<html><body><p>redesigned</p></body></html>")).toEqual([]);
  });

  it("skips a card whose link is not a repository path", () => {
    const html = `
      <article class="Box-row"><h2><a href="/login">Sign in</a></h2></article>
      <article class="Box-row"><h2><a href="/owner/only">owner / </a></h2>
        <span>7 stars today</span></article>`;
    const repos = parseTrending(html);

    expect(repos.map((repo) => repo.fullName)).toEqual(["owner/only"]);
    expect(repos[0]?.starsToday).toBe(7);
  });

  it("falls back to null for a description or language the card omits", () => {
    const html = `<article class="Box-row"><h2><a href="/a/b">a</a></h2>
      <span>3 stars today</span></article>`;
    const repos = parseTrending(html);

    expect(repos[0]?.description).toBeNull();
    expect(repos[0]?.language).toBeNull();
    expect(repos[0]?.stars).toBe(0);
  });

  it("reads a bare count without a thousands separator", () => {
    const html = `<article class="Box-row"><h2><a href="/a/b">a</a></h2>
      <span>9 stars today</span></article>`;
    expect(parseTrending(html)[0]?.starsToday).toBe(9);
  });
});

describe("fetchTrending", () => {
  it("requests the daily window and ranks by today's gain", async () => {
    const fetchImpl = vi.fn(stubFetch(trendingFixture()));
    const repos = await fetchTrending({ fetchImpl });

    expect(fetchImpl).toHaveBeenCalledWith(
      `${TRENDING_URL}?since=daily`,
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(repos.map((repo) => repo.fullName)).toEqual([
      "bilawalsidhu/gods-eye-view",
      "melgarafael/DeskcommCRM",
    ]);
  });

  it("keeps only the requested number of gainers", async () => {
    const repos = await fetchTrending({ top: 1, fetchImpl: stubFetch(trendingFixture()) });
    expect(repos.map((repo) => repo.fullName)).toEqual(["bilawalsidhu/gods-eye-view"]);
  });

  it("asks for the window it was given", async () => {
    const fetchImpl = vi.fn(stubFetch(trendingFixture()));
    await fetchTrending({ since: "weekly", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith(`${TRENDING_URL}?since=weekly`, expect.anything());
  });

  it("returns an empty list instead of throwing on a network error", async () => {
    const log = vi.fn();
    const failing = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as unknown as typeof fetch;

    // A broken scrape must never abort the daily sync that also carries the
    // per-author star documents.
    await expect(fetchTrending({ fetchImpl: failing, log })).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("ENOTFOUND"));
  });

  it("returns an empty list on a non-OK response", async () => {
    const log = vi.fn();
    const repos = await fetchTrending({ fetchImpl: stubFetch("", { ok: false, status: 429 }), log });

    expect(repos).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("429"));
  });

  it("reports a page that parses to nothing", async () => {
    const log = vi.fn();
    const repos = await fetchTrending({ fetchImpl: stubFetch("<html></html>"), log });

    expect(repos).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("页面结构"));
  });
});

function row(overrides: Partial<TrendingRow> & { fullName: string }): TrendingRow {
  return {
    url: `https://github.com/${overrides.fullName}`,
    starsToday: 100,
    stars: 1000,
    language: "Python",
    description: "desc",
    category: "AI应用与变现" as Category,
    summaryZh: "摘要",
    ...overrides,
  };
}

const context = { generatedAt: new Date("2026-09-12T03:04:05Z") };

describe("renderTrending", () => {
  it("leads with the daily gain and names the source window", () => {
    const { markdown } = renderTrending(
      [row({ fullName: "a/one", starsToday: 2265 }), row({ fullName: "b/two", starsToday: 504 })],
      context,
    );

    expect(markdown).toContain("# GitHub 上涨趋势榜");
    expect(markdown).toContain("今日新增");
    expect(markdown).toContain("+2,265");
    expect(markdown).toContain("GitHub Trending（每日）");
    expect(markdown).toContain("TOP 2");
    // The generation timestamp has to stay verbatim: publish.ts normalises it
    // out of the content hash so an unchanged board is not rewritten daily.
    expect(markdown).toContain("生成时间 2026-09-12 03:04 UTC");
  });

  it("keeps the ranking order it was given", () => {
    const { markdown } = renderTrending(
      [row({ fullName: "big/one", starsToday: 900 }), row({ fullName: "small/two", starsToday: 10 })],
      context,
    );
    expect(markdown.indexOf("big/one")).toBeLessThan(markdown.indexOf("small/two"));
  });

  it("labels the window it was rendered for", () => {
    const { markdown } = renderTrending([row({ fullName: "a/b" })], { ...context, since: "monthly" });
    expect(markdown).toContain("每月");
  });

  it("counts the tracks the rows fall into", () => {
    const { counts } = renderTrending(
      [
        row({ fullName: "a/one" }),
        row({ fullName: "b/two" }),
        row({ fullName: "c/three", category: "学习资源与技能" as Category }),
      ],
      context,
    );

    expect(counts).toEqual({ AI应用与变现: 2, 学习资源与技能: 1 });
  });

  it("promotes high-potential rows into their own table", () => {
    const { markdown } = renderTrending(
      [
        row({ fullName: "meh/one", moneyScore: 2, monetization: "内容变现" }),
        row({ fullName: "rich/two", moneyScore: 5, monetization: "SaaS 订阅" }),
      ],
      context,
    );

    expect(markdown).toContain("## 变现机会榜");
    expect(markdown).toContain("SaaS 订阅 | ●●●●● 5");
    expect(markdown).not.toContain("内容变现 | ●●○○○ 2");
  });

  it("omits the opportunity table when nothing was scored", () => {
    const { markdown } = renderTrending([row({ fullName: "a/b" })], context);

    expect(markdown).not.toContain("## 变现机会榜");
    expect(markdown).toContain("暂不明朗 | -");
  });

  it("escapes a pipe in a description so the table stays intact", () => {
    const { markdown } = renderTrending(
      [row({ fullName: "a/b", description: "left | right", summaryZh: null })],
      context,
    );
    expect(markdown).toContain("left \\| right");
  });

  it("says so plainly when the board is empty", () => {
    const { markdown } = renderTrending([], context);

    expect(markdown).toContain("暂无数据");
    expect(markdown).toContain("生成时间 2026-09-12 03:04 UTC");
    expect(markdown).not.toContain("| 排名 |");
  });
});
