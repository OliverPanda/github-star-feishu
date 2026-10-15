import { Octokit } from "octokit";

export interface GitHubClientOptions {
  token?: string | undefined;
  userAgent?: string;
}

/**
 * The `octokit` bundle already ships the retry and throttling plugins, so we
 * get exponential backoff on abuse/secondary rate limits for free instead of
 * reimplementing it.
 */
export function createGitHubClient(options: GitHubClientOptions = {}): Octokit {
  return new Octokit({
    auth: options.token,
    userAgent: options.userAgent ?? "github-star-rag/0.1.0",
  });
}

export interface GitHubRateLimit {
  limit: number;
  remaining: number;
  resetAt: string;
}

export async function getGraphqlRateLimit(client: Octokit): Promise<GitHubRateLimit> {
  const response = await client.request("GET /rate_limit");
  const graphql = response.data.resources.graphql;
  if (!graphql) throw new Error("GitHub did not report a GraphQL rate limit");
  return {
    limit: graphql.limit,
    remaining: graphql.remaining,
    resetAt: new Date(graphql.reset * 1000).toISOString(),
  };
}
