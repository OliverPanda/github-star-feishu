/**
 * GitHub serves repository pages under many path shapes, and an extension that
 * only understood `/owner/repo` would silently do nothing on most real pages.
 * These helpers turn a location into an owner/repo pair, or nothing at all.
 */

/** Path segments that can never be an owner name. */
const RESERVED_ROOTS = new Set([
  "settings",
  "notifications",
  "explore",
  "topics",
  "trending",
  "collections",
  "sponsors",
  "marketplace",
  "pulls",
  "issues",
  "codespaces",
  "organizations",
  "apps",
  "features",
  "about",
  "pricing",
  "search",
  "new",
  "login",
  "logout",
  "join",
  "dashboard",
  "stars",
  "watching",
  "account",
  "site",
  "security",
  "enterprise",
]);

/**
 * Profile tabs that GitHub exposes as a second path segment. Without this,
 * `/karpathy/followers` would look exactly like a repository called
 * "followers", and the badge would query the wrong thing.
 */
const PROFILE_TABS = new Set(["followers", "following"]);

/** Sub-paths that sit under `/owner/repo/...` and keep it a repo page. */
const REPO_SUBPATHS = new Set([
  "issues",
  "pulls",
  "actions",
  "projects",
  "wiki",
  "security",
  "pulse",
  "graphs",
  "settings",
  "tree",
  "blob",
  "releases",
  "tags",
  "branches",
  "commits",
  "compare",
  "discussions",
  "deployments",
  "network",
  "forks",
  "stargazers",
  "watchers",
  "contributors",
  "community",
  "codespaces",
  "packages",
  "environments",
  "milestones",
  "labels",
  "activity",
]);

export interface RepoRef {
  owner: string;
  name: string;
  fullName: string;
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

/**
 * Extract the repository from a GitHub URL, or `undefined` when the page is
 * not a repository page (profile, settings, search, ...).
 */
export function parseRepoUrl(rawUrl: string): RepoRef | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined;
  }

  if (!isGitHubHost(url.hostname)) return undefined;

  const segments = url.pathname.split("/").filter(Boolean);
  const [owner, name, third] = segments;
  if (!owner || !name) return undefined;
  if (RESERVED_ROOTS.has(owner.toLowerCase())) return undefined;
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(name)) return undefined;
  if (!third && PROFILE_TABS.has(name.toLowerCase())) return undefined;

  // `/owner/repo/<section>` is still the same repo, but `/owner/<tab>` is a
  // profile tab and must not be mistaken for one.
  if (third && !REPO_SUBPATHS.has(third.toLowerCase())) return undefined;

  // `.git` and trailing punctuation appear when links are copied from a clone
  // command rather than the address bar.
  const cleanName = name.replace(/\.git$/i, "");
  if (!cleanName) return undefined;

  return { owner, name: cleanName, fullName: `${owner}/${cleanName}` };
}

export function isGitHubHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "github.com" || host === "www.github.com";
}

/**
 * GitHub logins are case-insensitive but conventionally lowercased in URLs,
 * and the API validates against the same rule.
 */
export function isValidLogin(login: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(login.trim());
}
