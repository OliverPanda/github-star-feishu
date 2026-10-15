import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveCliPath, resolveGhPath, upsertEnvVar } from "../src/config.js";

/** One throwaway directory per test, so no case can see another's .env. */
const tempDirs: string[] = [];

function tempEnv(contents?: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "gsr-config-"));
  tempDirs.push(dir);
  const file = path.join(dir, ".env");
  if (contents !== undefined) writeFileSync(file, contents, "utf8");
  return file;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.GITHUB_TOKEN;
});

/** Records which candidates were probed, without touching the filesystem. */
function probe(available: string[], dirs: string[], platform: NodeJS.Platform = "linux") {
  const seen: string[] = [];
  const resolved = resolveCliPath(undefined, {
    platform,
    dirs,
    exists: (candidate) => {
      seen.push(candidate);
      return available.includes(candidate);
    },
  });
  return { resolved, seen };
}

describe("resolveCliPath", () => {
  it("keeps an explicitly configured path untouched", () => {
    const exists = () => {
      throw new Error("must not probe when a path is configured");
    };
    expect(resolveCliPath("/custom/feishu-cli", { exists })).toBe("/custom/feishu-cli");
  });

  it("finds the binary in ~/.local/bin, which is not on PATH by default", () => {
    const home = path.join("/home", "tester");
    const installDir = path.join(home, ".local", "bin");
    const dirs = [installDir, "/usr/local/bin"];

    const { resolved } = probe([path.join(installDir, "feishu-cli")], dirs);

    expect(resolved).toBe(path.join(installDir, "feishu-cli"));
  });

  it("prefers the earliest directory when several contain a binary", () => {
    const first = path.join("/first", "feishu-cli");
    const dirs = ["/first", "/second"];
    // Join rather than hardcode: the separator differs on Windows.
    const { resolved } = probe([first, path.join("/second", "feishu-cli")], dirs);
    expect(resolved).toBe(first);
  });

  it("uses the .exe name on Windows", () => {
    const dirs = ["C:\\tools"];
    const { seen, resolved } = probe([], dirs, "win32");

    expect(seen).toEqual([path.join("C:\\tools", "feishu-cli.exe")]);
    // Nothing found: fall back to a PATH lookup rather than a bogus absolute path.
    expect(resolved).toBe("feishu-cli");
  });

  it("falls back to a PATH lookup when no known directory has the binary", () => {
    const { resolved } = probe([], ["/nowhere"]);
    expect(resolved).toBe("feishu-cli");
  });
});

/** Same probe, but for the GitHub CLI's own candidate list. */
function probeGh(available: string[], dirs: string[], platform: NodeJS.Platform = "linux") {
  const seen: string[] = [];
  const resolved = resolveGhPath(undefined, {
    platform,
    dirs,
    exists: (candidate) => {
      seen.push(candidate);
      return available.includes(candidate);
    },
  });
  return { resolved, seen };
}

describe("resolveGhPath", () => {
  it("keeps an explicitly configured path untouched", () => {
    const exists = () => {
      throw new Error("must not probe when a path is configured");
    };
    expect(resolveGhPath("/custom/gh", { exists })).toBe("/custom/gh");
  });

  it("finds gh.exe under Program Files on Windows", () => {
    const dirs = ["C:\\Program Files\\GitHub CLI"];
    const expected = path.join(dirs[0]!, "gh.exe");

    const { resolved } = probeGh([expected], dirs, "win32");

    expect(resolved).toBe(expected);
  });

  it("falls back to a PATH lookup when no known directory has the binary", () => {
    const { resolved } = probeGh([], ["/nowhere"]);
    expect(resolved).toBe("gh");
  });
});

describe("upsertEnvVar", () => {
  it("creates the file and adds the key when it does not exist yet", () => {
    const file = tempEnv();

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_abc123");

    expect(readFileSync(file, "utf8")).toBe("GITHUB_TOKEN=gho_abc123\n");
  });

  it("rewrites the value in place and preserves comments and key order", () => {
    const file = tempEnv(
      ["# 手工维护的配置", "API_TOKEN=keep-me", "GITHUB_TOKEN=ghp_old", "API_PORT=8787", ""].join(
        "\n",
      ),
    );

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_new");

    expect(readFileSync(file, "utf8")).toBe(
      [
        "# 手工维护的配置",
        "API_TOKEN=keep-me",
        "GITHUB_TOKEN=gho_new",
        "API_PORT=8787",
        "",
      ].join("\n"),
    );
  });

  it("does not append a second copy on a repeat login", () => {
    const file = tempEnv("GITHUB_TOKEN=gho_first\nAPI_PORT=8787\n");

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_second");
    upsertEnvVar(file, "GITHUB_TOKEN", "gho_third");

    const contents = readFileSync(file, "utf8");
    expect(contents).toBe("GITHUB_TOKEN=gho_third\nAPI_PORT=8787\n");
    expect(contents.match(/GITHUB_TOKEN/g)).toHaveLength(1);
  });

  it("keeps CRLF line endings so a Windows-edited file stays untouched", () => {
    const file = tempEnv("API_TOKEN=keep-me\r\nGITHUB_TOKEN=ghp_old\r\n");

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_new");

    expect(readFileSync(file, "utf8")).toBe("API_TOKEN=keep-me\r\nGITHUB_TOKEN=gho_new\r\n");
  });

  it("quotes a value dotenv would otherwise mangle", () => {
    const file = tempEnv();

    upsertEnvVar(file, "NOTE", "has space # and more");

    expect(readFileSync(file, "utf8")).toBe('NOTE="has space # and more"\n');
  });

  it("matches a key that is already exported, rather than duplicating it", () => {
    const file = tempEnv("export GITHUB_TOKEN=ghp_old\n");

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_new");

    expect(readFileSync(file, "utf8")).toBe("GITHUB_TOKEN=gho_new\n");
  });

  it("updates process.env so the running service picks the token up", () => {
    const file = tempEnv();

    upsertEnvVar(file, "GITHUB_TOKEN", "gho_live");

    expect(process.env.GITHUB_TOKEN).toBe("gho_live");
  });
});
