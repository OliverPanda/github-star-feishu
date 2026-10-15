export interface WikiWriteRequest {
  /** Stable identity of the document, used for upsert. */
  docKey: string;
  title: string;
  markdown: string;
  /** Space to write into; resolved by the caller. */
  spaceId: string;
  /** Parent node token, for placing the doc in a subtree. */
  parentNodeToken?: string | undefined;
  /** Node token from a previous run, enabling an in-place update. */
  existingNodeToken?: string | undefined;
  /** Document id from a previous run, for `doc import --document-id`. */
  existingDocumentId?: string | undefined;
  /**
   * Fires the moment the node exists, before its body is written.
   *
   * A large page is written in several requests, and any of them can fail
   * part-way. Without this the caller only learns the node token after a
   * successful write, so a failure leaves a node nobody recorded and the next
   * run creates a second one next to it.
   */
  onNodeCreated?: ((info: { nodeToken: string; documentId: string | null }) => void) | undefined;
}

export interface WikiWriteResult {
  nodeToken: string;
  documentId: string | null;
  url: string | null;
  /** True when nothing was written because the content hash matched. */
  skipped: boolean;
}

/**
 * Writing a document to a knowledge base is deliberately abstracted: the
 * pipeline must stay runnable (and testable) without Feishu credentials, and
 * it leaves room to swap feishu-cli for a direct SDK implementation later.
 */
export interface WikiWriter {
  readonly name: string;
  /**
   * Resolve the knowledge base to write into.
   *
   * An explicit id always wins. Otherwise the name is matched against the
   * spaces the signed-in user already owns, and a missing match is an error
   * unless the caller opted into creating one.
   */
  ensureSpace(
    name: string,
    spaceId?: string | undefined,
    options?: EnsureSpaceOptions,
  ): Promise<string>;
  /** Knowledge bases the signed-in user can pick from. */
  listSpaces?(): Promise<SpaceSummary[]>;
  /** List child nodes of a parent, used to detect documents we already created. */
  listNodes(spaceId: string, parentNodeToken?: string | undefined): Promise<WikiNodeSummary[]>;
  upsertDocument(request: WikiWriteRequest): Promise<WikiWriteResult>;
  /**
   * Create an empty container node so each author gets its own subtree
   * instead of every document landing side by side in the space root.
   * Optional because only the multi-author batch flow needs it.
   */
  createContainer?(request: ContainerRequest): Promise<WikiWriteResult>;
  /**
   * Move an existing node under a different parent.
   *
   * `wiki create` only honours `parentNodeToken` on the first write, so a node
   * created before its placement was known (an early run, or a document that
   * predates the author subtree) stays wherever it landed. This is the only
   * way to correct that after the fact.
   */
  moveNode?(request: MoveNodeRequest): Promise<void>;
}

export interface EnsureSpaceOptions {
  /**
   * Create the knowledge base when nothing matches the name.
   *
   * Off by default. A signed-in user normally already owns the knowledge base
   * they want their stars filed under, so creating one implicitly is how a
   * tenant ends up with a row of identically named spaces that each hold part
   * of the content.
   */
  createIfMissing?: boolean;
}

export interface ContainerRequest {
  title: string;
  spaceId: string;
  parentNodeToken?: string | undefined;
  /** Reuses an existing node instead of creating a duplicate on every run. */
  existingNodeToken?: string | undefined;
}

export interface MoveNodeRequest {
  nodeToken: string;
  spaceId: string;
  /** Target parent; omitted means the space root. */
  parentNodeToken?: string | undefined;
}

export interface WikiNodeSummary {
  nodeToken: string;
  title: string;
  objType: string;
}

/**
 * A knowledge base the signed-in user can write to.
 *
 * Listed so the caller can pick an existing space instead of letting the
 * pipeline invent one: a personal Feishu tenant usually already holds the
 * space the user wants their stars filed under.
 */
export interface SpaceSummary {
  spaceId: string;
  name: string;
  description: string | null;
  spaceType: string | null;
  visibility: string | null;
}
