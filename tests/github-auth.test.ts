import { describe, expect, it, vi } from "vitest";
import {
  CANCEL_MESSAGE,
  DEVICE_URL,
  GitHubAuth,
  loginFailureLine,
  parseAuthState,
  parseLoginPrompt,
  type CommandStream,
  type SpawnProcess,
} from "../src/github/auth.js";

/**
 * Fake CLI: each entry is matched by its first two arguments, and `chunks` are
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

/** The two banner lines `gh auth login --web` prints before it starts polling. */
const LOGIN_BANNER = [
  "! First copy your one-time code: A188-CF1E",
  "Open this URL to continue in your web browser: https://github.com/login/device",
  "",
].join("\n");

describe("parseLoginPrompt", () => {
  it("reads the code and the link out of the gh banner", () => {
    const prompt = parseLoginPrompt(LOGIN_BANNER);

    expect(prompt.userCode).toBe("A188-CF1E");
    expect(prompt.verificationUri).toBe("https://github.com/login/device");
  });

  it("never builds a pre-filled link", () => {
    // GitHub's device URL ignores a user_code parameter and lands on the sign-in
    // page instead of the approval page, so the UI has to show both separately.
    const prompt = parseLoginPrompt(LOGIN_BANNER);

    expect(prompt.verificationUriComplete).toBeNull();
    expect(parseLoginPrompt("https://github.com/login/device?user_code=A188-CF1E")
      .verificationUriComplete).toBeNull();
  });

  it("falls back to the constant URL once the code has arrived", () => {
    // The code and the link land in different chunks, and a card with a code but
    // no link would leave the user with nowhere to type it.
    const prompt = parseLoginPrompt("! First copy your one-time code: A188-CF1E\n");

    expect(prompt.userCode).toBe("A188-CF1E");
    expect(prompt.verificationUri).toBe(DEVICE_URL);
  });

  it("does not announce a prompt when there is nothing actionable yet", () => {
    expect(parseLoginPrompt("Waiting for authentication...\n")).toEqual({
      userCode: null,
      verificationUri: null,
      verificationUriComplete: null,
      expiresInSeconds: null,
    });
  });

  it("reads a bare code even when the label is localized away", () => {
    expect(parseLoginPrompt("一次性代码：WXYZ-9876\n").userCode).toBe("WXYZ-9876");
  });
});

describe("parseAuthState", () => {
  it("maps the logged-in payload gh prints as a single JSON line", () => {
    const state = parseAuthState(
      '{"hosts":{"github.com":[{"state":"success","active":true,"host":"github.com",' +
        '"login":"OliverPanda","tokenSource":"keyring",' +
        '"scopes":"gist, read:org, repo, workflow","gitProtocol":"https"}]}}',
    );

    expect(state).toEqual({
      loggedIn: true,
      login: "OliverPanda",
      scopes: ["gist", "read:org", "repo", "workflow"],
      tokenSource: "keyring",
      gitProtocol: "https",
      hint: null,
    });
  });

  it("ignores the banner line that precedes an empty host list", () => {
    // The CLI exits 0 for "not logged in", so the exit code cannot be trusted
    // and the JSON payload has to be located inside the noise.
    const state = parseAuthState(
      "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n" +
        '{"hosts":{}}\n',
    );

    expect(state.loggedIn).toBe(false);
    expect(state.login).toBeNull();
    expect(state.scopes).toEqual([]);
    expect(state.hint).toBeNull();
  });

  it("treats a rejected token as signed out and keeps the reason", () => {
    const state = parseAuthState(
      '{"hosts":{"github.com":[{"state":"error","error":"HTTP 401: Bad credentials",' +
        '"active":true,"login":"SomeUser"}]}}',
    );

    expect(state.loggedIn).toBe(false);
    expect(state.hint).toContain("Bad credentials");
  });

  it("prefers a healthy host entry over a broken one", () => {
    const state = parseAuthState(
      '{"hosts":{"github.com":[{"state":"error","login":"stale"},' +
        '{"state":"success","login":"OliverPanda","scopes":"repo"}]}}',
    );

    expect(state.loggedIn).toBe(true);
    expect(state.login).toBe("OliverPanda");
  });

  it("survives garbage instead of throwing", () => {
    expect(parseAuthState("not json").loggedIn).toBe(false);
    expect(parseAuthState("").loggedIn).toBe(false);
  });
});

describe("loginFailureLine", () => {
  it("strips the warning prefix gh puts on informational lines", () => {
    expect(loginFailureLine(LOGIN_BANNER)).toBeNull();
  });

  it("keeps the CLI's own wording", () => {
    expect(loginFailureLine("error: HTTP 401: Bad credentials")).toBe(
      "error: HTTP 401: Bad credentials",
    );
    expect(loginFailureLine("错误: 缺少凭据")).toContain("缺少凭据");
  });

  it("returns null when nothing looks like a failure", () => {
    expect(loginFailureLine("✓ Logged in as OliverPanda")).toBeNull();
  });
});

describe("GitHubAuth", () => {
  it("runs the device flow against the isolated config directory", async () => {
    const { spawn, calls } = fakeSpawn({ "auth login": { chunks: [LOGIN_BANNER] } });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });
    const onPrompt = vi.fn();

    const result = await auth.login(onPrompt).done;

    expect(calls[0]).toEqual([
      "auth", "login", "--web", "--skip-ssh-key",
      "--hostname", "github.com", "--git-protocol", "https",
      // Keyring storage would put the token out of reach of `gh auth token`.
      "--insecure-storage",
    ]);
    expect(result.ok).toBe(true);
    expect(onPrompt).toHaveBeenCalledWith(expect.objectContaining({ userCode: "A188-CF1E" }));
  });

  it("pins GH_CONFIG_DIR so the developer's global login cannot leak in", () => {
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh" });
    const env = (auth as unknown as { env(): NodeJS.ProcessEnv }).env();

    expect(env.GH_CONFIG_DIR).toBe("/tmp/gh");
    // A background service has no TTY to answer gh's interactive prompts.
    expect(env.GH_PROMPT_DISABLED).toBe("1");
  });

  it("stops announcing the prompt once one has been seen", async () => {
    const { spawn } = fakeSpawn({
      "auth login": {
        chunks: [
          LOGIN_BANNER,
          "Waiting for authentication... 1/900\n",
          "Waiting for authentication... 2/900\n",
        ],
      },
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });
    const onPrompt = vi.fn();

    await auth.login(onPrompt).done;

    expect(onPrompt).toHaveBeenCalledTimes(1);
  });

  it("republishes the prompt once the code catches up with the link", async () => {
    const { spawn } = fakeSpawn({
      "auth login": {
        chunks: [
          "Open this URL to continue in your web browser: https://github.com/login/device\n",
          "! First copy your one-time code: A188-CF1E\n",
        ],
      },
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });
    const prompts: { userCode: string | null }[] = [];

    await auth.login((prompt) => prompts.push(prompt)).done;

    // The first chunk already yields a usable link, the second adds the code, so
    // the card must be refreshed rather than frozen on the partial prompt.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.userCode).toBe("A188-CF1E");
  });

  it("reports a cancellation instead of a null exit code", async () => {
    let settle: ((value: { code: number | null; output: string }) => void) | null = null;
    const spawn: SpawnProcess = () => ({
      cancel: () => settle?.({ code: null, output: "error: 授权失败\n" }),
      output: () => "",
      done: new Promise((resolve) => {
        settle = resolve;
      }),
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    const handle = auth.login();
    handle.cancel();
    const result = await handle.done;

    expect(result.ok).toBe(false);
    // The user's own cancellation is the real reason, so it outranks the output
    // left behind by the process that was just killed.
    expect(result.error).toBe(CANCEL_MESSAGE);
  });

  it("surfaces the CLI's failure message", async () => {
    const { spawn } = fakeSpawn({
      "auth login": { chunks: ["error: HTTP 401: Bad credentials\n"], code: 1 },
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    const result = await auth.login().done;

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Bad credentials");
  });

  it("reads the account out of the status probe", async () => {
    const { spawn, calls } = fakeSpawn({
      "auth status": {
        chunks: [
          '{"hosts":{"github.com":[{"state":"success","login":"OliverPanda",' +
            '"scopes":"repo","tokenSource":"plaintext"}]}}',
        ],
      },
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    const state = await auth.status();

    expect(state.loggedIn).toBe(true);
    expect(state.login).toBe("OliverPanda");
    expect(calls[0]).toEqual([
      "auth", "status", "--hostname", "github.com", "--json", "hosts",
    ]);
  });

  it("returns the stored token without the warning prefix", async () => {
    const { spawn } = fakeSpawn({
      "auth token": { chunks: ["! Tip: gh auth token is deprecated\n", "gho_scanned123\n"] },
    });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    expect(await auth.token()).toBe("gho_scanned123");
  });

  it("reports no token when the isolated config dir is empty", async () => {
    // `gh auth token` would otherwise fall back to the machine's global login.
    const { spawn } = fakeSpawn({ "auth token": { chunks: ["\n"], code: 1 } });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    expect(await auth.token()).toBeNull();
  });

  it("drops the stored token on logout", async () => {
    const { spawn, calls } = fakeSpawn({ "auth logout": {} });
    const auth = new GitHubAuth({ cliPath: "gh", configDir: "/tmp/gh", spawnProcess: spawn });

    await auth.logout();

    expect(calls[0]).toEqual(["auth", "logout", "--hostname", "github.com"]);
  });
});
