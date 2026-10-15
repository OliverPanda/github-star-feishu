import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pRetry from "p-retry";
import { chunkMarkdown } from "./chunk.js";
import type {
  ContainerRequest,
  EnsureSpaceOptions,
  MoveNodeRequest,
  SpaceSummary,
  WikiNodeSummary,
  WikiWriteRequest,
  WikiWriteResult,
  WikiWriter,
} from "./types.js";

const execFileAsync = promisify(execFile);

/** User access tokens last two hours; refresh a little early to avoid mid-run expiry. */
const TOKEN_TTL_MS = 100 * 60 * 1000;

/**
 * Credentials shared by every CLI call, taken from the inherited environment.
 * App credentials go through env rather than argv so they never reach the
 * process list.
 */
export function baseEnv(options: {
  appId?: string | undefined;
  appSecret?: string | undefined;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (options.appId) env.FEISHU_APP_ID = options.appId;
  if (options.appSecret) env.FEISHU_APP_SECRET = options.appSecret;
  return env;
}

/**
 * Pin the child process to the *user* identity.
 *
 * `wiki create` and `doc import` default to the app (tenant) identity, which
 * needs the tenant-scoped `wiki:wiki` grant. A logged-in personal account
 * already holds `wiki:node:create` as a user scope, so passing the user token
 * is what lets a personal wiki work with no platform-side permission review.
 */
export function withUserToken(
  env: NodeJS.ProcessEnv,
  token: string | undefined,
): NodeJS.ProcessEnv {
  if (token) return { ...env, FEISHU_USER_ACCESS_TOKEN: token };
  return env;
}

export interface FeishuCliWriterOptions {
  cliPath: string;
  appId?: string | undefined;
  appSecret?: string | undefined;
  /**
   * User access token for wiki writes.
   *
   * `wiki create` and `doc import` default to the *app* identity, which needs
   * the tenant-scoped `wiki:wiki` grant. The logged-in user token already
   * carries `wiki:node:create`, so passing it explicitly is what lets a
   * personal wiki work without a platform-side permission review.
   */
  userToken?: string | undefined;
  /** Injected in tests to avoid spawning processes. */
  runCommand?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
  log?: (message: string) => void;
}

/** Read a dotted path out of a parsed JSON response, returning undefined if absent. */
function dig(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Return the first dotted path that resolves to a non-empty string. */
function pickString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const found = dig(value, path);
    if (typeof found === "string" && found.length > 0) return found;
  }
  return undefined;
}

/**
 * Normalize a list response into an array.
 *
 * `feishu-cli` is inconsistent here: `wiki spaces` and `wiki nodes` print a
 * bare JSON array, while `wiki space-list` wraps it as `{ spaces: [...] }` and
 * other endpoints use `items` or `data.items`. Reading only one shape silently
 * yields an empty list, which is how a sync ends up believing no knowledge base
 * exists and creates a duplicate one on every run.
 */
export function pickItems<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  for (const path of ["spaces", "items", "nodes", "data.spaces", "data.items"]) {
    const found = dig(value, path);
    if (Array.isArray(found)) return found as T[];
  }
  return [];
}

/**
 * Render the spaces the user could pick instead.
 *
 * A bare "not found" leaves the user guessing at a numeric id they have no way
 * to discover, so the error carries the alternatives directly.
 */
function describeAvailable(spaces: SpaceSummary[]): string {
  if (!spaces.length) return "（当前账号下没有可访问的知识库）";
  const names = spaces.map((space) => `${space.name}(${space.spaceId})`).join("、");
  return `。可选：${names}`;
}

/**
 * Parse a CLI response that may be wrapped in human-readable progress output.
 * `feishu-cli` prints banners and timing stats around the JSON payload, so the
 * outermost JSON value is extracted rather than parsing stdout wholesale.
 */
export function parseCliJson<T>(stdout: string): T {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("feishu-cli 未返回任何内容");

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Fall through to extraction: output carries log lines around the payload.
  }

  const starts = [trimmed.indexOf("{"), trimmed.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) {
    throw new Error(`feishu-cli 未返回可解析的 JSON：${trimmed.slice(0, 300)}`);
  }
  const start = Math.min(...starts);
  const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
  if (end <= start) {
    throw new Error(`feishu-cli 未返回可解析的 JSON：${trimmed.slice(0, 300)}`);
  }

  const candidate = trimmed.slice(start, end + 1);
  try {
    return JSON.parse(candidate) as T;
  } catch {
    throw new Error(`feishu-cli 未返回可解析的 JSON：${candidate.slice(0, 300)}`);
  }
}

/**
 * Thin wrapper over `feishu-cli`.
 *
 * The CLI resolves credentials from FEISHU_APP_ID/FEISHU_APP_SECRET in the
 * child process environment, so secrets are passed through env rather than
 * argv (argv would leak them into the process list).
 */
export class FeishuCliWriter implements WikiWriter {
  readonly name = "feishu-cli";
  private readonly options: FeishuCliWriterOptions;
  private readonly log: (message: string) => void;
  private userTokenCache: string | undefined;
  private userTokenFetchedAt = 0;

  constructor(options: FeishuCliWriterOptions) {
    this.options = options;
    this.log = options.log ?? (() => {});
  }

  /**
   * Build the child environment carrying a *user* identity.
   *
   * Without an explicit user token the CLI authenticates as the app (tenant),
   * and `wiki create` / `doc import` then fail with `wiki:wiki` missing even
   * though the logged-in user token already carries the needed scopes.
   */
  private async buildEnv(): Promise<NodeJS.ProcessEnv> {
    const env = baseEnv(this.options);
    // A test hook stands in for the process, so its identity is reported
    // rather than fetched; that keeps the suite off the network entirely.
    if (this.options.runCommand) return withUserToken(env, this.options.userToken);
    const token = this.options.userToken ?? (await this.resolveUserToken(env));
    return withUserToken(env, token);
  }

  /**
   * Fetch the user token from the CLI login, caching it until it nears expiry.
   * Exported tokens live two hours, so a batch that outlives one refresh cycle
   * still finishes instead of failing halfway through.
   */
  private async resolveUserToken(env: NodeJS.ProcessEnv): Promise<string | undefined> {
    const fresh = Date.now() - this.userTokenFetchedAt < TOKEN_TTL_MS;
    if (this.userTokenFetchedAt > 0 && fresh) return this.userTokenCache;

    this.userTokenFetchedAt = Date.now();
    try {
      const { stdout } = await execFileAsync(
        this.options.cliPath,
        ["auth", "token", "--as", "user"],
        { env, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      );
      this.userTokenCache = stdout.trim() || undefined;
    } catch {
      // Logged out: clear the cache and let the CLI report the real error.
      this.userTokenCache = undefined;
    }
    return this.userTokenCache;
  }

  private async run(args: string[]): Promise<string> {
    if (this.options.runCommand) {
      return this.options.runCommand(args, await this.buildEnv());
    }

    const env = await this.buildEnv();

    try {
      const { stdout } = await execFileAsync(this.options.cliPath, args, {
        env,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (error) {
      const err = error as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
      if (err.code === "ENOENT") {
        throw new Error(
          `找不到 feishu-cli（${this.options.cliPath}）。请先安装，或用 FEISHU_CLI_PATH 指定绝对路径。`,
        );
      }
      const detail = (err.stderr || err.stdout || err.message || "").trim();
      throw new Error(`feishu-cli ${args.slice(0, 2).join(" ")} 失败：${detail}`);
    }
  }

  /**
   * Run a `wiki ... --output json` style command.
   * Note `api` uses `-o` for a file path, so it deliberately goes through `run`.
   */
  private async runJson<T>(args: string[]): Promise<T> {
    return parseCliJson<T>(await this.run([...args, "--output", "json"]));
  }

  /**
   * Knowledge bases the signed-in user can pick from.
   *
   * `space-list` is the only listing endpoint that supports `--page-all`; the
   * older `wiki spaces` returns a single page as a bare array. It is also the
   * one that honours `--as user`, so a tenant bot credential cannot shadow the
   * spaces the user actually owns.
   */
  async listSpaces(): Promise<SpaceSummary[]> {
    const listed = await this.runJson<unknown>([
      "wiki",
      "space-list",
      "--page-all",
      "--as",
      "user",
    ]);

    interface SpaceRow {
      space_id?: string;
      name?: string;
      description?: string;
      space_type?: string;
      visibility?: string;
    }

    return pickItems<SpaceRow>(listed)
      .map((row) => ({
        spaceId: row.space_id ?? "",
        name: row.name ?? "",
        description: row.description ?? null,
        spaceType: row.space_type ?? null,
        visibility: row.visibility ?? null,
      }))
      .filter((space) => space.spaceId.length > 0);
  }

  /**
   * Resolve the knowledge base to write into.
   *
   * Deliberately biased towards reuse: the user signs in precisely because the
   * space already exists in their tenant. Falling back to creation on a miss is
   * what produced several identically named spaces that each held a slice of
   * the same content, so creation now has to be asked for explicitly.
   */
  async ensureSpace(
    name: string,
    spaceId?: string | undefined,
    options: EnsureSpaceOptions = {},
  ): Promise<string> {
    if (spaceId) return spaceId;

    const spaces = await this.listSpaces();
    const matches = spaces.filter((space) => space.name === name);

    if (matches.length === 1) {
      const found = matches[0]!;
      this.log(`      复用已存在的知识库：${found.name} (${found.spaceId})`);
      return found.spaceId;
    }

    if (matches.length > 1) {
      // Guessing here is how one knowledge base silently becomes two: the
      // second copy then receives a different half of the same content.
      const candidates = matches.map((space) => space.spaceId).join("、");
      throw new Error(
        `存在 ${matches.length} 个名为「${name}」的知识库（${candidates}）。` +
          `请在插件里选定其中一个，或用 --space-id 指定要写入的 space_id。`,
      );
    }

    if (!options.createIfMissing) {
      throw new Error(
        `没有找到名为「${name}」的知识库。请在插件里选择已有的知识库，` +
          `或用 --space-id 指定 space_id${describeAvailable(spaces)}。`,
      );
    }

    this.log(`      创建知识库：${name}`);
    return this.createSpace(name);
  }

  /**
   * Create a knowledge base through the dedicated subcommand.
   *
   * `wiki space-create` rejects `--output`, so unlike every other call here it
   * answers with a human-readable block and the id has to be matched out of the
   * text. The endpoint only accepts a user identity, hence the login hint.
   */
  private async createSpace(name: string): Promise<string> {
    const raw = await this.run(["wiki", "space-create", "--name", name]);
    const id = raw.match(/space_id:\s*([A-Za-z0-9_-]+)/)?.[1];
    if (!id) {
      throw new Error(
        `创建知识库返回中未找到 space_id：${raw.slice(0, 300)}\n` +
          `提示：创建知识库需要用户身份，请先执行 \`feishu-cli auth login\`，` +
          `或用 --space-id 指定一个已存在的知识库。`,
      );
    }
    return id;
  }

  async listNodes(spaceId: string, parentNodeToken?: string | undefined): Promise<WikiNodeSummary[]> {
    interface NodeRow {
      node_token?: string;
      title?: string;
      obj_type?: string;
    }
    const args = ["wiki", "nodes", spaceId];
    if (parentNodeToken) args.push("--parent", parentNodeToken);

    // A space with no nodes prints `null` rather than an empty list, and a
    // populated one prints a bare array; `pickItems` normalizes both.
    const listed = await this.runJson<unknown>(args);
    return pickItems<NodeRow>(listed)
      .filter((n): n is NodeRow & { node_token: string } => Boolean(n.node_token))
      .map((n) => ({
        nodeToken: n.node_token,
        title: n.title ?? "",
        objType: n.obj_type ?? "docx",
      }));
  }

  async upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult> {
    if (request.existingNodeToken) {
      this.log(`      更新已有节点：${request.title}`);
      // The node already points at a document; rewriting that same document is
      // what keeps the wiki page stable instead of accumulating new pages.
      if (request.existingDocumentId) {
        await this.importMarkdown(request.markdown, request.existingDocumentId);
      } else {
        const refreshed = await this.getNodeDocumentId(request.existingNodeToken);
        if (refreshed) await this.importMarkdown(request.markdown, refreshed);
        else throw new Error(
          `节点 ${request.existingNodeToken} 缺少 document_id，无法更新内容。` +
            `请用 --force 重新创建，或删除该节点后重试。`,
        );
      }
      await this.run(["wiki", "update", request.existingNodeToken, "--title", request.title]);
      return {
        nodeToken: request.existingNodeToken,
        documentId: request.existingDocumentId ?? null,
        url: null,
        skipped: false,
      };
    }

    this.log(`      创建节点：${request.title}`);
    const { nodeToken, documentId } = await this.createNode(
      request.spaceId,
      request.title,
      request.parentNodeToken,
    );
    // Report the node before any content is pushed: a large page takes several
    // requests and a failure in the middle would otherwise lose track of a node
    // that already exists in the knowledge base.
    request.onNodeCreated?.({ nodeToken, documentId });
    if (documentId) {
      await this.importMarkdown(request.markdown, documentId);
    } else {
      this.log(`      警告：未取得 document_id，内容写入到按标题新建的文档`);
      await this.importMarkdown(request.markdown, undefined, request.title);
    }

    return { nodeToken, documentId, url: null, skipped: false };
  }

  /**
   * Create a node and return its token plus the document behind it.
   *
   * A docx node is created empty; its own document must be filled via the
   * obj_token. Importing by title instead would create an unrelated document
   * and leave the node blank.
   */
  private async createNode(
    spaceId: string,
    title: string,
    parentNodeToken?: string | undefined,
  ): Promise<{ nodeToken: string; documentId: string | null }> {
    const args = ["wiki", "create", "--space-id", spaceId, "--title", title];
    if (parentNodeToken) args.push("--parent-node", parentNodeToken);

    const createdRaw = await this.run([...args, "--output", "json"]);
    const created = parseCliJson<unknown>(createdRaw);
    const nodeToken = pickString(created, [
      "data.node.node_token",
      "node.node_token",
      "node_token",
      "data.node_token",
    ]);
    if (!nodeToken) {
      throw new Error(`创建节点返回中未找到 node_token：${createdRaw.slice(0, 300)}`);
    }

    const documentId =
      pickString(created, ["data.node.obj_token", "node.obj_token", "obj_token"]) ?? null;
    return { nodeToken, documentId };
  }

  /**
   * Create the grouping node for an author.
   *
   * Title-only nodes are not addressable by docKey, so the caller stores the
   * returned token and passes it back on later runs; without that, every sync
   * would append another copy of the same subtree.
   */
  async createContainer(request: ContainerRequest): Promise<WikiWriteResult> {
    if (request.existingNodeToken) {
      return {
        nodeToken: request.existingNodeToken,
        documentId: null,
        url: null,
        skipped: true,
      };
    }
    this.log(`      创建分组节点：${request.title}`);
    const { nodeToken, documentId } = await this.createNode(
      request.spaceId,
      request.title,
      request.parentNodeToken,
    );
    return { nodeToken, documentId, url: null, skipped: false };
  }

  /**
   * Relocate a node that ended up in the wrong place.
   *
   * The node token is stable across a move, so nothing else has to be
   * re-recorded; only where it hangs changes.
   */
  async moveNode(request: MoveNodeRequest): Promise<void> {
    const args = [
      "wiki",
      "move",
      request.nodeToken,
      "--target-space",
      request.spaceId,
    ];
    if (request.parentNodeToken) args.push("--target-parent", request.parentNodeToken);
    await this.run(args);
  }

  /** Resolve the document backing an existing wiki node. */
  private async getNodeDocumentId(nodeToken: string): Promise<string | null> {
    const raw = await this.run(["wiki", "get", nodeToken, "--output", "json"]);
    return (
      pickString(parseCliJson<unknown>(raw), [
        "data.node.obj_token",
        "node.obj_token",
        "obj_token",
      ]) ?? null
    );
  }

  /**
   * Write Markdown into a document, via a temp file (the CLI reads from disk).
   *
   * Updating an existing document must go through `doc content-update
   * --mode overwrite`: `doc import --document-id` *appends*, so every rerun of a
   * sync stacked another full copy of the page on top of the previous one.
   * Only a brand-new document (no id yet) is created through `doc import`.
   *
   * The CLI sends one request per call and aborts it after 30 seconds, so a
   * page is split into request-sized pieces: the first overwrites whatever was
   * there and the rest append. Dropping the whole backlog in one call is how a
   * prolific star list (antfu curates 1751 repositories) ends up with
   * `context deadline exceeded` and no content at all.
   */
  private async importMarkdown(
    markdown: string,
    documentId: string | undefined,
    title?: string,
  ): Promise<string | null> {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");

    const dir = await mkdtemp(path.join(os.tmpdir(), "star-rag-"));

    try {
      // A new document has nothing to overwrite, so it keeps the single-call
      // `doc import` path; only the update path is split.
      if (!documentId) {
        const file = path.join(dir, "doc.md");
        await writeFile(file, markdown, "utf8");
        const stdout = await this.run([
          "doc",
          "import",
          file,
          ...(title ? ["--title", title] : []),
          "--output",
          "json",
        ]);
        return this.pickImportedDocumentId(stdout);
      }

      const chunks = chunkMarkdown(markdown);
      if (chunks.length > 1) {
        this.log(`      内容较大，分 ${chunks.length} 次写入`);
      }
      for (const [index, chunk] of chunks.entries()) {
        const file = path.join(dir, `doc-${index}.md`);
        await writeFile(file, chunk, "utf8");
        // The first request replaces the previous body; appending from there
        // keeps the finished page equal to the rendered Markdown.
        //
        // A single dropped connection (`unexpected EOF`) used to abort the
        // whole page, which for a 1751-star account means losing 14 successful
        // writes to one flaky request. Retrying the chunk is safe because the
        // first request overwrites and the rest append, so re-sending the same
        // chunk lands the same content rather than duplicating it.
        await pRetry(
          () =>
            this.run([
              "doc",
              "content-update",
              documentId,
              "--mode",
              index === 0 ? "overwrite" : "append",
              "--markdown-file",
              file,
              "--output",
              "json",
            ]),
          {
            retries: 3,
            minTimeout: 2_000,
            factor: 2,
            onFailedAttempt: ({ error, retriesLeft }) => {
              const detail = error instanceof Error ? error.message : String(error);
              this.log(
                `      第 ${index + 1}/${chunks.length} 段写入失败（剩 ${retriesLeft} 次重试）：${detail}`,
              );
            },
          },
        );
      }
      // Overwriting cannot change a document id, so the known one stands.
      return documentId;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Pull the new document id out of a `doc import` response. */
  private pickImportedDocumentId(stdout: string): string | null {
    try {
      const parsed = parseCliJson<unknown>(stdout);
      const id = pickString(parsed, [
        "data.document.document_id",
        "document.document_id",
        "document_id",
      ]);
      if (id) return id;
    } catch {
      // Output was not JSON; fall back to a token scan below.
    }
    return stdout.match(/[A-Za-z0-9]{20,}/)?.[0] ?? null;
  }
}
