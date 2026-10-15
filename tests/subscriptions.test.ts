import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeAuthors,
  DEFAULT_SUBSCRIPTIONS_FILE,
  displayLogin,
  loadSubscriptions,
  parseSubscriptions,
  SubscriptionConfigError,
} from "../src/subscriptions.js";

const minimal = `
space: 我的知识库
authors:
  - login: karpathy
`;

describe("parseSubscriptions", () => {
  it("applies defaults to a minimal file", () => {
    const parsed = parseSubscriptions(minimal);

    expect(parsed.space).toBe("我的知识库");
    expect(parsed.spaceId).toBeUndefined();
    expect(parsed.parentNode).toBeUndefined();
    expect(parsed.webhook).toBeUndefined();
    // The board is on unless the file says otherwise: it is the one page that
    // is useful before anyone has been subscribed to.
    expect(parsed.trending).toBe(true);
    expect(parsed.authors).toEqual([
      { login: "karpathy", alias: undefined, self: false, enabled: true },
    ]);
  });

  it("reads an explicit trending switch", () => {
    expect(parseSubscriptions("trending: false\nauthors:\n  - login: karpathy\n").trending).toBe(
      false,
    );
    expect(parseSubscriptions("trending: true\nauthors:\n  - login: karpathy\n").trending).toBe(true);
  });

  it("rejects a non-boolean trending switch", () => {
    expect(() =>
      parseSubscriptions('trending: "yes"\nauthors:\n  - login: karpathy\n'),
    ).toThrow(SubscriptionConfigError);
  });

  it("falls back to the default space name when it is omitted", () => {
    const parsed = parseSubscriptions("authors:\n  - login: karpathy\n");
    expect(parsed.space).toBe("GitHub Star 精选");
  });

  it("keeps alias, self, and explicit disabled flags", () => {
    const parsed = parseSubscriptions(`
authors:
  - login: karpathy
    alias: Andrej Karpathy
    self: true
  - login: ggerganov
    enabled: false
`);

    expect(parsed.authors[0]).toEqual({
      login: "karpathy",
      alias: "Andrej Karpathy",
      self: true,
      enabled: true,
    });
    expect(parsed.authors[1]?.enabled).toBe(false);
  });

  it("reads the knowledge base overrides", () => {
    const parsed = parseSubscriptions(`
space: 团队知识库
space_id: wikcn123
parent_node: wikcn456
webhook: https://open.feishu.cn/open-apis/bot/v2/hook/abc
authors:
  - login: karpathy
`);

    expect(parsed.spaceId).toBe("wikcn123");
    expect(parsed.parentNode).toBe("wikcn456");
    expect(parsed.webhook).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/abc");
  });

  it("keeps a bare numeric id exact, which is how the console copies it", () => {
    // Feishu ids are 19 digits and paste unquoted, so YAML hands back a number.
    // As a plain float it would exceed MAX_SAFE_INTEGER and silently change,
    // pointing the sync at a knowledge base that does not exist.
    const parsed = parseSubscriptions(`
space_id: 7684632981146733504
parent_node: 7684632981146733999
authors:
  - login: karpathy
`);

    expect(parsed.spaceId).toBe("7684632981146733504");
    expect(parsed.parentNode).toBe("7684632981146733999");
  });

  it("accepts a quoted id unchanged", () => {
    const parsed = parseSubscriptions(`
space_id: "7684632981146733504"
authors:
  - login: karpathy
`);

    expect(parsed.spaceId).toBe("7684632981146733504");
  });

  it("rejects a duplicate login regardless of letter case", () => {
    expect(() =>
      parseSubscriptions("authors:\n  - login: karpathy\n  - login: Karpathy\n"),
    ).toThrow(SubscriptionConfigError);
    expect(() =>
      parseSubscriptions("authors:\n  - login: karpathy\n  - login: Karpathy\n"),
    ).toThrow(/重复出现/);
  });

  it("rejects an empty author list", () => {
    expect(() => parseSubscriptions("authors: []\n")).toThrow(/至少需要订阅一个作者/);
  });

  it("rejects an invalid login", () => {
    expect(() => parseSubscriptions("authors:\n  - login: \"-bad-\"\n")).toThrow(
      /不是合法的 GitHub 用户名/,
    );
  });

  it("rejects a webhook that is not a full URL", () => {
    expect(() =>
      parseSubscriptions("webhook: not-a-url\nauthors:\n  - login: karpathy\n"),
    ).toThrow(SubscriptionConfigError);
  });

  it("reports malformed YAML instead of crashing", () => {
    expect(() => parseSubscriptions("authors: [\n")).toThrow(/不是合法 YAML/);
  });
});

describe("activeAuthors", () => {
  it("drops disabled authors but keeps config order", () => {
    const parsed = parseSubscriptions(`
authors:
  - login: antfu
  - login: karpathy
    enabled: false
  - login: sindresorhus
`);

    expect(activeAuthors(parsed).map((author) => author.login)).toEqual([
      "antfu",
      "sindresorhus",
    ]);
  });
});

describe("displayLogin", () => {
  it("prefers the alias and falls back to the login", () => {
    expect(displayLogin({ login: "karpathy", alias: "Andrej", self: false, enabled: true })).toBe(
      "Andrej",
    );
    expect(
      displayLogin({ login: "karpathy", alias: undefined, self: false, enabled: true }),
    ).toBe("karpathy");
  });
});

describe("loadSubscriptions", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "star-subs-"));
    tempDirs.push(dir);
    return dir;
  }

  // These two variables let CI inject the config; clear them so an operator's
  // local shell cannot leak into the assertions below.
  beforeEach(() => {
    vi.stubEnv("STAR_SUBSCRIPTIONS", "");
    vi.stubEnv("STAR_SUBSCRIPTIONS_FILE", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    while (tempDirs.length) rmSync(tempDirs.pop() as string, { recursive: true, force: true });
  });

  it("reads the file from the given path", () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "subs.yaml"),
      "space: 团队库\nauthors:\n  - login: antfu\n",
      "utf8",
    );

    const parsed = loadSubscriptions("subs.yaml", dir);
    expect(parsed.space).toBe("团队库");
    expect(parsed.authors.map((author) => author.login)).toEqual(["antfu"]);
  });

  it("prefers STAR_SUBSCRIPTIONS over the file on disk", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "subs.yaml"), "authors:\n  - login: from-file\n", "utf8");
    vi.stubEnv("STAR_SUBSCRIPTIONS", "authors:\n  - login: from-env\n");

    const parsed = loadSubscriptions("subs.yaml", dir);
    expect(parsed.authors.map((author) => author.login)).toEqual(["from-env"]);
  });

  it("lets STAR_SUBSCRIPTIONS work without any file present", () => {
    const dir = makeTempDir();
    vi.stubEnv("STAR_SUBSCRIPTIONS", "authors:\n  - login: karpathy\n");

    expect(loadSubscriptions(DEFAULT_SUBSCRIPTIONS_FILE, dir).authors[0]?.login).toBe("karpathy");
  });

  it("validates the inline document like a real file", () => {
    vi.stubEnv("STAR_SUBSCRIPTIONS", "authors: []\n");
    expect(() => loadSubscriptions(DEFAULT_SUBSCRIPTIONS_FILE, makeTempDir())).toThrow(
      /至少需要订阅一个作者/,
    );
  });

  it("ignores a blank STAR_SUBSCRIPTIONS instead of failing", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "subs.yaml"), "authors:\n  - login: antfu\n", "utf8");
    vi.stubEnv("STAR_SUBSCRIPTIONS", "   ");

    expect(loadSubscriptions("subs.yaml", dir).authors[0]?.login).toBe("antfu");
  });

  it("lets STAR_SUBSCRIPTIONS_FILE override the given path", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "other.yaml"), "authors:\n  - login: sindresorhus\n", "utf8");
    vi.stubEnv("STAR_SUBSCRIPTIONS_FILE", path.join(dir, "other.yaml"));

    const parsed = loadSubscriptions("missing.yaml", dir);
    expect(parsed.authors.map((author) => author.login)).toEqual(["sindresorhus"]);
  });

  it("explains how to start when the file cannot be found", () => {
    expect(() => loadSubscriptions("nope.yaml", makeTempDir())).toThrow(SubscriptionConfigError);
    expect(() => loadSubscriptions("nope.yaml", makeTempDir())).toThrow(
      /找不到订阅文件/,
    );
  });

  it("accepts a one-line secret with escaped newlines", () => {
    // GitHub Actions secrets cannot contain real newlines, so this is the shape
    // the value actually arrives in.
    vi.stubEnv(
      "STAR_SUBSCRIPTIONS",
      "space: 名人星单\\nwebhook: https://open.feishu.cn/open-apis/bot/v2/hook/x\\nauthors:\\n  - login: karpathy",
    );

    const parsed = loadSubscriptions(DEFAULT_SUBSCRIPTIONS_FILE, makeTempDir());
    expect(parsed.space).toBe("名人星单");
    expect(parsed.webhook).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/x");
    expect(parsed.authors.map((author) => author.login)).toEqual(["karpathy"]);
  });

  it("does not rewrite escapes inside a real multi-line document", () => {
    vi.stubEnv(
      "STAR_SUBSCRIPTIONS",
      "authors:\n  - login: karpathy\n    alias: 'a\\nb'\n",
    );

    const parsed = loadSubscriptions(DEFAULT_SUBSCRIPTIONS_FILE, makeTempDir());
    expect(parsed.authors[0]?.alias).toBe("a\\nb");
  });
});
