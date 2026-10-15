import type { Octokit } from "octokit";

/** A repository as returned by the star list query. */
export interface StarredRepo {
  fullName: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  topics: string[];
  homepage: string | null;
  pushedAt: string | null;
  archived: boolean;
}

/** One entry in an author's star list. */
export interface StarEdge {
  starredAt: string;
  repo: StarredRepo;
}

export interface AuthorProfile {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  followers: number;
  starredCount: number;
}

export class GitHubUserNotFoundError extends Error {
  constructor(login: string) {
    super(`GitHub user not found: ${login}`);
    this.name = "GitHubUserNotFoundError";
  }
}

/** Raised when an account exists but does not expose its stars publicly. */
export class GitHubStarsUnavailableError extends Error {
  constructor(login: string, reason: string) {
    super(`Cannot read starred repositories for ${login}: ${reason}`);
    this.name = "GitHubStarsUnavailableError";
  }
}

/**
 * Octokit surfaces GraphQL problems as a generic GraphqlResponseError, so the
 * "no such user" case has to be recovered from the embedded error list;
 * otherwise callers cannot tell a typo apart from a transient network failure.
 */
function rethrowGraphqlError(error: unknown, login: string): never {
  const errors = (error as { errors?: Array<{ type?: string; message?: string }> }).errors;
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const message = entry.message ?? "";
      if (entry.type === "NOT_FOUND" && /could not resolve to a user/i.test(message)) {
        throw new GitHubUserNotFoundError(login);
      }
      if (/does not have a starred repositories/i.test(message)) {
        throw new GitHubStarsUnavailableError(login, "star list is not public");
      }
    }
  }
  throw error;
}

/**
 * A single page query. `starredRepositories` is ordered by STARRED_AT DESC,
 * which is what lets the incremental path stop early instead of walking the
 * whole list every run.
 */
const STARRED_PAGE_QUERY = `query($login: String!, $cursor: String, $pageSize: Int!) {
  user(login: $login) {
    login
    name
    avatarUrl
    followers { totalCount }
    starredRepositories(first: $pageSize, after: $cursor, orderBy: { field: STARRED_AT, direction: DESC }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges {
        starredAt
        node {
          nameWithOwner
          description
          primaryLanguage { name }
          stargazerCount
          forkCount
          homepageUrl
          pushedAt
          isArchived
          repositoryTopics(first: 10) { nodes { topic { name } } }
        }
      }
    }
  }
}`;

interface StarredPageResponse {
  user: {
    login: string;
    name: string | null;
    avatarUrl: string | null;
    followers: { totalCount: number };
    starredRepositories: {
      totalCount: number;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      edges: Array<{
        starredAt: string;
        node: {
          nameWithOwner: string;
          description: string | null;
          primaryLanguage: { name: string } | null;
          stargazerCount: number;
          forkCount: number;
          homepageUrl: string | null;
          pushedAt: string | null;
          isArchived: boolean;
          repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
        } | null;
      }>;
    };
  } | null;
}

export interface FetchStarsOptions {
  /** Only return stars newer than this ISO timestamp. Enables incremental sync. */
  since?: string | undefined;
  /** Called after each page so callers can report progress. */
  onProgress?: (info: { fetched: number; total: number }) => void;
  /** Safety valve; GitHub allows 100. */
  pageSize?: number;
  /** Upper bound on pages, to keep a runaway account from burning quota. */
  maxPages?: number;
}

export interface FetchStarsResult {
  profile: AuthorProfile;
  edges: StarEdge[];
  /** True when we stopped early because we reached the `since` watermark. */
  stoppedAtWatermark: boolean;
  pagesFetched: number;
}

/**
 * Fetch an author's starred repositories.
 *
 * Works for any public GitHub account, not just the authenticated user - the
 * star list is public data, which is what makes the "follow an expert's stars"
 * feature possible.
 */
export async function fetchStarredRepos(
  client: Octokit,
  login: string,
  options: FetchStarsOptions = {},
): Promise<FetchStarsResult> {
  const { since, onProgress, pageSize = 100, maxPages = 200 } = options;

  const edges: StarEdge[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;
  let stoppedAtWatermark = false;
  let profile: AuthorProfile | null = null;

  while (pagesFetched < maxPages) {
    let data: StarredPageResponse;
    try {
      data = await client.graphql(STARRED_PAGE_QUERY, { login, cursor, pageSize });
    } catch (error) {
      rethrowGraphqlError(error, login);
    }

    const user = data.user;
    if (!user) throw new GitHubUserNotFoundError(login);

    if (!profile) {
      profile = {
        login: user.login,
        name: user.name,
        avatarUrl: user.avatarUrl,
        followers: user.followers.totalCount,
        starredCount: user.starredRepositories.totalCount,
      };
    }

    const page = user.starredRepositories;
    pagesFetched += 1;

    for (const edge of page.edges) {
      // A repo can be deleted or made private between the index and the fetch,
      // which surfaces as a null node.
      if (!edge.node) continue;

      // The list is newest-first, so the first entry at or below the watermark
      // means everything after it is already stored.
      if (since && edge.starredAt <= since) {
        stoppedAtWatermark = true;
        break;
      }

      edges.push({
        starredAt: edge.starredAt,
        repo: {
          fullName: edge.node.nameWithOwner,
          description: edge.node.description,
          language: edge.node.primaryLanguage?.name ?? null,
          stars: edge.node.stargazerCount,
          forks: edge.node.forkCount,
          topics: edge.node.repositoryTopics.nodes.map((n) => n.topic.name),
          homepage: edge.node.homepageUrl,
          pushedAt: edge.node.pushedAt,
          archived: edge.node.isArchived,
        },
      });
    }

    onProgress?.({ fetched: edges.length, total: page.totalCount });

    if (stoppedAtWatermark) break;
    if (!page.pageInfo.hasNextPage || !page.pageInfo.endCursor) break;
    cursor = page.pageInfo.endCursor;
  }

  if (!profile) throw new GitHubUserNotFoundError(login);

  return { profile, edges, stoppedAtWatermark, pagesFetched };
}

/** Fetch just the profile, without walking the star list. */
export async function fetchAuthorProfile(client: Octokit, login: string): Promise<AuthorProfile> {
  const result = await fetchStarredRepos(client, login, { pageSize: 1, maxPages: 1 });
  return result.profile;
}
