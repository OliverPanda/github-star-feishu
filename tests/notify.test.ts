import { describe, expect, it, vi } from "vitest";
import { buildSummaryCard, notifyBatchResult } from "../src/feishu/notify.js";
import type { AuthorOutcome, BatchResult } from "../src/batch.js";

function outcome(overrides: Partial<AuthorOutcome> & { login: string }): AuthorOutcome {
  return {
    displayName: null,
    isSelf: false,
    newStars: 0,
    totalStars: 0,
    unchanged: false,
    sectionToken: null,
    nodeToken: null,
    error: null,
    ...overrides,
  };
}

function result(overrides: Partial<BatchResult> = {}): BatchResult {
  return {
    spaceId: "space-1",
    outcomes: [],
    indexNodeToken: null,
    indexUnchanged: false,
    indexMarkdown: "",
    trendingNodeToken: null,
    trendingUnchanged: false,
    trendingCount: 0,
    trendingError: null,
    commercialNodeToken: null,
    commercialUnchanged: false,
    commercialSummary: "",
    commercialError: null,
    newStars: 0,
    failed: 0,
    ...overrides,
  };
}

const WEBHOOK = "https://open.feishu.cn/open-apis/bot/v2/hook/abc";

describe("buildSummaryCard", () => {
  it("summarizes the batch and uses a green header when nothing failed", () => {
    const card = buildSummaryCard(
      result({
        newStars: 7,
        outcomes: [
          outcome({ login: "karpathy", totalStars: 165, newStars: 7 }),
          outcome({ login: "antfu", totalStars: 40, unchanged: true }),
        ],
      }),
    ) as any;

    expect(card.msg_type).toBe("interactive");
    expect(card.card.header.template).toBe("green");
    const content = card.card.elements[0].text.content as string;
    expect(content).toContain("**账号**：2 个（成功 2，失败 0）");
    expect(content).toContain("**本次新增**：7 个 star");
    expect(content).toContain("🟢 **karpathy** 累计 165 个仓库，新增 7");
    expect(content).toContain("（内容未变化）");
  });

  it("turns the header red and lists failed authors first", () => {
    const card = buildSummaryCard(
      result({
        failed: 1,
        outcomes: [
          outcome({ login: "karpathy", totalStars: 165 }),
          outcome({ login: "ghost", error: "找不到该账号" }),
        ],
      }),
    ) as any;

    expect(card.card.header.template).toBe("red");
    const content = card.card.elements[0].text.content as string;
    expect(content).toContain("失败 1");
    expect(content).toContain("🔴 **ghost** 同步失败：找不到该账号");
    expect(content.indexOf("🔴")).toBeLessThan(content.indexOf("🟢"));
  });

  it("handles an empty author list", () => {
    const card = buildSummaryCard(result()) as any;
    const content = card.card.elements[0].text.content as string;
    expect(content).toContain("_还没有配置任何作者。_");
  });

  it("adds a money board block with links when the digest is present", () => {
    const card = buildSummaryCard(
      result({
        commercialSummary: "**搞钱项目精选 Top 20**（2026-10-16 更新）",
        commercialNodeToken: "wikcnMoney",
        trendingNodeToken: "wikcnTrending",
      }),
      { wikiBaseUrl: "https://pcnymmlbor6m.feishu.cn/wiki/" },
    ) as any;

    // The author summary stays first so existing readers keep their bearings.
    expect(card.card.elements[0].text.content).toContain("**知识库**");
    expect(card.card.elements).toHaveLength(3);
    expect(card.card.elements[1].tag).toBe("hr");
    const money = card.card.elements[2].text.content as string;
    expect(money).toContain("搞钱项目精选 Top 20**（2026-10-16 更新）");
    expect(money).toContain("https://pcnymmlbor6m.feishu.cn/wiki/wikcnMoney");
    expect(money).toContain("https://pcnymmlbor6m.feishu.cn/wiki/wikcnTrending");
  });

  it("leaves the card to the author summary when the money board is skipped", () => {
    const card = buildSummaryCard(result({ commercialSummary: "" })) as any;
    expect(card.card.elements).toHaveLength(1);
  });

  it("reports a failed money write without dropping the digest", () => {
    const card = buildSummaryCard(
      result({ commercialSummary: "今日聚焦", commercialError: "权限不足" }),
    ) as any;
    const money = card.card.elements[2].text.content as string;
    expect(money).toContain("今日聚焦");
    expect(money).toContain("⚠️ 知识库页面写入失败：权限不足");
  });
});

describe("notifyBatchResult", () => {
  it("skips the request and reports false when no webhook is configured", async () => {
    const fetchImpl = vi.fn();
    const sent = await notifyBatchResult(result(), { fetchImpl: fetchImpl as any });

    expect(sent).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the card and returns true on success", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      new Response(JSON.stringify({ code: 0 }), { status: 200 }),
    );
    const sent = await notifyBatchResult(result({ newStars: 3 }), {
      webhook: WEBHOOK,
      fetchImpl: fetchImpl as any,
    });

    expect(sent).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(WEBHOOK);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).msg_type).toBe("interactive");
  });

  it("throws on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(
      notifyBatchResult(result(), { webhook: WEBHOOK, fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when Feishu answers 200 with a non-zero code", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ code: 19021, msg: "sign match fail" }), { status: 200 }),
    );

    await expect(
      notifyBatchResult(result(), { webhook: WEBHOOK, fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/19021 sign match fail/);
  });
});
