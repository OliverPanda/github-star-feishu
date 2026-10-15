import { readFileSync } from "node:fs";
import path from "node:path";
import { openDb, type Db } from "../src/db/client.js";
import type { StarEdge } from "../src/github/stars.js";

/** Fresh in-memory database with the real migrations applied. */
export function createTestDb(): Db {
  return openDb({
    dbPath: ":memory:",
    migrationsFolder: path.join(process.cwd(), "drizzle"),
  });
}

export function starEdge(
  fullName: string,
  starredAt: string,
  overrides: Partial<StarEdge["repo"]> = {},
): StarEdge {
  const [owner = "owner", name = "repo"] = fullName.split("/");
  return {
    starredAt,
    repo: {
      fullName: `${owner}/${name}`,
      description: `${fullName} description`,
      language: "TypeScript",
      stars: 100,
      forks: 10,
      topics: ["topic"],
      homepage: null,
      pushedAt: "2024-01-01T00:00:00Z",
      archived: false,
      ...overrides,
    },
  };
}

export const profile = {
  login: "karpathy",
  name: "Andrej",
  avatarUrl: "https://example.com/a.png",
  followers: 221175,
  starredCount: 2,
};

/** Saved copy of a real GitHub trending page, for offline scraping tests. */
export function trendingFixture(): string {
  return readFileSync(path.join(process.cwd(), "tests", "fixtures", "trending.html"), "utf8");
}

/**
 * A fetch stand-in that answers with a canned body and never opens a socket.
 *
 * The trending board is the one part of a sync that scrapes a web page, so
 * every test touching it has to be hermetic: a real request would make the
 * suite depend on github.com being up and on its markup staying put.
 */
export function stubFetch(
  body: string,
  init: { ok?: boolean; status?: number } = {},
): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      text: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}
