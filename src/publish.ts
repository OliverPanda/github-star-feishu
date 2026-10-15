import { createHash } from "node:crypto";
import type { Db } from "./db/client.js";
import { getWikiNode, saveWikiNode, type WikiNodeRecord } from "./store.js";
import type { WikiWriter } from "./feishu/types.js";

export interface PublishRequest {
  db: Db;
  writer: WikiWriter;
  login: string;
  spaceId: string;
  title: string;
  markdown: string;
  /**
   * Overrides the derived key for documents that are not per-author, such as
   * the knowledge base index page.
   */
  docKey?: string | undefined;
  /** Attribution only; the document identity is its docKey. */
  authorId?: number | null | undefined;
  parentNodeToken?: string | undefined;
  /** Force a write even when the content hash is unchanged. */
  force?: boolean;
  log?: (message: string) => void;
}

export interface PublishResult {
  nodeToken: string;
  documentId: string | null;
  url: string | null;
  skipped: boolean;
  contentHash: string;
}

export function hashContent(markdown: string): string {
  // The render embeds the run timestamp for human readers, but that would make
  // every run look like a content change and force a rewrite of the whole
  // document. Normalizing it here keeps the hash a function of real content
  // only, so an unchanged star list genuinely skips the write.
  const stable = markdown.replace(/生成时间 \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/g, "生成时间 <normalized>");
  return createHash("sha256").update(stable, "utf8").digest("hex").slice(0, 16);
}

/**
 * Document identity within an author. Colons are avoided because the local
 * dry-run writer uses this as a filename, and NTFS would interpret `a:b` as an
 * alternate data stream rather than a file.
 */
export function documentKey(login: string): string {
  return `${login}__stars`;
}

/**
 * Key of the knowledge base landing page. It belongs to no single author, so
 * it is a fixed key rather than a derived one.
 */
export const INDEX_DOC_KEY = "__index";

/**
 * Key of the GitHub trending board.
 *
 * Like the index it belongs to no author, but it is a separate document rather
 * than a section of the index: its content changes every day, and merging it
 * into the landing page would rewrite that page daily as well.
 */
export const TRENDING_DOC_KEY = "__trending";

/**
 * Key of the grouping node that holds one author's document.
 *
 * The section has no content of its own, so it is tracked separately from the
 * author document; a single author therefore owns two `wiki_nodes` rows.
 */
export function sectionKey(login: string): string {
  return `${login}__section`;
}

export interface SectionResult {
  nodeToken: string;
  /** False when the node was already recorded by an earlier run. */
  created: boolean;
}

/**
 * Resolve the container node for an author, creating it on first sight.
 *
 * Every author gets a subtree so their document is not dumped next to every
 * other author's in the space root. The container has no body, so there is no
 * content hash to compare; identity is the remembered node token alone.
 */
export async function ensureSection(request: {
  db: Db;
  writer: WikiWriter;
  login: string;
  title: string;
  spaceId: string;
  parentNodeToken?: string | undefined;
  log?: (message: string) => void;
}): Promise<SectionResult> {
  const { db, writer, login, title, spaceId, parentNodeToken, log = () => {} } = request;
  const docKey = sectionKey(login);
  const existing = getWikiNode(db, docKey, spaceId);

  if (existing) {
    return { nodeToken: existing.nodeToken, created: false };
  }

  if (!writer.createContainer) {
    throw new Error(`写入器 ${writer.name} 不支持创建分组节点，无法为 ${login} 建立子树。`);
  }

  const result = await writer.createContainer({
    title,
    spaceId,
    parentNodeToken,
  });
  log(`      子树节点 ${title}：${result.nodeToken}`);

  saveWikiNode(db, docKey, {
    authorId: null,
    spaceId,
    nodeToken: result.nodeToken,
    documentId: result.documentId,
    contentHash: null,
    parentNodeToken: parentNodeToken ?? null,
    title,
  });

  return { nodeToken: result.nodeToken, created: true };
}

/**
 * Write a rendered document to the wiki, reusing the node recorded from a
 * previous run.
 *
 * Idempotency is enforced with a content hash: an unchanged document is
 * skipped entirely (no node creation, no rewrite), which is what keeps a daily
 * cron from littering the knowledge base with duplicate pages.
 */
export async function publishDocument(request: PublishRequest): Promise<PublishResult> {
  const {
    db,
    writer,
    authorId,
    login,
    spaceId,
    title,
    markdown,
    parentNodeToken,
    force,
    log = () => {},
  } = request;
  const contentHash = hashContent(markdown);
  const docKey = request.docKey ?? documentKey(login);

  const existing = getWikiNode(db, docKey, spaceId);

  // Placement is corrected before the skip test below: an unchanged body still
  // says nothing about whether the node sits where it belongs.
  const placementConfirmed = await ensurePlacement({
    db,
    writer,
    docKey,
    spaceId,
    title,
    existing,
    parentNodeToken,
    log,
  });

  // Only a node whose position is actually known may record where it lives.
  // Writing the intended parent after a refused move would make the drift look
  // fixed and stop every later run from retrying it.
  const recordedParent = placementConfirmed ? (parentNodeToken ?? null) : undefined;

  if (existing && !force && existing.contentHash === contentHash) {
    log(`      内容未变化，跳过写入（${title}）`);
    return {
      nodeToken: existing.nodeToken,
      documentId: existing.documentId,
      url: null,
      skipped: true,
      contentHash,
    };
  }

  // The page is written in several requests, so a failure part-way leaves a
  // node that already exists in the knowledge base. Recording it as soon as it
  // is created (with a null hash, so the next run still rewrites it) keeps the
  // following run updating that node instead of creating a second one beside it.
  const rememberNode = (info: { nodeToken: string; documentId: string | null }): void => {
    saveWikiNode(db, docKey, {
      authorId: authorId ?? null,
      spaceId,
      nodeToken: info.nodeToken,
      documentId: info.documentId,
      contentHash: null,
      parentNodeToken: recordedParent,
      title,
    });
  };

  // The hash is only written once every request succeeded, so a write that dies
  // half-way leaves the previous hash in place. If the run after that happens to
  // render content equal to some older version, the stale hash matches and the
  // broken page is skipped forever. Invalidating up front makes an interrupted
  // write always cost one rewrite, never a permanently wrong document.
  if (existing) {
    rememberNode({ nodeToken: existing.nodeToken, documentId: existing.documentId });
  }

  const result = await writer.upsertDocument({
    docKey,
    title,
    markdown,
    spaceId,
    parentNodeToken,
    existingNodeToken: existing?.nodeToken,
    existingDocumentId: existing?.documentId ?? undefined,
    onNodeCreated: existing ? undefined : rememberNode,
  });

  saveWikiNode(db, docKey, {
    authorId: authorId ?? null,
    spaceId,
    nodeToken: result.nodeToken,
    documentId: result.documentId,
    contentHash,
    parentNodeToken: recordedParent,
    title,
  });

  return { ...result, contentHash };
}

/**
 * Move a remembered node back under its intended parent when it has drifted.
 *
 * A node token does not carry its position, and `wiki create` only honours the
 * parent on the first write. A document created by an early run (before author
 * subtrees existed, or before the placement was recorded) therefore stays in
 * the space root for good, and every later run would happily update it in
 * place. Comparing the remembered parent against the requested one is what
 * turns that permanent drift into a one-time correction.
 *
 * A writer without `moveNode` (the local dry run, test doubles) is left alone
 * rather than failed: the document body is still worth publishing.
 */
async function ensurePlacement(request: {
  db: Db;
  writer: WikiWriter;
  docKey: string;
  spaceId: string;
  title: string;
  existing: WikiNodeRecord | undefined;
  parentNodeToken: string | undefined;
  log: (message: string) => void;
}): Promise<boolean> {
  const { db, writer, docKey, spaceId, title, existing, parentNodeToken, log } = request;
  // A brand-new node is created under the requested parent by the write itself.
  if (!existing) return true;

  const desired = parentNodeToken ?? null;
  if (existing.parentNodeToken === desired) return true;

  if (!writer.moveNode) {
    log(`      节点位置与预期不符，但写入器 ${writer.name} 不支持移动，已跳过归位（${title}）`);
    return false;
  }

  try {
    await writer.moveNode({ nodeToken: existing.nodeToken, spaceId, parentNodeToken });
  } catch (error) {
    // Drift is cosmetic next to the document body, so a failed move is
    // reported and retried on the next run instead of failing the publish.
    const detail = error instanceof Error ? error.message : String(error);
    log(`      归位失败（${title}）：${detail}`);
    return false;
  }

  log(`      已归位到预期父节点（${title}）`);
  saveWikiNode(db, docKey, {
    spaceId,
    nodeToken: existing.nodeToken,
    documentId: existing.documentId,
    contentHash: existing.contentHash,
    parentNodeToken: desired,
    title,
  });
  return true;
}
