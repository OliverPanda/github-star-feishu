import { describe, expect, it, vi } from "vitest";
import type { Octokit } from "octokit";
import {
  fetchStarredRepos,
  GitHubStarsUnavailableError,
  GitHubUserNotFoundError,
} from "../src/github/stars.js";

interface PageOptions {
  total: number;
  edges: Array<{ starredAt: string; name: string }>;
  hasNextPage?: boolean;
}

/** Minimal stand-in for Octokit that serves one canned page per call. */
function fakeClient(pages: PageOptions[]): { client: Octokit; calls: number } {
  const state = { calls: 0 };
  const graphql = vi.fn(async () => {
    const page = pages[Math.min(state.calls, pages.length - 1)];
    state.calls += 1;
    return {
      user: {
        login: "karpathy",
        name: "Andrej",
        avatarUrl: null,
        followers: { totalCount: 221175 },
        starredRepositories: {
          totalCount: page?.total ?? 0,
          pageInfo: {
            hasNextPage: page?.hasNextPage ?? false,
            endCursor: page?.hasNextPage ? `cursor-${state.calls}` : null,
          },
          edges: (page?.edges ?? []).map((edge) => ({
            starredAt: edge.starredAt,
            node: {
              nameWithOwner: edge.name,
              description: "desc",
              primaryLanguage: { name: "Python" },
              stargazerCount: 42,
              forkCount: 3,
              homepageUrl: null,
              pushedAt: "2024-01-01T00:00:00Z",
              isArchived: false,
              repositoryTopics: { nodes: [{ topic: { name: "llm" } }] },
            },
          })),
        },
      },
    };
  });
  return { client: { graphql } as unknown as Octokit, calls: state.calls };
}

describe("fetchStarredRepos", () => {
  it("maps a page into star edges and a profile", async () => {
    const { client } = fakeClient([
      {
        total: 2,
        edges: [
          { starredAt: "2024-06-01T00:00:00Z", name: "a/b" },
          { starredAt: "2024-05-01T00:00:00Z", name: "c/d" },
        ],
      },
    ]);

    const result = await fetchStarredRepos(client, "karpathy");

    expect(result.edges.map((e) => e.repo.fullName)).toEqual(["a/b", "c/d"]);
    expect(result.edges[0]?.repo.topics).toEqual(["llm"]);
    expect(result.profile.followers).toBe(221175);
    expect(result.stoppedAtWatermark).toBe(false);
  });

  it("walks pages until the cursor runs out", async () => {
    const { client } = fakeClient([
      { total: 3, hasNextPage: true, edges: [{ starredAt: "2024-06-01T00:00:00Z", name: "a/b" }] },
      { total: 3, edges: [{ starredAt: "2024-05-01T00:00:00Z", name: "c/d" }] },
    ]);

    const result = await fetchStarredRepos(client, "karpathy");

    expect(result.pagesFetched).toBe(2);
    expect(result.edges).toHaveLength(2);
  });

  it("stops as soon as the watermark is reached", async () => {
    const { client } = fakeClient([
      {
        total: 3,
        hasNextPage: true,
        edges: [
          { starredAt: "2024-07-01T00:00:00Z", name: "new/one" },
          { starredAt: "2024-06-01T00:00:00Z", name: "already/stored" },
          { starredAt: "2024-05-01T00:00:00Z", name: "older/one" },
        ],
      },
    ]);

    const result = await fetchStarredRepos(client, "karpathy", {
      since: "2024-06-01T00:00:00Z",
    });

    expect(result.edges.map((e) => e.repo.fullName)).toEqual(["new/one"]);
    expect(result.stoppedAtWatermark).toBe(true);
    expect(result.pagesFetched).toBe(1);
  });

  it("skips a deleted repo whose node came back null", async () => {
    const graphql = vi.fn(async () => ({
      user: {
        login: "karpathy",
        name: null,
        avatarUrl: null,
        followers: { totalCount: 1 },
        starredRepositories: {
          totalCount: 2,
          pageInfo: { hasNextPage: false, endCursor: null },
          edges: [
            { starredAt: "2024-06-01T00:00:00Z", node: null },
            {
              starredAt: "2024-05-01T00:00:00Z",
              node: {
                nameWithOwner: "a/b",
                description: null,
                primaryLanguage: null,
                stargazerCount: 1,
                forkCount: 0,
                homepageUrl: null,
                pushedAt: null,
                isArchived: false,
                repositoryTopics: { nodes: [] },
              },
            },
          ],
        },
      },
    }));

    const result = await fetchStarredRepos({ graphql } as unknown as Octokit, "karpathy");
    expect(result.edges.map((e) => e.repo.fullName)).toEqual(["a/b"]);
  });

  it("maps a NOT_FOUND graphql error to a typed user-not-found error", async () => {
    const graphql = vi.fn(async () => {
      throw Object.assign(new Error("GraphQL request failed"), {
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a User with the login of 'nope'." }],
      });
    });

    await expect(
      fetchStarredRepos({ graphql } as unknown as Octokit, "nope"),
    ).rejects.toBeInstanceOf(GitHubUserNotFoundError);
  });

  it("maps a private star list to a typed unavailable error", async () => {
    const graphql = vi.fn(async () => {
      throw Object.assign(new Error("GraphQL request failed"), {
        errors: [{ type: "FORBIDDEN", message: "This user does not have a starred repositories list." }],
      });
    });

    await expect(
      fetchStarredRepos({ graphql } as unknown as Octokit, "someone"),
    ).rejects.toBeInstanceOf(GitHubStarsUnavailableError);
  });
});
