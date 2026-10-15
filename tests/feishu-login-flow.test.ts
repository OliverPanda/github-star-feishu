import { describe, expect, it, vi } from "vitest";
import type { FeishuAuth } from "../src/feishu/auth.js";
import {
  describeLoginRequired,
  LoginStatusCache,
  readLoginStatus,
  REQUIRED_WIKI_SCOPES,
} from "../src/feishu/login-flow.js";

function stubAuth(
  status: unknown,
  check: unknown = { ok: true, missing: [] },
  userName: string | null = null,
) {
  return {
    status: vi.fn(async () => status),
    checkScopes: vi.fn(async () => check),
    currentAppId: vi.fn(async () => "cli_from_config"),
    userName: vi.fn(async () => userName),
  } as unknown as FeishuAuth;
}

describe("readLoginStatus", () => {
  it("only requires scope names the CLI actually grants", () => {
    // `auth check` reports any unknown name as missing, so a typo here makes a
    // perfectly healthy login look permanently under-permissioned. These two
    // spellings look plausible and are exactly that trap.
    expect(REQUIRED_WIKI_SCOPES).not.toContain("wiki:wiki");
    expect(REQUIRED_WIKI_SCOPES).not.toContain("docx:document");
  });

  it("reports the user token as missing when nobody signed in", async () => {
    const auth = stubAuth({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null });

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.loggedIn).toBe(false);
    expect(status.missingScopes).toEqual([]);
    // Not signed in: asking the CLI about scopes would just spawn a second
    // failing process.
    expect(auth.checkScopes).not.toHaveBeenCalled();
  });

  it("checks the wiki scopes once a token exists", async () => {
    const auth = stubAuth(
      { loggedIn: true, appId: "cli_a1", userName: "张三", scopes: ["wiki:wiki"], hint: null },
      { ok: true, missing: [] },
    );

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.loggedIn).toBe(true);
    expect(status.userName).toBe("张三");
    expect(status.missingScopes).toEqual([]);
    expect(auth.checkScopes).toHaveBeenCalledWith(REQUIRED_WIKI_SCOPES);
  });

  it("surfaces scopes the token still lacks", async () => {
    const auth = stubAuth(
      { loggedIn: true, appId: "cli_a1", userName: "张三", scopes: [], hint: null },
      { ok: false, missing: ["wiki:node:update"] },
    );

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.missingScopes).toEqual(["wiki:node:update"]);
  });

  it("falls back to the configured app id when the CLI reports none", async () => {
    const auth = stubAuth({ loggedIn: true, appId: null, userName: "张三", scopes: [], hint: null });

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.appId).toBe("cli_from_config");
  });

  it("asks the OpenAPI identity endpoint when auth status carries no name", async () => {
    // `auth status` reports the app and scopes but never the account, so the
    // name is null on every real machine until this second call fills it in.
    const auth = stubAuth(
      { loggedIn: true, appId: "cli_a1", userName: null, scopes: [], hint: null },
      { ok: true, missing: [] },
      "用户321085",
    );

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.userName).toBe("用户321085");
    expect(auth.userName).toHaveBeenCalled();
  });

  it("prefers the name auth status already reports", async () => {
    const auth = stubAuth(
      { loggedIn: true, appId: "cli_a1", userName: "张三", scopes: [], hint: null },
      { ok: true, missing: [] },
      "用户321085",
    );

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.userName).toBe("张三");
    expect(auth.userName).not.toHaveBeenCalled();
  });

  it("keeps a working login when the identity lookup fails", async () => {
    // The name is a label on the options page, not a permission the sync path
    // needs, so a failed lookup must not read as "未登录".
    const auth = stubAuth({ loggedIn: true, appId: "cli_a1", userName: null, scopes: [], hint: null });
    (auth.userName as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("接口无权访问"));

    const status = await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(status.loggedIn).toBe(true);
    expect(status.userName).toBeNull();
  });

  it("does not look up an identity while signed out", async () => {
    const auth = stubAuth({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null });

    await readLoginStatus({ cliPath: "feishu-cli", auth });

    expect(auth.userName).not.toHaveBeenCalled();
  });
});

describe("describeLoginRequired", () => {
  it.each([
    "未登录，请先执行 feishu-cli auth login",
    "错误: not_logged_in",
    "token_expired",
    "缺少 app_id",
    "缺少 app_secret",
  ])("points at the scan command for %s", (message) => {
    expect(describeLoginRequired(new Error(message))).toContain("npm run cli -- login");
  });

  it("keeps the CLI's own failure line and adds the retry hint", () => {
    const hint = describeLoginRequired(new Error("设备授权失败: The specified app does not exist."));

    expect(hint).toContain("设备授权失败");
    expect(hint).toContain("重新授权");
  });

  it("returns null for unrelated failures so callers keep the real error", () => {
    expect(describeLoginRequired(new Error("网络超时"))).toBeNull();
  });

  it("accepts a non-Error throw without crashing", () => {
    expect(describeLoginRequired("未登录")).toContain("扫码");
  });
});

describe("LoginStatusCache", () => {
  it("reuses a fresh probe instead of spawning the CLI on every poll", async () => {
    const auth = stubAuth({ loggedIn: true, appId: "cli_a1", userName: "张三", scopes: [], hint: null });
    const cache = new LoginStatusCache({ cliPath: "feishu-cli", auth }, 15_000);

    await cache.get(1_000);
    await cache.get(2_000);

    expect(auth.status).toHaveBeenCalledTimes(1);
  });

  it("re-probes once the TTL lapses", async () => {
    const auth = stubAuth({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null });
    const cache = new LoginStatusCache({ cliPath: "feishu-cli", auth }, 15_000);

    await cache.get(1_000);
    await cache.get(20_000);

    expect(auth.status).toHaveBeenCalledTimes(2);
  });

  it("drops the cached value on invalidate", async () => {
    const auth = stubAuth({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null });
    const cache = new LoginStatusCache({ cliPath: "feishu-cli", auth }, 15_000);

    await cache.get(1_000);
    cache.invalidate();
    await cache.get(2_000);

    expect(auth.status).toHaveBeenCalledTimes(2);
  });

  it("degrades to signed-out instead of failing health when the CLI is broken", async () => {
    const auth = {
      status: vi.fn(async () => {
        throw new Error("spawn feishu-cli ENOENT");
      }),
      checkScopes: vi.fn(),
      currentAppId: vi.fn(),
    } as unknown as FeishuAuth;
    const cache = new LoginStatusCache({ cliPath: "feishu-cli", auth }, 15_000);

    const status = await cache.get(1_000);

    expect(status.loggedIn).toBe(false);
    expect(status.hint).toContain("ENOENT");
  });

  it("shares one in-flight probe between concurrent callers", async () => {
    const auth = stubAuth({ loggedIn: false, appId: null, userName: null, scopes: [], hint: null });
    const cache = new LoginStatusCache({ cliPath: "feishu-cli", auth }, 15_000);

    await Promise.all([cache.get(1_000), cache.get(1_000)]);

    expect(auth.status).toHaveBeenCalledTimes(1);
  });
});
