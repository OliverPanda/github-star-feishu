import { describe, expect, it, vi } from "vitest";
import { FeishuCliWriter, parseCliJson, pickItems } from "../src/feishu/cli.js";

interface Recorded {
  args: string[];
  env: NodeJS.ProcessEnv;
}

function createWriter(handler: (args: string[]) => string | Promise<string>) {
  const calls: Recorded[] = [];
  const runCommand = vi.fn(async (args: string[], env: NodeJS.ProcessEnv) => {
    calls.push({ args, env });
    return handler(args);
  });
  const writer = new FeishuCliWriter({
    cliPath: "feishu-cli",
    appId: "cli_test",
    appSecret: "secret",
    runCommand,
    log: () => {},
  });
  return { writer, calls, runCommand };
}

describe("parseCliJson", () => {
  it("parses a bare JSON payload", () => {
    expect(parseCliJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("extracts the payload when log lines surround it", () => {
    const stdout = '导入中...\n{"document_id":"Doc123"}\n完成，用时 2s\n';
    expect(parseCliJson<{ document_id: string }>(stdout)).toEqual({ document_id: "Doc123" });
  });

  it("extracts an array payload embedded in output", () => {
    expect(parseCliJson<number[]>("log\n[1,2,3]\ntrailing")).toEqual([1, 2, 3]);
  });

  it("explains unparseable output instead of throwing a raw SyntaxError", () => {
    expect(() => parseCliJson("not json at all")).toThrow(/未返回可解析的 JSON/);
  });

  it("rejects empty output", () => {
    expect(() => parseCliJson("   ")).toThrow(/未返回任何内容/);
  });
});

describe("FeishuCliWriter.ensureSpace", () => {
  it("normalizes the three list shapes feishu-cli returns", () => {
    expect(pickItems<{ id: string }>([{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(pickItems<{ id: string }>({ spaces: [{ id: "b" }] })).toEqual([{ id: "b" }]);
    expect(pickItems<{ id: string }>({ items: [{ id: "c" }] })).toEqual([{ id: "c" }]);
    expect(pickItems(null)).toEqual([]);
  });

  it("reuses an existing space instead of creating a duplicate", async () => {
    const { writer, calls } = createWriter(() =>
      JSON.stringify({
        count: 1,
        has_more: false,
        spaces: [{ space_id: "sp-1", name: "GitHub Star 精选" }],
      }),
    );

    await expect(writer.ensureSpace("GitHub Star 精选")).resolves.toBe("sp-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "wiki",
      "space-list",
      "--page-all",
      "--as",
      "user",
      "--output",
      "json",
    ]);
  });

  it("reads a bare-array listing, which is the shape `wiki spaces` returns", async () => {
    const { writer } = createWriter(() =>
      JSON.stringify([{ space_id: "sp-bare", name: "我的知识库" }]),
    );

    await expect(writer.ensureSpace("我的知识库")).resolves.toBe("sp-bare");
  });

  it("refuses to create implicitly so a sync cannot leave duplicate spaces", async () => {
    const { writer, calls } = createWriter(() => JSON.stringify({ spaces: [] }));

    await expect(writer.ensureSpace("新知识库")).rejects.toThrow(/没有找到名为/);
    // Only the listing ran: no create was attempted behind the user's back.
    expect(calls).toHaveLength(1);
  });

  it("lists the available spaces so the user can pick one", async () => {
    const { writer } = createWriter(() =>
      JSON.stringify({ spaces: [{ space_id: "sp-7", name: "AI Coding" }] }),
    );

    await expect(writer.ensureSpace("不存在")).rejects.toThrow(/AI Coding\(sp-7\)/);
  });

  it("refuses to guess when several spaces share the name", async () => {
    const { writer } = createWriter(() =>
      JSON.stringify({
        spaces: [
          { space_id: "sp-a", name: "GitHub Star 精选" },
          { space_id: "sp-b", name: "GitHub Star 精选" },
        ],
      }),
    );

    await expect(writer.ensureSpace("GitHub Star 精选")).rejects.toThrow(/存在 2 个/);
  });

  it("creates the space when the caller opts in, parsing the text output", async () => {
    const { writer, calls } = createWriter((args) => {
      if (args[0] === "wiki" && args[1] === "space-list") return JSON.stringify({ spaces: [] });
      if (args[0] === "wiki" && args[1] === "space-create") {
        return "✅ 知识库创建成功！\n  space_id:    7684640308319013860\n  name:        新知识库\n";
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    await expect(
      writer.ensureSpace("新知识库", undefined, { createIfMissing: true }),
    ).resolves.toBe("7684640308319013860");
    expect(calls[1]?.args).toEqual(["wiki", "space-create", "--name", "新知识库"]);
  });

  it("takes a caller-provided space id without listing spaces", async () => {
    const { writer, calls } = createWriter(() => "");
    await expect(writer.ensureSpace("任意", "sp-fixed")).resolves.toBe("sp-fixed");
    expect(calls).toHaveLength(0);
  });

  it("explains that space creation needs a user identity", async () => {
    const { writer } = createWriter((args) => {
      if (args[0] === "wiki" && args[1] === "space-list") return JSON.stringify({ spaces: [] });
      return "❌ 需要 User Token";
    });

    await expect(
      writer.ensureSpace("新知识库", undefined, { createIfMissing: true }),
    ).rejects.toThrow(/auth login/);
  });
});

describe("FeishuCliWriter node operations", () => {
  it("treats an empty space (null output) as having no nodes", async () => {
    const { writer } = createWriter(() => "null");
    await expect(writer.listNodes("sp-empty")).resolves.toEqual([]);
  });

  it("reads a bare-array node listing", async () => {
    const { writer } = createWriter(() =>
      JSON.stringify([{ node_token: "nt-2", title: "karpathy 的 Star 精选", obj_type: "docx" }]),
    );

    await expect(writer.listNodes("sp-1")).resolves.toEqual([
      { nodeToken: "nt-2", title: "karpathy 的 Star 精选", objType: "docx" },
    ]);
  });

  it("parses node lists from the items field", async () => {
    const { writer } = createWriter(() =>
      JSON.stringify({ items: [{ node_token: "nt-1", title: "标题", obj_type: "docx" }] }),
    );

    await expect(writer.listNodes("sp-1")).resolves.toEqual([
      { nodeToken: "nt-1", title: "标题", objType: "docx" },
    ]);
  });

  it("passes the parent node through when listing a subtree", async () => {
    const { writer, calls } = createWriter(() => JSON.stringify({ items: [] }));
    await writer.listNodes("sp-1", "nt-parent");
    expect(calls[0]?.args).toEqual([
      "wiki",
      "nodes",
      "sp-1",
      "--parent",
      "nt-parent",
      "--output",
      "json",
    ]);
  });

  it("imports into the node's own document rather than creating a stray one", async () => {
    const { writer, calls } = createWriter((args) => {
      if (args[0] === "wiki" && args[1] === "create") {
        return JSON.stringify({ data: { node: { node_token: "nt-new", obj_token: "DocObj1" } } });
      }
      if (args[0] === "doc" && args[1] === "import") {
        return JSON.stringify({ data: { document: { document_id: "DocObj1" } } });
      }
      if (args[0] === "doc" && args[1] === "content-update") {
        return JSON.stringify({ ok: true });
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    });

    const result = await writer.upsertDocument({
      docKey: "karpathy__stars",
      title: "karpathy 的 Star 精选",
      markdown: "# 内容",
      spaceId: "sp-1",
      parentNodeToken: "nt-parent",
    });

    expect(result.nodeToken).toBe("nt-new");
    expect(result.documentId).toBe("DocObj1");
    expect(calls[0]?.args).toEqual([
      "wiki",
      "create",
      "--space-id",
      "sp-1",
      "--title",
      "karpathy 的 Star 精选",
      "--parent-node",
      "nt-parent",
      "--output",
      "json",
    ]);
    // The write must target the node's obj_token, not a title-based new doc.
    const writeCall = calls.find((c) => c.args[0] === "doc");
    expect(writeCall?.args.slice(0, 2)).toEqual(["doc", "content-update"]);
    expect(writeCall?.args).toContain("DocObj1");
    expect(writeCall?.args).not.toContain("--title");
  });

  it("overwrites an existing document instead of appending a second copy", async () => {
    const { writer, calls } = createWriter(() => JSON.stringify({ ok: true }));

    const result = await writer.upsertDocument({
      docKey: "karpathy__stars",
      title: "karpathy 的 Star 精选",
      markdown: "# 新内容",
      spaceId: "sp-1",
      existingNodeToken: "nt-old",
      existingDocumentId: "DocOld1",
    });

    expect(result.nodeToken).toBe("nt-old");
    expect(calls.some((c) => c.args[0] === "wiki" && c.args[1] === "create")).toBe(false);
    expect(calls.some((c) => c.args[0] === "wiki" && c.args[1] === "update")).toBe(true);
    // `doc import --document-id` appends, so every rerun used to stack another
    // full copy of the page onto the same document.
    expect(calls[0]?.args.slice(0, 2)).toEqual(["doc", "content-update"]);
    expect(calls[0]?.args).toContain("DocOld1");
    expect(calls[0]?.args).not.toContain("--document-id");
    const updateArgs = calls[0]?.args ?? [];
    expect(updateArgs[updateArgs.indexOf("--mode") + 1]).toBe("overwrite");
    expect(updateArgs).toContain("--markdown-file");
  });

  it("resolves the document id from the node when it is not cached", async () => {
    const { writer, calls } = createWriter((args) => {
      if (args[0] === "wiki" && args[1] === "get") {
        return JSON.stringify({ data: { node: { obj_token: "DocFound1" } } });
      }
      return "";
    });

    await writer.upsertDocument({
      docKey: "karpathy__stars",
      title: "标题",
      markdown: "# 内容",
      spaceId: "sp-1",
      existingNodeToken: "nt-old",
    });

    expect(calls[0]?.args.slice(0, 2)).toEqual(["wiki", "get"]);
    const writeCall = calls.find((c) => c.args[0] === "doc");
    expect(writeCall?.args.slice(0, 2)).toEqual(["doc", "content-update"]);
    expect(writeCall?.args).toContain("DocFound1");
  });

  it("splits a large document so no single request carries the whole page", async () => {
    const { writer, calls } = createWriter(() => JSON.stringify({ ok: true }));
    // antfu's page is ~250KB, which never finished inside the CLI 30s deadline.
    const markdown = Array.from(
      { length: 1200 },
      (_, i) => `## 分组 ${i}\n\n| 仓库 | 说明 |\n| --- | --- |\n| owner/repo-${i} | 描述 ${i} |`,
    ).join("\n\n");
    expect(Buffer.byteLength(markdown, "utf8")).toBeGreaterThan(32 * 1024);

    await writer.upsertDocument({
      docKey: "antfu__stars",
      title: "antfu 的 Star 精选",
      markdown,
      spaceId: "sp-1",
      existingNodeToken: "nt-old",
      existingDocumentId: "DocOld1",
    });

    const writes = calls.filter((c) => c.args[0] === "doc" && c.args[1] === "content-update");
    expect(writes.length).toBeGreaterThan(1);
    // The first request replaces the previous body; the rest extend it. Sending
    // every chunk as `overwrite` would leave only the last fragment behind.
    expect(writes[0]?.args[writes[0]!.args.indexOf("--mode") + 1]).toBe("overwrite");
    for (const write of writes.slice(1)) {
      expect(write.args[write.args.indexOf("--mode") + 1]).toBe("append");
    }
    // Chunks are staged through distinct temp files, so they cannot clobber
    // each other before the child process reads them.
    const files = writes.map((w) => w.args[w.args.indexOf("--markdown-file") + 1]);
    expect(new Set(files).size).toBe(files.length);
  });

  it("retries a chunk that the API drops mid-request instead of losing the page", async () => {
    // A 1751-star page is 14 requests; one dropped connection used to discard
    // the 13 that had already succeeded. The retry is safe because appends are
    // re-sent verbatim, so a transient EOF no longer costs the whole document.
    let attempt = 0;
    const { writer, calls } = createWriter(() => {
      attempt += 1;
      // Fail the second chunk once, then let the retry through.
      if (attempt === 2) throw new Error("unexpected EOF");
      return JSON.stringify({ ok: true });
    });

    const markdown = Array.from(
      { length: 1200 },
      (_, i) => `## 分组 ${i}\n\n| 仓库 | 说明 |\n| --- | --- |\n| owner/repo-${i} | 描述 ${i} |`,
    ).join("\n\n");

    await writer.upsertDocument({
      docKey: "antfu__stars",
      title: "antfu 的 Star 精选",
      markdown,
      spaceId: "sp-1",
      existingNodeToken: "nt-old",
      existingDocumentId: "DocOld1",
    });

    const writes = calls.filter((c) => c.args[0] === "doc" && c.args[1] === "content-update");
    // Every chunk reached the API exactly once, including the one that failed.
    const modes = writes.map((w) => w.args[w.args.indexOf("--mode") + 1]);
    expect(modes.filter((m) => m === "overwrite")).toHaveLength(1);
    expect(modes.filter((m) => m === "append").length).toBeGreaterThan(0);
  });
});

describe("FeishuCliWriter error handling", () => {
  it("surfaces a readable error when the CLI is missing", async () => {
    const writer = new FeishuCliWriter({ cliPath: "definitely-not-installed-cli" });
    await expect(writer.ensureSpace("任意")).rejects.toThrow(/找不到 feishu-cli/);
  });
});

describe("FeishuCliWriter identity", () => {
  it("passes the user token so writes do not fall back to the tenant identity", async () => {
    const calls: NodeJS.ProcessEnv[] = [];
    const writer = new FeishuCliWriter({
      cliPath: "feishu-cli",
      appId: "cli_test",
      appSecret: "secret",
      userToken: "u-token",
      runCommand: async (_args, env) => {
        calls.push(env);
        return JSON.stringify({ node_token: "nt-1", obj_token: "Doc1" });
      },
    });

    await writer.createContainer({ title: "karpathy", spaceId: "sp-1" });

    expect(calls[0]?.FEISHU_USER_ACCESS_TOKEN).toBe("u-token");
    expect(calls[0]?.FEISHU_APP_ID).toBe("cli_test");
  });

  it("omits the token when the user is not logged in", async () => {
    const calls: NodeJS.ProcessEnv[] = [];
    const writer = new FeishuCliWriter({
      cliPath: "feishu-cli",
      runCommand: async (_args, env) => {
        calls.push(env);
        return JSON.stringify({ node_token: "nt-1" });
      },
    });

    await writer.createContainer({ title: "karpathy", spaceId: "sp-1" });

    expect(calls[0]?.FEISHU_USER_ACCESS_TOKEN).toBeUndefined();
  });
});

describe("FeishuCliWriter.createContainer", () => {
  it("creates a subtree node under the requested parent", async () => {
    const { writer, calls } = createWriter(() =>
      JSON.stringify({ data: { node: { node_token: "nt-karpathy", obj_token: "DocK" } } }),
    );

    const result = await writer.createContainer({
      title: "karpathy",
      spaceId: "sp-1",
      parentNodeToken: "nt-root",
    });

    expect(result.nodeToken).toBe("nt-karpathy");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      "wiki",
      "create",
      "--space-id",
      "sp-1",
      "--title",
      "karpathy",
      "--parent-node",
      "nt-root",
      "--output",
      "json",
    ]);
  });

  it("reuses a remembered node instead of creating a duplicate subtree", async () => {
    const { writer, calls } = createWriter(() => {
      throw new Error("must not create a second node");
    });

    const result = await writer.createContainer({
      title: "karpathy",
      spaceId: "sp-1",
      existingNodeToken: "nt-known",
    });

    expect(result.nodeToken).toBe("nt-known");
    expect(result.skipped).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("fails loudly when the created node has no token", async () => {
    const { writer } = createWriter(() => JSON.stringify({ data: { node: {} } }));

    await expect(writer.createContainer({ title: "karpathy", spaceId: "sp-1" })).rejects.toThrow(
      /未找到 node_token/,
    );
  });
});

describe("FeishuCliWriter.moveNode", () => {
  it("moves a node under the target parent", async () => {
    const { writer, calls } = createWriter(() => "");

    await writer.moveNode({
      nodeToken: "nt-karpathy",
      spaceId: "sp-1",
      parentNodeToken: "nt-section",
    });

    expect(calls[0]?.args).toEqual([
      "wiki",
      "move",
      "nt-karpathy",
      "--target-space",
      "sp-1",
      "--target-parent",
      "nt-section",
    ]);
  });

  it("omits --target-parent when the node belongs in the space root", async () => {
    const { writer, calls } = createWriter(() => "");

    await writer.moveNode({ nodeToken: "nt-karpathy", spaceId: "sp-1" });

    expect(calls[0]?.args).toEqual(["wiki", "move", "nt-karpathy", "--target-space", "sp-1"]);
  });

  it("surfaces a failed move so the caller can retry on the next run", async () => {
    const { writer } = createWriter(() => {
      throw new Error("permission denied");
    });

    await expect(
      writer.moveNode({ nodeToken: "nt-1", spaceId: "sp-1", parentNodeToken: "nt-section" }),
    ).rejects.toThrow(/permission denied/);
  });
});
