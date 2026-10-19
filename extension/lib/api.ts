/**
 * Typed client for the local sync service.
 *
 * The shapes here mirror `src/api/app.ts`. They are duplicated rather than
 * imported because the extension is a separate build with its own tsconfig and
 * must not pull Node-only modules (better-sqlite3, Drizzle) into a bundle that
 * runs in a browser tab.
 */

export interface ApiSettings {
  baseUrl: string;
  token: string;
}

export interface SubscriptionView {
  login: string;
  alias: string | null;
  isSelf: boolean;
  enabled: boolean;
  followers: number | null;
  starredCount: number | null;
  syncedRepos: number;
  lastSyncedAt: string | null;
}

export interface Endorsement {
  login: string;
  name: string | null;
  isSelf: boolean;
  starredAt: string;
  category: string | null;
}

export interface RepoEndorsements {
  fullName: string;
  tracked: boolean;
  endorsements: Endorsement[];
  stars: number | null;
  language: string | null;
}

export interface RunAuthor {
  login: string;
  newStars: number;
  totalStars: number;
  unchanged: boolean;
  error: string | null;
}

export interface RunSummary {
  id: number;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  trigger: string;
  totalAuthors: number;
  failedAuthors: number;
  newStars: number;
  authors: RunAuthor[];
  error: string | null;
}

export interface Health {
  ok: boolean;
  /** True once a token exists, whether from a scan or from .env. */
  github: boolean;
  githubUser?: string | null;
  githubScopes?: string[];
  githubHint?: string | null;
  llm: boolean;
  /** True once a user token exists, whether from a scan or from .env. */
  feishu: boolean;
  feishuAppId?: string | null;
  feishuUser?: string | null;
  feishuScopes?: string[];
  feishuMissingScopes?: string[];
}

export type FeishuLoginState = "running" | "awaiting_scan" | "success" | "failed";

export interface FeishuLoginPrompt {
  userCode: string | null;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  expiresInSeconds: number | null;
}

export interface FeishuLoginSession {
  id: string;
  state: FeishuLoginState;
  step: "create_app" | "authorize";
  prompt: FeishuLoginPrompt | null;
  /** PNG data URL, ready to use as an img src. */
  qrDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  appId: string | null;
  createdApp: boolean;
}

/** Mirror of the service's `LoginStatus` probe (`GET /api/feishu/status`). */
export interface FeishuLoginStatus {
  loggedIn: boolean;
  appId: string | null;
  userName: string | null;
  scopes: string[];
  hint: string | null;
  missingScopes: string[];
}

export type GitHubLoginState = "running" | "awaiting_scan" | "success" | "failed";

/**
 * The `gh auth login --web` prompt.
 *
 * `verificationUriComplete` is always null for GitHub: its device page ignores a
 * `user_code` parameter and would land on the sign-in page, so the UI has to
 * show the code and the bare link side by side.
 */
export interface GitHubLoginPrompt {
  userCode: string | null;
  verificationUri: string | null;
  verificationUriComplete: string | null;
  expiresInSeconds: number | null;
}

export interface GitHubLoginSession {
  id: string;
  state: GitHubLoginState;
  /** GitHub's device flow needs no app registration, so there is one step. */
  step: "authorize";
  prompt: GitHubLoginPrompt | null;
  /** PNG data URL, ready to use as an img src. */
  qrDataUrl: string | null;
  createdAt: string;
  updatedAt: string;
  error: string | null;
  login: string | null;
  /** Where the scanned token was written, so the user knows what changed. */
  envFile: string;
  tokenSaved: boolean;
}

/** Mirror of the service's `gh auth status` probe (`GET /api/github/status`). */
export interface GitHubLoginStatus {
  loggedIn: boolean;
  login: string | null;
  scopes: string[];
  tokenSource: string | null;
  hint: string | null;
}

/** A knowledge base the signed-in user can write into. */
export interface FeishuSpace {
  spaceId: string;
  name: string;
  description: string | null;
  spaceType: string | null;
  visibility: string | null;
}

/** The knowledge base sync currently writes into. */
export interface FeishuTarget {
  spaceId: string | null;
  space: string | null;
}

export interface RunResult {
  runId: number;
  spaceId: string;
  newStars: number;
  failed: number;
  skipped: string[];
  outcomes: Array<{ login: string; newStars: number; totalStars: number; error: string | null }>;
}

export interface RunOptions {
  logins?: string[];
  full?: boolean;
  skipClassify?: boolean;
  local?: boolean;
  /**
   * Syncs logins that are not subscriptions, for the recommendation list's
   * "一键整理". Without it the service refuses a run whose logins are all
   * unsubscribed, so the button would fail for every fresh account.
   */
  allowUnsubscribed?: boolean;
}

/**
 * One repo inside an author library.
 *
 * Mirrors `LibraryRepo` in `src/library.ts`, which is what the extension's
 * author page renders. Kept as a hand-written copy for the same reason as the
 * rest of this file: importing the service type would drag better-sqlite3 into
 * a browser bundle.
 */
export interface LibraryRepo {
  fullName: string;
  url: string;
  description: string | null;
  summaryZh: string | null;
  language: string | null;
  stars: number;
  starredAt: string;
  category: string;
  monetization: string;
  moneyScore: number | null;
  endorsedBy: number;
}

export interface LibraryCategory {
  name: string;
  count: number;
  /** Mean moneyScore, one decimal; null when nothing in the bucket was scored. */
  averageMoneyScore: string | null;
  repos: LibraryRepo[];
}

/** The whole "作者库" page payload, already grouped by money track. */
export interface AuthorLibrary {
  login: string;
  name: string | null;
  alias: string | null;
  isSelf: boolean;
  followers: number;
  starredCount: number;
  syncedRepos: number;
  lastSyncedAt: string | null;
  dataUpdatedAt: string | null;
  categories: LibraryCategory[];
  unclassified: number;
  topPicks: LibraryRepo[];
  shared: LibraryRepo[];
}

/**
 * One card on the "名人榜" page.
 *
 * Mirrors `RosterView` in `src/roster-view.ts`. `followersLive` is false while
 * the number is still the checked-in approximation, which the UI spells out
 * rather than showing a stale count as if it were fresh.
 */
export interface RosterAuthor {
  login: string;
  name: string;
  tag: string;
  blurb: string;
  followers: number;
  followersLive: boolean;
  tracked: boolean;
  syncedRepos: number;
  lastSyncedAt: string | null;
  topCategories: Array<{ name: string; count: number }>;
}

/**
 * One row of the "趋势榜" page.
 *
 * Mirrors `TrendingRow` in `src/render/markdown.ts`. The daily gain leads
 * because that is the ranking key: total stars say how popular a project is,
 * while the day's gain says which way attention is moving right now.
 */
export interface TrendingRow {
  fullName: string;
  url: string;
  starsToday: number;
  stars: number;
  language: string | null;
  description: string | null;
  category: string;
  summaryZh: string | null;
  monetization?: string | null;
  moneyScore?: number | null;
}

/**
 * The cached trending board, as served by `/api/trending`.
 *
 * `generatedAt` is null until the first sync has scraped the page, which is a
 * normal state rather than an error.
 */
export interface TrendingBoard {
  generatedAt: string | null;
  since: "daily" | "weekly" | "monthly";
  rows: TrendingRow[];
}

/**
 * One project in the weekly Top 10.
 *
 * Mirrors `WeeklyMoneyPick` in `src/weekly-money.ts`. The breakdown is kept
 * separate from the total so the page can explain the ranking instead of
 * presenting the number as a black box.
 */
export interface WeeklyMoneyPick {
  rank: number;
  name: string;
  repo: string;
  url: string;
  category: string;
  source: "week" | "fallback";
  sourceDate: string | null;
  score: number;
  breakdown: {
    demand: number;
    monetization: number;
    delivery: number;
    repeatability: number;
  };
  reason: string;
  scenario: string;
  deploy: string;
  monetization: string;
  fit: string;
}

export interface WeeklyMoneyBoard {
  generatedAt: string | null;
  period: {
    key: string;
    start: string;
    end: string;
    label: string;
  } | null;
  candidateCount: number;
  fallbackCount: number;
  methodology: string;
  picks: WeeklyMoneyPick[];
  pushedAt: string | null;
}

/** Thrown for any non-2xx response, carrying the service's Chinese message. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(settings: ApiSettings, fetchImpl: typeof fetch = fetch) {
    this.baseUrl = normalizeBaseUrl(settings.baseUrl);
    this.token = settings.token;
    // Bind to the global object: calling `this.fetchImpl(...)` would bind `this`
    // to the ApiClient instance, and Chrome's native fetch rejects a foreign
    // receiver with "Illegal invocation".
    this.fetchImpl = fetchImpl.bind(globalThis);
  }

  get health(): Promise<Health> {
    return this.request<Health>("GET", "/api/health");
  }

  async listSubscriptions(): Promise<SubscriptionView[]> {
    const body = await this.request<{ subscriptions: SubscriptionView[] }>("GET", "/api/subscriptions");
    return body.subscriptions;
  }

  async addSubscription(input: {
    login: string;
    alias?: string;
    isSelf?: boolean;
  }): Promise<SubscriptionView> {
    const body = await this.request<{ subscription: SubscriptionView }>(
      "POST",
      "/api/subscriptions",
      input,
    );
    return body.subscription;
  }

  async removeSubscription(login: string): Promise<void> {
    await this.request<{ removed: string }>(
      "DELETE",
      `/api/subscriptions/${encodeURIComponent(login)}`,
    );
  }

  async updateSubscription(
    login: string,
    patch: { alias?: string | null; isSelf?: boolean; enabled?: boolean },
  ): Promise<SubscriptionView> {
    const body = await this.request<{ subscription: SubscriptionView }>(
      "PATCH",
      `/api/subscriptions/${encodeURIComponent(login)}`,
      patch,
    );
    return body.subscription;
  }

  async repoEndorsements(owner: string, name: string): Promise<RepoEndorsements> {
    return this.request<RepoEndorsements>(
      "GET",
      `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/endorsements`,
    );
  }

  /**
   * The author's curated star list, grouped by money track.
   *
   * This is what the "作者库" page shows, so clicking a subscription stays in
   * the extension instead of bouncing the user to github.com.
   */
  async authorLibrary(login: string): Promise<AuthorLibrary> {
    const body = await this.request<{ author: AuthorLibrary }>(
      "GET",
      `/api/authors/${encodeURIComponent(login)}/stars`,
    );
    return body.author;
  }

  async listRuns(): Promise<RunSummary[]> {
    const body = await this.request<{ runs: RunSummary[] }>("GET", "/api/runs");
    return body.runs;
  }

  /** The curated roster, constant across sessions, so it needs no caching. */
  async listRoster(): Promise<RosterAuthor[]> {
    const body = await this.request<{ authors: RosterAuthor[] }>("GET", "/api/roster");
    return body.authors;
  }

  /**
   * Today's GitHub trending board.
   *
   * Read from the copy the local service cached during its last sync, so this
   * never scrapes github.com on a page load — opening the page stays instant
   * and does not depend on GitHub's markup being reachable.
   */
  listTrending(): Promise<TrendingBoard> {
    return this.request<TrendingBoard>("GET", "/api/trending");
  }

  /** Latest weekly Top 10, served from the same cache used for the push card. */
  listWeeklyMoney(): Promise<WeeklyMoneyBoard> {
    return this.request<WeeklyMoneyBoard>("GET", "/api/weekly-money");
  }

  async run(options: RunOptions = {}): Promise<RunResult> {
    return this.request<RunResult>("POST", "/api/runs", options);
  }

  /** Begin Feishu onboarding; the returned session is polled until it ends. */
  async startFeishuLogin(): Promise<FeishuLoginSession> {
    const body = await this.request<{ session: FeishuLoginSession }>(
      "POST",
      "/api/feishu/login",
    );
    return body.session;
  }

  async feishuLoginSession(id: string): Promise<FeishuLoginSession> {
    const body = await this.request<{ session: FeishuLoginSession }>(
      "GET",
      `/api/feishu/login/${encodeURIComponent(id)}`,
    );
    return body.session;
  }

  async cancelFeishuLogin(id: string): Promise<void> {
    await this.request<{ cancelled: boolean }>(
      "DELETE",
      `/api/feishu/login/${encodeURIComponent(id)}`,
    );
  }

  async feishuStatus(): Promise<FeishuLoginStatus> {
    return this.request<FeishuLoginStatus>("GET", "/api/feishu/status");
  }

  async feishuLogout(): Promise<void> {
    await this.request<{ loggedOut: boolean }>("POST", "/api/feishu/logout");
  }

  /** Begin GitHub onboarding; the returned session is polled until it ends. */
  async startGitHubLogin(): Promise<GitHubLoginSession> {
    const body = await this.request<{ session: GitHubLoginSession }>(
      "POST",
      "/api/github/login",
    );
    return body.session;
  }

  async githubLoginSession(id: string): Promise<GitHubLoginSession> {
    const body = await this.request<{ session: GitHubLoginSession }>(
      "GET",
      `/api/github/login/${encodeURIComponent(id)}`,
    );
    return body.session;
  }

  async cancelGitHubLogin(id: string): Promise<void> {
    await this.request<{ cancelled: boolean }>(
      "DELETE",
      `/api/github/login/${encodeURIComponent(id)}`,
    );
  }

  async githubStatus(): Promise<GitHubLoginStatus> {
    return this.request<GitHubLoginStatus>("GET", "/api/github/status");
  }

  async githubLogout(): Promise<void> {
    await this.request<{ loggedOut: boolean }>("POST", "/api/github/logout");
  }

  /** Knowledge bases available to the signed-in account, for the picker. */
  async listFeishuSpaces(): Promise<FeishuSpace[]> {
    const body = await this.request<{ spaces: FeishuSpace[] }>("GET", "/api/feishu/spaces");
    return body.spaces;
  }

  async feishuTarget(): Promise<FeishuTarget> {
    return this.request<FeishuTarget>("GET", "/api/feishu/target");
  }

  /**
   * Pin the knowledge base to sync into.
   *
   * Saved server-side so a scheduled run and a button press land in the same
   * space, rather than each run re-guessing from the name.
   */
  async setFeishuTarget(input: { spaceId: string; name?: string }): Promise<FeishuTarget> {
    return this.request<FeishuTarget>("POST", "/api/feishu/target", input);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.token) {
      // Matches the service's own behaviour: no token means refuse, not allow.
      throw new ApiError("未配置 Token，请在插件设置里填写 API_TOKEN", 401);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A refused connection is the most common failure, and "failed to fetch"
      // tells the user nothing about what to fix.
      throw new ApiError(
        `无法连接同步服务（${this.baseUrl}）。请确认已运行 npm run api。${
          error instanceof Error ? ` 原始错误：${error.message}` : ""
        }`,
        0,
      );
    }

    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
    }

    if (!response.ok) {
      const message = (json as { error?: string } | undefined)?.error;
      throw new ApiError(message ?? `请求失败（HTTP ${response.status}）`, response.status);
    }

    return json as T;
  }
}

/** Tolerates a missing scheme and stray trailing slashes from user input. */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return "http://127.0.0.1:8787";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}
