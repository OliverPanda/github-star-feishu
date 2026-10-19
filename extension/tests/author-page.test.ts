import { describe, expect, it } from "vitest";
import {
  authorPagePath,
  loginFromSearch,
  ROSTER_PAGE_PATH,
  TRENDING_PAGE_PATH,
  WEEKLY_MONEY_PAGE_PATH,
} from "../lib/author-page.js";

describe("authorPagePath", () => {
  it("points at the unlisted page with the login as a query parameter", () => {
    expect(authorPagePath("karpathy")).toBe("/stars.html?login=karpathy");
  });

  it("escapes a login so a stray character cannot break the URL", () => {
    expect(authorPagePath("a/b")).toBe("/stars.html?login=a%2Fb");
  });
});

describe("loginFromSearch", () => {
  it("reads the login back out of the query string", () => {
    expect(loginFromSearch("?login=antfu")).toBe("antfu");
  });

  it("round-trips an escaped login", () => {
    expect(loginFromSearch("?login=b%2Fc")).toBe("b/c");
  });

  it("returns an empty string when the parameter is missing or blank", () => {
    expect(loginFromSearch("")).toBe("");
    expect(loginFromSearch("?login=")).toBe("");
    expect(loginFromSearch("?login=%20")).toBe("");
  });
});

describe("ROSTER_PAGE_PATH", () => {
  it("points at the roster page that the popup button opens", () => {
    expect(ROSTER_PAGE_PATH).toBe("/roster.html");
  });
});

describe("TRENDING_PAGE_PATH", () => {
  it("points at the trending page that the popup button opens", () => {
    expect(TRENDING_PAGE_PATH).toBe("/trending.html");
  });
});

describe("WEEKLY_MONEY_PAGE_PATH", () => {
  it("points at the detailed weekly Top 10 page", () => {
    expect(WEEKLY_MONEY_PAGE_PATH).toBe("/weekly.html");
  });
});
