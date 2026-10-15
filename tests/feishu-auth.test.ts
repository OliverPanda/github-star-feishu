import { describe, expect, it, vi } from "vitest";
import {
  CANCEL_MESSAGE,
  FeishuAuth,
  loginFailureLine,
  parseAuthState,
  parseLoginPrompt,
  type CommandStream,
  type SpawnProcess,
} from "../src/feishu/auth.js";

/**
 * Fake CLI: each entry is matched by its first argument, and `chunks` are
 * emitted before the process resolves so streaming behaviour is exercised too.
 */
function fakeSpawn(
  responses: Record<string, { chunks?: string[]; code?: number }>,
): { spawn: SpawnProcess; calls: string[][] } {
  const calls: string[][] = [];
  const spawn: SpawnProcess = (args, onChunk) => {
    calls.push(args);
    const key = args.slice(0, 2).join(" ");
    const response = responses[key] ?? responses[args[0] ?? ""] ?? { code: 0 };
    let buffer = "";
    for (const chunk of response.chunks ?? []) {
      buffer += chunk;
      onChunk(chunk);
    }
    const code = response.code ?? 0;
    return {
      cancel: () => {},
      output: () => buffer,
      done: Promise.resolve({ code, output: buffer }),
    } satisfies CommandStream;
  };
  return { spawn, calls };
}

describe("parseLoginPrompt", () => {
  it("reads the human-readable banner feishu-cli prints to stderr", () => {
    const prompt = parseLoginPrompt(
      [
        "正在发起应用注册...",
        "请在浏览器中打开以下链接，扫码确认创建应用:",
        "  https://open.feishu.cn/page/cli?user_code=U3X6-GVDZ",
        "用户码: U3X6-GVDZ",
        "有效期: 3600 秒",
        "等待扫码确认...",
      ].join("\n"),
    );

    expect(prompt.userCode).toBe("U3X6-GVDZ");
    expect(prompt.verificationUri).toContain("user_code=U3X6-GVDZ");
    expect(prompt.expiresInSeconds).toBe(3600);
  });

  it("reads the JSON event stream form", () => {
    const prompt = parseLoginPrompt(
      JSON.stringify({
        user_code: "ABCD-1234",
        verification_uri: "https://accounts.feishu.cn/oauth/v1/device",
        verification_uri_complete:
          "https://accounts.feishu.cn/oauth/v1/device?user_code=ABCD-1234",
        expires_in: 600,
      }),
    );

    expect(prompt).toEqual({
      userCode: "ABCD-1234",
      verificationUri: "https://accounts.feishu.cn/oauth/v1/device",
      verificationUriComplete:
        "https://accounts.feishu.cn/oauth/v1/device?user_code=ABCD-1234",
      expiresInSeconds: 600,
    });
  });

  it("builds a scannable link from a bare URL plus a user code", () => {
    // The bare link alone would force the user to type the code by hand, which
    // defeats the point of showing a QR code.
    const prompt = parseLoginPrompt(
      "请在浏览器中打开: https://open.feishu.cn/page/cli\n用户码: WXYZ-9876",
    );

    expect(prompt.verificationUriComplete).toBe(
      "https://open.feishu.cn/page/cli?user_code=WXYZ-9876",
    );
  });

  it("does not invent a link when the CLI has not printed one yet", () => {
    expect(parseLoginPrompt("正在发起应用注册...")).toEqual({
      userCode: null,
      verificationUri: null,
      verificationUriComplete: null,
      expiresInSeconds: null,
    });
  });

  it("reads the user code out of the link when the code line has not arrived", () => {
    // feishu-cli prints the link one line above "用户码:", and the two can land
    // in different chunks, so the link alone has to be enough.
    const prompt = parseLoginPrompt(
      "请在浏览器中打开以下链接，扫码确认创建应用:\n  https://open.feishu.cn/page/cli?user_code=2PZ5-FJSK\n",
    );

    expect(prompt.userCode).toBe("2PZ5-FJSK");
    expect(prompt.verificationUriComplete).toBe(
      "https://open.feishu.cn/page/cli?user_code=2PZ5-FJSK",
    );
  });
});

describe("parseAuthState", () => {
  it("maps a logged-in payload", () => {
    const state = parseAuthState({
      logged_in: true,
      identity: "user",
      app_id: "cli_abc123",
      scopes: ["wiki:wiki", "docx:document"],
      expires_at: "2026-01-01T00:00:00Z",
      user_name: "张三",
    });

    expect(state).toEqual({
      loggedIn: true,
      identity: "user",
      appId: "cli_abc123",
      scopes: ["wiki:wiki", "docx:document"],
      expiresAt: "2026-01-01T00:00:00Z",
      userName: "张三",
      hint: null,
    });
  });

  it("falls back to defaults for a logged-out payload", () => {
    const state = parseAuthState({ logged_in: false, identity: "bot" });

    expect(state.loggedIn).toBe(false);
    expect(state.appId).toBeNull();
    expect(state.scopes).toEqual([]);
  });

  it("reads the account name out of cached_user", () => {
    // `auth status -o json` nests the profile under `cached_user`; ignoring it
    // left the options page showing "已登录" with no account next to it.
    const state = parseAuthState({
      logged_in: true,
      identity: "user",
      app_id: "cli_abc123",
      cached_user: { name: "用户321085", open_id: "ou_x" },
    });

    expect(state.userName).toBe("用户321085");
  });

  it("accepts a space-separated scope string", () => {
    expect(parseAuthState({ logged_in: true, scope: "wiki:wiki docs:document:import" }).scopes)
      .toEqual(["wiki:wiki", "docs:document:import"]);
  });

  it("survives garbage instead of throwing", () => {
    expect(parseAuthState(null).loggedIn).toBe(false);
    expect(parseAuthState("nope").scopes).toEqual([]);
  });
});

describe("loginFailureLine", () => {
  it("surfaces the CLI's own Chinese failure sentence", () => {
    expect(
      loginFailureLine("等待扫码确认...\n设备授权失败: The specified app does not exist."),
    ).toBe("设备授权失败: The specified app does not exist.");
  });

  it("surfaces the missing-credential hint", () => {
    expect(loginFailureLine("错误: 缺少 app_secret")).toContain("缺少 app_secret");
  });

  it("returns null when nothing looks like a failure", () => {
    expect(loginFailureLine("✓ 授权成功")).toBeNull();
  });
});

describe("FeishuAuth", () => {
  it("registers a personal app through the device flow", async () => {
    const { spawn, calls } = fakeSpawn({
      "config create-app": {
        chunks: ["用户码: U3X6-GVDZ\nhttps://open.feishu.cn/page/cli?user_code=U3X6-GVDZ\n"],
      },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });
    const onPrompt = vi.fn();

    const result = await auth.createApp(onPrompt).done;

    expect(calls[0]).toEqual(["config", "create-app", "--save"]);
    expect(result.ok).toBe(true);
    expect(onPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ userCode: "U3X6-GVDZ" }),
    );
  });

  it("reports a failed device flow with the CLI's message", async () => {
    const { spawn } = fakeSpawn({
      "auth login": { chunks: ["设备授权失败: The specified app does not exist.\n"], code: 1 },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    const result = await auth.login().done;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("设备授权失败");
  });

  it("requests the wiki scopes by default", async () => {
    const { spawn, calls } = fakeSpawn({ "auth login": {} });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    await auth.login().done;

    expect(calls[0]).toEqual([
      "auth", "login", "--json", "--recommend",
      "--domain", "wiki", "--domain", "docs",
    ]);
  });

  it("stops announcing the prompt once one has been seen", async () => {
    const { spawn } = fakeSpawn({
      "auth login": {
        chunks: [
          "用户码: U3X6-GVDZ\n",
          "  等待中... 1/3600 秒\n",
          "  等待中... 2/3600 秒\n",
        ],
      },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });
    const onPrompt = vi.fn();

    await auth.login({ onPrompt }).done;

    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("resolves the app id from the CLI config", async () => {
    const { spawn } = fakeSpawn({ "config get": { chunks: ["cli_a1b2c3d4e5\n"] } });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    expect(await auth.currentAppId()).toBe("cli_a1b2c3d4e5");
  });

  it("parses auth check output", async () => {
    const { spawn } = fakeSpawn({
      "auth check": { chunks: ['{"ok":false,"missing":["wiki:node:update"]}'] },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    expect(await auth.checkScopes(["wiki:wiki"])).toEqual({
      ok: false,
      missing: ["wiki:node:update"],
    });
  });

  it("treats unparseable auth status as logged out", async () => {
    const { spawn } = fakeSpawn({ "auth status": { chunks: ["not json"], code: 1 } });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    expect((await auth.status()).loggedIn).toBe(false);
  });

  it("reads the account name from the OpenAPI identity endpoint", async () => {
    // `auth status` never names the account, and `api` reuses `-o` for "write to
    // this file", so passing `-o json` here would silently create a file named
    // "json" and read stdout as empty.
    const { spawn, calls } = fakeSpawn({
      "api GET": {
        chunks: [
          JSON.stringify({
            code: 0,
            data: { name: "用户321085", open_id: "ou_x" },
            msg: "success",
          }),
        ],
      },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    expect(await auth.userName()).toBe("用户321085");
    expect(calls[0]).toEqual([
      "api",
      "GET",
      "/open-apis/authen/v1/user_info",
      "--as",
      "user",
    ]);
  });

  it("falls back to the English name and tolerates an error payload", async () => {
    const english = fakeSpawn({
      "api GET": { chunks: [JSON.stringify({ code: 0, data: { en_name: "Ada" } })] },
    });
    expect(
      await new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: english.spawn }).userName(),
    ).toBe("Ada");

    const denied = fakeSpawn({
      "api GET": { chunks: [JSON.stringify({ code: 99991663, msg: "permission denied" })], code: 1 },
    });
    expect(
      await new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: denied.spawn }).userName(),
    ).toBeNull();
  });

  it("republishes the prompt once the code line catches up with the link", async () => {
    const { spawn } = fakeSpawn({
      "config create-app": {
        chunks: [
          "  https://open.feishu.cn/page/cli?user_code=2PZ5-FJSK\n",
          "用户码: 2PZ5-FJSK\n有效期: 3600 秒\n",
        ],
      },
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });
    const prompts: unknown[] = [];

    await auth.createApp((prompt) => prompts.push(prompt)).done;

    // The first chunk already carries a usable code, the second adds the expiry,
    // so the card must be refreshed rather than frozen on the partial prompt.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toEqual(
      expect.objectContaining({ userCode: "2PZ5-FJSK", expiresInSeconds: 3600 }),
    );
  });

  it("reports a cancellation instead of a null exit code", async () => {
    let settle: ((value: { code: number | null; output: string }) => void) | null = null;
    const spawn: SpawnProcess = () => ({
      cancel: () => settle?.({ code: null, output: "" }),
      output: () => "",
      done: new Promise((resolve) => {
        settle = resolve;
      }),
    });
    const auth = new FeishuAuth({ cliPath: "feishu-cli", spawnProcess: spawn });

    const handle = auth.login();
    handle.cancel();
    const result = await handle.done;

    expect(result.ok).toBe(false);
    expect(result.error).toBe(CANCEL_MESSAGE);
  });
});
