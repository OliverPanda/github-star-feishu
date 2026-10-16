import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_PER_DAY,
  COMMERCIAL_TITLE,
  commercialDate,
  commercialDaysPerCycle,
  commercialHistory,
  commercialRoster,
  renderCommercialBoard,
  summarizeCommercialBoard,
} from "../src/commercial-board.js";
import { COMMERCIAL_PROJECTS } from "../src/commercial-projects.js";

const DAY = 24 * 60 * 60 * 1000;
/** 第一批当天北京时间 09:00，也就是每日定时任务跑的时刻。 */
const START = new Date("2026-10-16T01:00:00Z");

function at(dayOffset: number, hour = 0): Date {
  return new Date(START.getTime() + dayOffset * DAY + hour * 60 * 60 * 1000);
}

function names(date: Date): string[] {
  return commercialRoster(date).map((project) => project.name);
}

describe("项目池", () => {
  it("按整批划分，长度是每批数量的整数倍", () => {
    expect(COMMERCIAL_PROJECTS.length).toBeGreaterThanOrEqual(COMMERCIAL_PER_DAY * 2);
    expect(COMMERCIAL_PROJECTS.length % COMMERCIAL_PER_DAY).toBe(0);
  });

  it("每个项目字段完整且仓库地址可用", () => {
    for (const project of COMMERCIAL_PROJECTS) {
      expect(project.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      for (const field of ["name", "category", "scenario", "deploy", "monetization", "fit"] as const) {
        expect(project[field].trim().length).toBeGreaterThan(1);
      }
    }
  });

  it("没有重名的项目或仓库", () => {
    expect(new Set(COMMERCIAL_PROJECTS.map((project) => project.name)).size).toBe(
      COMMERCIAL_PROJECTS.length,
    );
    expect(new Set(COMMERCIAL_PROJECTS.map((project) => project.repo)).size).toBe(
      COMMERCIAL_PROJECTS.length,
    );
  });
});

describe("commercialRoster", () => {
  it("每天固定 20 个且当天不重复", () => {
    const today = names(START);
    expect(today).toHaveLength(COMMERCIAL_PER_DAY);
    expect(new Set(today).size).toBe(COMMERCIAL_PER_DAY);
  });

  it("同一天重跑得到同一批", () => {
    // 北京时间 09:00 和 15:00 是同一个批次。
    expect(names(at(0, 6))).toEqual(names(at(0, 0)));
    // 但跨过北京时间的午夜就是新的一批。
    expect(names(new Date("2026-10-16T15:00:00Z"))).toEqual(names(at(0)));
    expect(names(new Date("2026-10-16T16:00:00Z"))).toEqual(names(at(1)));
  });

  it("第二天换 20 个全新的项目", () => {
    const today = new Set(names(at(0)));
    const tomorrow = names(at(1));
    expect(tomorrow).toHaveLength(COMMERCIAL_PER_DAY);
    expect(tomorrow.filter((name) => today.has(name))).toEqual([]);
  });

  it("一轮之内把整个项目池发完且不重复", () => {
    const cycle = commercialDaysPerCycle();
    const published = Array.from({ length: cycle }, (_, day) => names(at(day))).flat();

    expect(published).toHaveLength(COMMERCIAL_PROJECTS.length);
    expect(new Set(published).size).toBe(COMMERCIAL_PROJECTS.length);
  });

  it("下一轮重新洗牌，不会照抄第一轮", () => {
    const first = names(at(0));
    const nextCycle = names(at(commercialDaysPerCycle()));

    expect(nextCycle).toHaveLength(COMMERCIAL_PER_DAY);
    expect(nextCycle).not.toEqual(first);
  });

  it("按北京时间换日，早上推送不会算成前一天", () => {
    // 北京时间 08:30 与 09:00 属于同一天，UTC 日期却还停在 16 号。
    expect(commercialDate(new Date("2026-10-16T00:30:00Z"))).toBe("2026-10-16");
    expect(commercialDate(new Date("2026-10-16T01:00:00Z"))).toBe("2026-10-16");
    expect(commercialDate(new Date("2026-10-16T17:00:00Z"))).toBe("2026-10-17");
  });
});

describe("renderCommercialBoard", () => {
  it("第一天只有当天一节", () => {
    const markdown = renderCommercialBoard(START);

    expect(markdown).toContain(`# ${COMMERCIAL_TITLE}`);
    expect(markdown).toContain("## 2026-10-16（第 1 批");
    expect(markdown).toContain("### 20. ");
    expect(markdown).toContain("- 搞钱路径：");
    expect(markdown).toContain("https://github.com/");
    expect(markdown.match(/^## /gm)).toHaveLength(1);
  });

  it("第二天把 40 个不同项目按日期分开留档", () => {
    const markdown = renderCommercialBoard(at(1));
    const headings = markdown.match(/^### \d+\. (.+)$/gm) ?? [];
    const titles = headings.map((line) => line.replace(/^### \d+\. /, ""));

    expect(markdown).toContain("## 2026-10-16（第 1 批");
    expect(markdown).toContain("## 2026-10-17（第 2 批");
    expect(titles).toHaveLength(COMMERCIAL_PER_DAY * 2);
    expect(new Set(titles).size).toBe(COMMERCIAL_PER_DAY * 2);
  });

  it("最新的批次排在最前面", () => {
    const markdown = renderCommercialBoard(at(2));
    expect(commercialHistory(at(2))[0]?.date).toBe("2026-10-18");
    expect(markdown.indexOf("## 2026-10-18")).toBeLessThan(markdown.indexOf("## 2026-10-17"));
    expect(markdown.indexOf("## 2026-10-17")).toBeLessThan(markdown.indexOf("## 2026-10-16"));
  });

  it("同一天重跑得到同样的文档，内容哈希不会白变", () => {
    expect(renderCommercialBoard(at(3, 2))).toBe(renderCommercialBoard(at(3, 9)));
  });
});

describe("summarizeCommercialBoard", () => {
  it("推送卡片列出当天 20 个项目的场景和搞钱路径", () => {
    const summary = summarizeCommercialBoard(START);
    const lines = summary.split("\n");

    expect(lines[0]).toContain("搞钱项目精选 Top 20");
    expect(lines[0]).toContain("2026-10-16");
    expect(lines[0]).toContain("第 1 批");
    // 标题、说明，再加上每个项目一行。
    expect(lines).toHaveLength(COMMERCIAL_PER_DAY + 2);
    expect(lines[2]).toMatch(/^1\. \*\*.+\*\*（.+）：.+ → .+$/);

    for (const project of commercialRoster(START)) {
      expect(summary).toContain(project.name);
      expect(summary).toContain(project.monetization);
    }
  });

  it("第二天推的是另一批", () => {
    const today = summarizeCommercialBoard(at(0));
    const tomorrow = summarizeCommercialBoard(at(1));
    expect(tomorrow).not.toBe(today);
    expect(tomorrow.split("\n")[0]).toContain("第 2 批");
  });
});
