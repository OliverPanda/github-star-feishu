import { describe, expect, it } from "vitest";
import { isGitHubHost, isValidLogin, parseRepoUrl } from "../lib/github.js";

describe("parseRepoUrl", () => {
  it.each([
    ["https://github.com/karpathy/nanoGPT", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/", "karpathy/nanoGPT"],
    ["https://www.github.com/karpathy/nanoGPT", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT.git", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/tree/master/nanoGPT", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/blob/main/README.md", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/issues/12", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/pulls?q=is%3Aopen", "karpathy/nanoGPT"],
    ["https://github.com/karpathy/nanoGPT/stargazers", "karpathy/nanoGPT"],
    ["https://github.com/rust-lang/cargo", "rust-lang/cargo"],
    ["https://github.com/a/b", "a/b"],
    ["https://github.com/karpathy/nanoGPT#readme", "karpathy/nanoGPT"],
  ])("resolves %s", (url, expected) => {
    expect(parseRepoUrl(url)?.fullName).toBe(expected);
  });

  it.each([
    ["profile", "https://github.com/karpathy"],
    ["profile stars tab", "https://github.com/karpathy?tab=stars"],
    ["reserved root", "https://github.com/settings/profile"],
    ["reserved root only", "https://github.com/explore"],
    ["profile followers tab", "https://github.com/karpathy/followers"],
    ["unknown repo subpath", "https://github.com/karpathy/nanoGPT/unknown-section"],
    ["search", "https://github.com/search?q=react"],
    ["other host", "https://gitlab.com/foo/bar"],
    ["not a url", "nanoGPT"],
    ["empty", ""],
  ])("ignores %s", (_label, url) => {
    expect(parseRepoUrl(url)).toBeUndefined();
  });

  it("keeps the original casing of the owner and name", () => {
    expect(parseRepoUrl("https://github.com/Torvalds/Linux")).toEqual({
      owner: "Torvalds",
      name: "Linux",
      fullName: "Torvalds/Linux",
    });
  });
});

describe("isGitHubHost", () => {
  it.each(["github.com", "www.github.com", "GitHub.com"])("accepts %s", (host) => {
    expect(isGitHubHost(host)).toBe(true);
  });

  it.each(["gist.github.com", "github.com.evil.test", "gitlab.com"])(
    "rejects %s",
    (host) => {
      expect(isGitHubHost(host)).toBe(false);
    },
  );
});

describe("isValidLogin", () => {
  it.each(["karpathy", "torvalds", "a", "rust-lang", "user123"])("accepts %s", (login) => {
    expect(isValidLogin(login)).toBe(true);
  });

  it.each(["", "-leading", "trailing-", "has space", "a".repeat(40), "dot.name"])(
    "rejects %s",
    (login) => {
      expect(isValidLogin(login)).toBe(false);
    },
  );
});
