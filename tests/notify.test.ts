import { describe, expect, it, vi } from "vitest";
import {
  buildSummaryCard,
  buildWeeklyMoneyCard,
  notifyBatchResult,
} from "../src/feishu/notify.js";
import type { AuthorOutcome, BatchResult } from "../src/batch.js";
import { buildWeeklyMoneyReport } from "../src/weekly-money.js";

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
    weeklyMoneyNodeToken: null,
    weeklyMoneyUnchanged: false,
    weeklyMoneyPeriodKey: null,
    weeklyMoneyReport: null,
    weeklyMoneyPushDue: false,
    weeklyMoneyError: null,
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
        weeklyMoneyNodeToken: "wikcnWeekly",
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
    expect(money).toContain("https://pcnymmlbor6m.feishu.cn/wiki/wikcnWeekly");
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

describe("buildWeeklyMoneyCard", () => {
  it("pushes all ten picks with explicit selection reasons", () => {
    const report = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    const card = buildWeeklyMoneyCard(report, {
      wikiBaseUrl: "https://pcnymmlbor6m.feishu.cn/wiki/",
      nodeToken: "wikcnWeekly",
    }) as any;

    expect(card.card.header.title.content).toContain("每周搞钱项目 Top 10");
    expect(card.card.header.title.content).toContain("2026-10-12 至 2026-10-18");
    const items = card.card.elements[2].text.content as string;
    expect(items.match(/^\*\*\d+\. /gm)).toHaveLength(10);
    expect(items.match(/\*\*精选原因：\*\*/g)).toHaveLength(10);
    expect(items).toContain("**怎么收钱：**");
    expect(items).toContain("**适合谁：**");
    expect(card.card.elements.at(-1).text.content).toContain(
      "https://pcnymmlbor6m.feishu.cn/wiki/wikcnWeekly",
    );
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

  it("prefers the app bot channel when one is configured", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("tenant_access_token")) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    });

    const sent = await notifyBatchResult(
      result({ commercialSummary: "今日聚焦" }),
      {
        webhook: WEBHOOK,
        app: { appId: "cli_notify", appSecret: "s", chatId: "oc_1" },
        fetchImpl: fetchImpl as any,
      },
    );

    expect(sent).toBe(true);
    // The webhook must not be called as well, or every run would notify twice.
    const urls = fetchImpl.mock.calls.map((call) => call[0] as string);
    expect(urls.some((url) => url === WEBHOOK)).toBe(false);
    expect(urls.at(-1)).toContain("/im/v1/messages");
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
