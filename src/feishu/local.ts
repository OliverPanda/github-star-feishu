import fs from "node:fs/promises";
import path from "node:path";
import type {
  ContainerRequest,
  EnsureSpaceOptions,
  SpaceSummary,
  WikiNodeSummary,
  WikiWriteRequest,
  WikiWriteResult,
  WikiWriter,
} from "./types.js";

/**
 * Filesystem-backed writer used for dry runs and tests.
 *
 * It mirrors the wiki shape on disk (space/author/category) so the layout can
 * be reviewed before anything is pushed to a real tenant.
 */
export class LocalFsWriter implements WikiWriter {
  readonly name = "local-fs";
  private readonly rootDir: string;
  private readonly log: (message: string) => void;

  constructor(rootDir: string, log: (message: string) => void = () => {}) {
    this.rootDir = rootDir;
    this.log = log;
  }

  async ensureSpace(
    name: string,
    _spaceId?: string | undefined,
    _options?: EnsureSpaceOptions,
  ): Promise<string> {
    const dir = path.join(this.rootDir, name);
    await fs.mkdir(dir, { recursive: true });
    return name;
  }

  /** The dry run has one space per directory, listed for parity with Feishu. */
  async listSpaces(): Promise<SpaceSummary[]> {
    try {
      const entries = await fs.readdir(this.rootDir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
          spaceId: entry.name,
          name: entry.name,
          description: null,
          spaceType: "local",
          visibility: null,
        }));
    } catch {
      return [];
    }
  }

  async listNodes(spaceId: string, parentNodeToken?: string | undefined): Promise<WikiNodeSummary[]> {
    const dir = parentNodeToken ? path.join(this.rootDir, spaceId, parentNodeToken) : path.join(this.rootDir, spaceId);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((e) => e.isFile() && e.name.endsWith(".md"))
        .map((e) => ({
          nodeToken: e.name,
          title: e.name.replace(/\.md$/, ""),
          objType: "docx",
        }));
    } catch {
      return [];
    }
  }

  async upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult> {
    const dir = path.join(this.rootDir, request.spaceId, request.parentNodeToken ?? "");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${request.docKey}.md`);

    await fs.writeFile(file, request.markdown, "utf8");
    this.log(`      已写入 ${path.relative(process.cwd(), file)}`);

    return {
      nodeToken: file,
      documentId: null,
      url: null,
      skipped: false,
    };
  }

  /**
   * A container mirrors a directory, so the dry run shows the same nesting the
   * wiki will have and the token stays stable across runs.
   */
  async createContainer(request: ContainerRequest): Promise<WikiWriteResult> {
    const parent = path.join(this.rootDir, request.spaceId, request.parentNodeToken ?? "");
    const rel = request.existingNodeToken ?? path.join("sections", request.title);
    const dir = path.join(parent, rel);
    await fs.mkdir(dir, { recursive: true });
    this.log(`      已创建分组 ${path.relative(process.cwd(), dir)}`);

    return { nodeToken: rel, documentId: null, url: null, skipped: false };
  }
}
