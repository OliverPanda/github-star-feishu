import { describe, expect, it } from "vitest";
import {
  CATEGORIES,
  FALLBACK_CATEGORY,
  FALLBACK_MONETIZATION,
  MONEY_SCORE_MAX,
  MONEY_SCORE_MIN,
  MONETIZATION_PATHS,
  isCategory,
  isMonetizationPath,
  normalizeCategory,
  normalizeMonetization,
  normalizeMoneyScore,
} from "../src/taxonomy.js";

describe("normalizeCategory", () => {
  it("passes exact taxonomy values through untouched", () => {
    for (const category of CATEGORIES) {
      expect(normalizeCategory(category)).toBe(category);
    }
  });

  it("tolerates case, spacing and separator noise from the model", () => {
    expect(normalizeCategory(" AI应用与变现 ")).toBe("AI应用与变现");
    expect(normalizeCategory("ai应用与变现")).toBe("AI应用与变现");
    expect(normalizeCategory("企业与saas软件")).toBe("企业与SaaS软件");
    expect(normalizeCategory("数据科学与分析")).toBe(FALLBACK_CATEGORY);
  });

  it("falls back instead of inventing a category", () => {
    expect(normalizeCategory("自创类目")).toBe(FALLBACK_CATEGORY);
    expect(normalizeCategory("")).toBe(FALLBACK_CATEGORY);
    expect(normalizeCategory(undefined)).toBe(FALLBACK_CATEGORY);
    expect(normalizeCategory(null)).toBe(FALLBACK_CATEGORY);
  });

  it("keeps 其他 last so a real match always wins over the fallback", () => {
    expect(CATEGORIES[CATEGORIES.length - 1]).toBe(FALLBACK_CATEGORY);
    expect(isCategory("量化交易与金融")).toBe(true);
    expect(isCategory("前端")).toBe(false);
  });
});

describe("normalizeMonetization", () => {
  it("passes exact taxonomy values through untouched", () => {
    for (const path of MONETIZATION_PATHS) {
      expect(normalizeMonetization(path)).toBe(path);
    }
  });

  it("tolerates case and spacing noise from the model", () => {
    expect(normalizeMonetization("saas订阅")).toBe("SaaS 订阅");
    expect(normalizeMonetization(" api 用量计费 ")).toBe("API 用量计费");
  });

  it("falls back instead of inventing a path", () => {
    expect(normalizeMonetization("自创路径")).toBe(FALLBACK_MONETIZATION);
    expect(normalizeMonetization("")).toBe(FALLBACK_MONETIZATION);
    expect(normalizeMonetization(undefined)).toBe(FALLBACK_MONETIZATION);
    expect(normalizeMonetization(null)).toBe(FALLBACK_MONETIZATION);
    expect(isMonetizationPath("暂不明朗")).toBe(true);
  });
});

describe("normalizeMoneyScore", () => {
  it("keeps in-range integers as-is", () => {
    for (let score = MONEY_SCORE_MIN; score <= MONEY_SCORE_MAX; score += 1) {
      expect(normalizeMoneyScore(score)).toBe(score);
    }
  });

  it("clamps out-of-range answers instead of dropping the row", () => {
    // Models sometimes answer on a 0-10 scale despite the prompt.
    expect(normalizeMoneyScore(0)).toBe(MONEY_SCORE_MIN);
    expect(normalizeMoneyScore(-3)).toBe(MONEY_SCORE_MIN);
    expect(normalizeMoneyScore(10)).toBe(MONEY_SCORE_MAX);
    expect(normalizeMoneyScore(999)).toBe(MONEY_SCORE_MAX);
  });

  it("accepts numeric strings and rounds floats", () => {
    expect(normalizeMoneyScore("4")).toBe(4);
    expect(normalizeMoneyScore(3.6)).toBe(4);
    expect(normalizeMoneyScore("2.4")).toBe(2);
  });

  it("falls back to the minimum for non-numeric junk", () => {
    expect(normalizeMoneyScore(undefined)).toBe(MONEY_SCORE_MIN);
    expect(normalizeMoneyScore(null)).toBe(MONEY_SCORE_MIN);
    expect(normalizeMoneyScore("很高")).toBe(MONEY_SCORE_MIN);
    expect(normalizeMoneyScore(Number.NaN)).toBe(MONEY_SCORE_MIN);
  });
});
