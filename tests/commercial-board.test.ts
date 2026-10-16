import { describe, expect, it } from "vitest";
import {
  COMMERCIAL_TITLE,
  commercialPicks,
  renderCommercialBoard,
  summarizeCommercialBoard,
} from "../src/commercial-board.js";

const DAY = 24 * 60 * 60 * 1000;
const START = new Date("2026-10-16T09:00:00Z");

describe("renderCommercialBoard", () => {
  it("renders twenty numbered projects with their money path", () => {
    const markdown = renderCommercialBoard(START);

    expect(markdown).toContain(`# ${COMMERCIAL_TITLE}`);
    expect(markdown).toContain("## 20. ");
    expect(markdown).toContain("- 搞钱路径：");
    expect(markdown).toContain("https://github.com/");
    // The date is what tells a reader the page is refreshed daily.
    expect(markdown).toContain("更新日期：2026-10-16");
  });
});

describe("commercialPicks", () => {
  it("rotates to a different set the next day", () => {
    const today = commercialPicks(START).map((project) => project.name);
    const tomorrow = commercialPicks(new Date(START.getTime() + DAY)).map(
      (project) => project.name,
    );

    expect(tomorrow[0]).not.toBe(today[0]);
    expect(tomorrow[1]).toBe(today[2]);
  });

  it("returns the same picks for two runs on the same day", () => {
    expect(commercialPicks(new Date(START.getTime() + 60_000))).toEqual(commercialPicks(START));
  });

  it("wraps around without repeating a project inside one day", () => {
    const picks = commercialPicks(START, 20).map((project) => project.name);
    expect(new Set(picks).size).toBe(20);
  });
});

describe("summarizeCommercialBoard", () => {
  it("produces a short cash-focused digest with the day's picks", () => {
    const summary = summarizeCommercialBoard(START);
    const lines = summary.split("\n");

    expect(lines[0]).toContain(`搞钱项目精选 Top 20`);
    expect(lines[0]).toContain("2026-10-16");
    expect(lines[1]).toContain("变现方向");
    // Header plus one line per highlighted project; a chat card must stay short.
    expect(lines).toHaveLength(5);
    for (const project of commercialPicks(START)) {
      expect(summary).toContain(project.name);
      expect(summary).toContain(project.deploy);
    }
  });
});
