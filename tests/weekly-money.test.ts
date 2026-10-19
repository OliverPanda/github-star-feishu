import { describe, expect, it } from "vitest";
import {
  WEEKLY_MONEY_PICK_COUNT,
  buildWeeklyMoneyReport,
  markWeeklyMoneyPushed,
  readWeeklyMoneySnapshot,
  renderWeeklyMoneyBoard,
  saveWeeklyMoneySnapshot,
  weeklyReportPeriod,
} from "../src/weekly-money.js";
import { setSetting } from "../src/store.js";
import { createTestDb } from "./helpers.js";

describe("weeklyReportPeriod", () => {
  it("uses the latest complete Beijing Monday-to-Sunday week", () => {
    expect(weeklyReportPeriod(new Date("2026-10-19T01:00:00Z"))).toEqual({
      key: "2026-10-12_2026-10-18",
      start: "2026-10-12",
      end: "2026-10-18",
      label: "2026-10-12 至 2026-10-18",
    });
  });

  it("keeps the same report period when a midweek run retries", () => {
    expect(weeklyReportPeriod(new Date("2026-10-21T01:00:00Z")).key).toBe(
      weeklyReportPeriod(new Date("2026-10-24T08:00:00Z")).key,
    );
    expect(weeklyReportPeriod(new Date("2026-10-26T01:00:00Z")).key).toBe(
      "2026-10-19_2026-10-25",
    );
  });

  it("switches at Beijing Monday midnight rather than UTC midnight", () => {
    expect(weeklyReportPeriod(new Date("2026-10-18T15:59:00Z")).key).toBe(
      "2026-10-05_2026-10-11",
    );
    expect(weeklyReportPeriod(new Date("2026-10-18T16:00:00Z")).key).toBe(
      "2026-10-12_2026-10-18",
    );
  });
});

describe("buildWeeklyMoneyReport", () => {
  const now = new Date("2026-10-19T01:00:00Z");

  it("selects exactly ten unique projects from the week", () => {
    const report = buildWeeklyMoneyReport(now);

    expect(report.candidateCount).toBe(60);
    expect(report.picks).toHaveLength(WEEKLY_MONEY_PICK_COUNT);
    expect(new Set(report.picks.map((pick) => pick.repo)).size).toBe(WEEKLY_MONEY_PICK_COUNT);
    expect(report.picks.map((pick) => pick.rank)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(report.picks.every((pick) => pick.source === "week")).toBe(true);
    expect(report.fallbackCount).toBe(0);
  });

  it("limits the first pass to two projects per business family", () => {
    const report = buildWeeklyMoneyReport(now);
    const aiPicks = report.picks.filter((pick) => /AI|知识库|门户/.test(pick.category));
    expect(aiPicks.length).toBeLessThanOrEqual(2);
  });

  it("explains every pick with evidence and a score breakdown", () => {
    const report = buildWeeklyMoneyReport(now);

    for (const pick of report.picks) {
      expect(pick.reason).toContain(pick.scenario);
      expect(pick.reason).toContain(pick.monetization);
      expect(pick.reason).toContain(pick.fit);
      expect(pick.score).toBeGreaterThanOrEqual(1);
      expect(pick.score).toBeLessThanOrEqual(100);
      expect(Object.values(pick.breakdown).every((value) => value >= 1 && value <= 100)).toBe(true);
      expect(pick.url).toBe(`https://github.com/${pick.repo}`);
    }
  });

  it("uses an explicitly marked fallback only before enough weekly batches exist", () => {
    const report = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    const early = buildWeeklyMoneyReport(new Date("2026-09-14T01:00:00Z"));

    expect(report.fallbackCount).toBe(0);
    expect(early.candidateCount).toBe(0);
    expect(early.picks).toHaveLength(WEEKLY_MONEY_PICK_COUNT);
    expect(early.fallbackCount).toBe(WEEKLY_MONEY_PICK_COUNT);
    expect(early.picks.every((pick) => pick.source === "fallback")).toBe(true);
  });

  it("renders a stable page for the same week", () => {
    const first = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    const second = buildWeeklyMoneyReport(new Date("2026-10-21T08:00:00Z"));

    expect(renderWeeklyMoneyBoard(first)).toBe(renderWeeklyMoneyBoard(second));
  });
});

describe("renderWeeklyMoneyBoard", () => {
  it("publishes all ten detailed rationales and the selection method", () => {
    const report = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    const markdown = renderWeeklyMoneyBoard(report);

    expect(markdown).toContain("# 每周搞钱项目 Top 10");
    expect(markdown).toContain("2026-10-12 至 2026-10-18");
    expect(markdown).toContain("需求强度 35%");
    expect(markdown.match(/^### \d+\. /gm)).toHaveLength(WEEKLY_MONEY_PICK_COUNT);
    expect(markdown.match(/^- 精选理由：/gm)).toHaveLength(WEEKLY_MONEY_PICK_COUNT);
    expect(markdown).toContain("- 入选指数：");
    expect(markdown).toContain("- 搞钱路径：");
  });
});

describe("weekly snapshot", () => {
  it("records delivery separately so a failed push can be retried", () => {
    const db = createTestDb();
    const report = buildWeeklyMoneyReport(new Date("2026-10-19T01:00:00Z"));
    saveWeeklyMoneySnapshot(db, { report, pushedAt: null });

    expect(readWeeklyMoneySnapshot(db)?.pushedAt).toBeNull();

    markWeeklyMoneyPushed(db, report.period.key, new Date("2026-10-19T02:00:00Z"));

    expect(readWeeklyMoneySnapshot(db)?.pushedAt).toBe("2026-10-19T02:00:00.000Z");
  });

  it("treats a corrupted cache as missing data", () => {
    const db = createTestDb();
    setSetting(db, "weekly_money_cache", "{bad json");
    expect(readWeeklyMoneySnapshot(db)).toBeNull();
  });
});
