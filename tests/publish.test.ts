import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { documentKey, hashContent, publishDocument } from "../src/publish.js";
import type {
  MoveNodeRequest,
  WikiNodeSummary,
  WikiWriteRequest,
  WikiWriteResult,
  WikiWriter,
} from "../src/feishu/types.js";
import { getWikiNode, upsertAuthor } from "../src/store.js";
import { createTestDb, profile } from "./helpers.js";

class RecordingWriter implements WikiWriter {
  readonly name = "recording";
  readonly writes: WikiWriteRequest[] = [];
  ensureSpaceCalls = 0;

  async ensureSpace(name: string): Promise<string> {
    this.ensureSpaceCalls += 1;
    return name;
  }

  async listNodes(_spaceId?: string, _parentNodeToken?: string): Promise<WikiNodeSummary[]> {
    return [];
  }

  async upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult> {
    this.writes.push(request);
    return {
      nodeToken: request.existingNodeToken ?? `node-${this.writes.length}`,
      documentId: request.existingDocumentId ?? `doc-${this.writes.length}`,
      url: null,
      skipped: false,
    };
  }
}

/** Fails after the node exists, the way a half-written large page does. */
class FailingAfterCreateWriter extends RecordingWriter {
  override async upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult> {
    this.writes.push(request);
    request.onNodeCreated?.({ nodeToken: "node-orphan", documentId: "doc-orphan" });
    throw new Error("context deadline exceeded");
  }
}

/** Records moves, and can be told to fail the way a permission error would. */
class MovingWriter extends RecordingWriter {
  readonly moves: MoveNodeRequest[] = [];
  moveError: Error | null = null;

  async moveNode(request: MoveNodeRequest): Promise<void> {
    this.moves.push(request);
    if (this.moveError) throw this.moveError;
  }
}

/** Serves a fixed node listing, the way a cache-less CI run sees the wiki. */
class ListingWriter extends RecordingWriter {
  readonly listCalls: (string | undefined)[] = [];
  constructor(private readonly nodes: { nodeToken: string; title: string }[]) {
    super();
  }

  override async listNodes(_spaceId: string, parentNodeToken?: string) {
    this.listCalls.push(parentNodeToken);
    return this.nodes.map((node) => ({ ...node, objType: "docx" }));
  }
}

const base = {
  spaceId: "space-1",
  title: "karpathy 的 Star 精选",
};

describe("hashContent", () => {
  it("ignores the run timestamp so an unchanged document stays skipped", () => {
    const a = "# 标题\n\n> 生成时间 2026-09-12 03:04 UTC\n\n正文";
    const b = "# 标题\n\n> 生成时间 2026-09-13 11:59 UTC\n\n正文";
    expect(hashContent(a)).toBe(hashContent(b));
  });

  it("still changes when real content changes", () => {
    const a = "# 标题\n\n> 生成时间 2026-09-12 03:04 UTC\n\n正文 A";
    const b = "# 标题\n\n> 生成时间 2026-09-12 03:04 UTC\n\n正文 B";
    expect(hashContent(a)).not.toBe(hashContent(b));
  });
});

describe("documentKey", () => {
  it("avoids the colon that NTFS would read as an alternate data stream", () => {
    expect(documentKey("karpathy")).toBe("karpathy__stars");
    expect(documentKey("karpathy")).not.toContain(":");
  });
});

describe("publishDocument", () => {
  let db: Db;
  let writer: RecordingWriter;
  let authorId: number;

  beforeEach(() => {
    db = createTestDb();
    writer = new RecordingWriter();
    authorId = upsertAuthor(db, profile).id;
  });

  it("writes once and records the node for the next run", async () => {
    const result = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 内容",
    });

    expect(result.skipped).toBe(false);
    expect(writer.writes).toHaveLength(1);
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.contentHash).toBe(result.contentHash);
  });

  it("skips the second run when nothing changed", async () => {
    const markdown = "# 内容\n\n> 生成时间 2026-09-12 03:04 UTC";
    await publishDocument({ db, writer, authorId, login: "karpathy", ...base, markdown });
    const second = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 内容\n\n> 生成时间 2026-09-13 09:41 UTC",
    });

    expect(second.skipped).toBe(true);
    expect(writer.writes).toHaveLength(1);
  });

  it("reuses the stored node token when the content did change", async () => {
    const first = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 旧内容",
    });
    const second = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 新内容",
    });

    expect(second.nodeToken).toBe(first.nodeToken);
    expect(writer.writes[1]?.existingNodeToken).toBe(first.nodeToken);
  });

  it("rewrites when forced even if the hash matches", async () => {
    const markdown = "# 内容";
    await publishDocument({ db, writer, authorId, login: "karpathy", ...base, markdown });
    const forced = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown,
      force: true,
    });

    expect(forced.skipped).toBe(false);
    expect(writer.writes).toHaveLength(2);
  });

  it("writes again when the target space changed", async () => {
    const markdown = "# 内容";
    await publishDocument({ db, writer, authorId, login: "karpathy", ...base, markdown });
    const moved = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      title: base.title,
      spaceId: "space-2",
      markdown,
    });

    expect(moved.skipped).toBe(false);
    expect(writer.writes).toHaveLength(2);
    // The node token from space-1 is meaningless in space-2, so the writer must
    // be asked to create rather than reopen. Passing the stale token through is
    // what once made a `--local` dry run break a later real Feishu publish.
    expect(writer.writes[1]?.existingNodeToken).toBeUndefined();
    // Both spaces keep their own node; neither record may overwrite the other.
    expect(getWikiNode(db, "karpathy__stars", "space-1")?.nodeToken).toBe("node-1");
    expect(getWikiNode(db, "karpathy__stars", "space-2")?.nodeToken).toBe("node-2");
  });

  it("keeps separate records per author", async () => {
    const other = upsertAuthor(db, { ...profile, login: "ggerganov" }).id;
    await publishDocument({ db, writer, authorId, login: "karpathy", ...base, markdown: "# a" });
    await publishDocument({ db, writer, authorId: other, login: "ggerganov", ...base, markdown: "# a" });

    expect(getWikiNode(db, "karpathy__stars", base.spaceId)).toBeDefined();
    expect(getWikiNode(db, "ggerganov__stars", base.spaceId)).toBeDefined();
  });

  it("publishes a shared document that belongs to no author", async () => {
    const index = await publishDocument({
      db,
      writer,
      login: "index",
      ...base,
      docKey: "__index",
      markdown: "# 知识库索引",
    });

    expect(index.skipped).toBe(false);
    expect(getWikiNode(db, "__index", base.spaceId)).toBeDefined();
    // The index must not collide with any per-author document.
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)).toBeUndefined();
  });

  it("records the node when the write fails part-way, so no orphan is left behind", async () => {
    const writer = new FailingAfterCreateWriter();

    await expect(
      publishDocument({
        db,
        writer,
        authorId,
        login: "antfu",
        spaceId: base.spaceId,
        title: "antfu 的 Star 精选",
        markdown: "# 内容",
      }),
    ).rejects.toThrow(/deadline/);

    // The node exists in Feishu but has no content. Recording it with a null
    // hash makes the next run rewrite that node instead of creating a second
    // page beside it, which is how two stray antfu pages appeared.
    const node = getWikiNode(db, "antfu__stars", base.spaceId);
    expect(node?.nodeToken).toBe("node-orphan");
    expect(node?.documentId).toBe("doc-orphan");
    expect(node?.contentHash).toBeNull();
  });

  it("reuses the node left by a failed write on the next run", async () => {
    await expect(
      publishDocument({
        db,
        writer: new FailingAfterCreateWriter(),
        authorId,
        login: "antfu",
        spaceId: base.spaceId,
        title: "antfu 的 Star 精选",
        markdown: "# 内容",
      }),
    ).rejects.toThrow(/deadline/);

    await publishDocument({
      db,
      writer,
      authorId,
      login: "antfu",
      spaceId: base.spaceId,
      title: "antfu 的 Star 精选",
      markdown: "# 内容",
    });

    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.existingNodeToken).toBe("node-orphan");
    expect(writer.writes[0]?.existingDocumentId).toBe("doc-orphan");
  });

  it("drops the stored hash before rewriting, so an interrupted update is retried", async () => {
    // A large page is written over several requests. If the run dies after the
    // body reached Feishu but before the new hash is stored, the old hash would
    // stay behind and could match a later render, permanently skipping the page.
    // Invalidating up front makes the next run rewrite instead of trusting it.
    await publishDocument({ db, writer, authorId, login: "antfu", ...base, markdown: "# 版本一" });
    expect(getWikiNode(db, "antfu__stars", base.spaceId)?.contentHash).not.toBeNull();

    await expect(
      publishDocument({
        db,
        writer: new FailingAfterCreateWriter(),
        authorId,
        login: "antfu",
        spaceId: base.spaceId,
        title: "antfu 的 Star 精选",
        markdown: "# 版本二",
      }),
    ).rejects.toThrow(/deadline/);
    expect(getWikiNode(db, "antfu__stars", base.spaceId)?.contentHash).toBeNull();

    const retried = await publishDocument({
      db,
      writer,
      authorId,
      login: "antfu",
      spaceId: base.spaceId,
      title: "antfu 的 Star 精选",
      markdown: "# 版本一",
    });

    expect(retried.skipped).toBe(false);
    // One write for the first publish, one for the retry: the equals-old-content
    // render must not be mistaken for a no-op.
    expect(writer.writes).toHaveLength(2);
    expect(writer.writes[1]?.markdown).toBe("# 版本一");
  });
});

describe("publishDocument placement", () => {
  let db: Db;
  let writer: MovingWriter;
  let authorId: number;

  beforeEach(() => {
    db = createTestDb();
    writer = new MovingWriter();
    authorId = upsertAuthor(db, profile).id;
  });

  it("remembers the parent a document was created under", async () => {
    await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      parentNodeToken: "section-karpathy",
      markdown: "# 内容",
    });

    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.parentNodeToken).toBe(
      "section-karpathy",
    );
    expect(writer.moves).toHaveLength(0);
  });

  it("moves a document that an earlier run left in the space root", async () => {
    // Reproduces the real state: the node exists and its body is current, but
    // it was created before the author subtree did, so it hangs in the root.
    await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 内容",
    });
    const before = getWikiNode(db, "karpathy__stars", base.spaceId);
    expect(before?.parentNodeToken).toBeNull();

    const republished = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      spaceId: base.spaceId,
      title: base.title,
      parentNodeToken: "section-karpathy",
      markdown: "# 内容",
    });

    // The body did not change, so nothing is rewritten -- but the position did.
    expect(republished.skipped).toBe(true);
    expect(writer.writes).toHaveLength(1);
    expect(writer.moves).toEqual([
      {
        nodeToken: "node-1",
        spaceId: base.spaceId,
        parentNodeToken: "section-karpathy",
      },
    ]);
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.parentNodeToken).toBe(
      "section-karpathy",
    );
    // A placement-only update must not erase the author attribution.
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.contentHash).toBe(
      before?.contentHash,
    );
  });

  it("does not move a document that is already where it belongs", async () => {
    const options = {
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      parentNodeToken: "section-karpathy",
    };
    await publishDocument({ ...options, markdown: "# 内容" });
    await publishDocument({ ...options, markdown: "# 内容" });

    expect(writer.moves).toHaveLength(0);
  });

  it("keeps publishing the body when the move is refused", async () => {
    await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      ...base,
      markdown: "# 版本一",
    });
    writer.moveError = new Error("forbidden");

    const republished = await publishDocument({
      db,
      writer,
      authorId,
      login: "karpathy",
      spaceId: base.spaceId,
      title: base.title,
      parentNodeToken: "section-karpathy",
      markdown: "# 版本二",
    });

    expect(republished.skipped).toBe(false);
    expect(writer.writes).toHaveLength(2);
    // The placement stays unrecorded so the next run tries the move again,
    // while the body write that did succeed is still hashed.
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.contentHash).toBe(
      republished.contentHash,
    );
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.parentNodeToken).toBeNull();
  });

  it("skips the move silently when the writer cannot move nodes", async () => {
    const plain = new RecordingWriter();
    await publishDocument({ db, writer: plain, authorId, login: "karpathy", ...base, markdown: "# a" });

    const republished = await publishDocument({
      db,
      writer: plain,
      authorId,
      login: "karpathy",
      spaceId: base.spaceId,
      title: base.title,
      parentNodeToken: "section-karpathy",
      markdown: "# a",
    });

    expect(republished.skipped).toBe(true);
    expect(plain.writes).toHaveLength(1);
  });
});

describe("publishDocument recovery", () => {
  it("reuses the page Feishu renamed after its heading instead of creating a twin", async () => {
    const db = createTestDb();
    // The real symptom: the local index is gone, and the page in the knowledge
    // base carries Feishu's own title rather than the one we published with.
    const writer = new ListingWriter([
      { nodeToken: "node-live", title: "karpathy 的 GitHub Star 精选" },
    ]);

    const result = await publishDocument({
      db,
      writer,
      login: "karpathy",
      spaceId: base.spaceId,
      title: "karpathy 的 Star 精选（Andrej）",
      alternateTitles: ["karpathy 的 GitHub Star 精选"],
      markdown: "# karpathy 的 GitHub Star 精选",
    });

    expect(result.nodeToken).toBe("node-live");
    expect(writer.writes).toHaveLength(1);
    expect(writer.writes[0]?.existingNodeToken).toBe("node-live");
    expect(getWikiNode(db, "karpathy__stars", base.spaceId)?.nodeToken).toBe("node-live");
  });

  it("creates a page when no known title matches", async () => {
    const db = createTestDb();
    const writer = new ListingWriter([
      { nodeToken: "node-other", title: "antfu 的 GitHub Star 精选" },
    ]);

    const result = await publishDocument({
      db,
      writer,
      login: "karpathy",
      spaceId: base.spaceId,
      title: "karpathy 的 Star 精选（Andrej）",
      alternateTitles: ["karpathy 的 GitHub Star 精选"],
      markdown: "# karpathy 的 GitHub Star 精选",
    });

    expect(result.nodeToken).toBe("node-1");
    expect(writer.writes[0]?.existingNodeToken).toBeUndefined();
  });

  it("prefers the node that comes back first when several copies exist", async () => {
    const db = createTestDb();
    // Earlier runs left duplicates behind; the pagination order puts the
    // oldest (the one readers already have open) first.
    const writer = new ListingWriter([
      { nodeToken: "node-live", title: "karpathy 的 GitHub Star 精选" },
      { nodeToken: "node-dup", title: "karpathy 的 GitHub Star 精选" },
    ]);

    const result = await publishDocument({
      db,
      writer,
      login: "karpathy",
      spaceId: base.spaceId,
      title: "karpathy 的 Star 精选（Andrej）",
      alternateTitles: ["karpathy 的 GitHub Star 精选"],
      markdown: "# karpathy 的 GitHub Star 精选",
    });

    expect(result.nodeToken).toBe("node-live");
    expect(writer.writes[0]?.existingNodeToken).toBe("node-live");
  });
});
