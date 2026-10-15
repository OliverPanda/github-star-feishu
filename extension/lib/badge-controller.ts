import { parseRepoUrl, type RepoRef } from "./github.js";
import { createLatestOnly, type IsStale } from "./latest-only.js";

/** Anything the controller is allowed to do to a mounted badge. */
export interface BadgeHandle {
  remove(): void;
}

/** Builds a badge, returning `null` when the attempt was superseded or failed. */
export type BadgeFactory<H extends BadgeHandle> = (
  repo: RepoRef,
  isStale: IsStale,
) => Promise<H | null>;

export interface BadgeController<H extends BadgeHandle> {
  /**
   * Brings the page in line with `url`: shows the badge for the repository it
   * points at, or removes the badge when it is not a repository page. Calling
   * this again while a previous call is still running cancels the older one.
   */
  sync(url: string): Promise<void>;
  /** The repository currently on screen, or `null` when there is no badge. */
  currentRepo(): string | null;
  /** Tears down the badge and the controller's timeline. */
  dispose(): void;
}

/**
 * Owns the single badge that belongs on the page.
 *
 * GitHub swaps pages without reloading, so a badge is built per navigation, and
 * building one involves several awaits. Two navigations in quick succession
 * therefore overlap, and the older attempt can finish last. Every attempt gets a
 * staleness predicate from {@link createLatestOnly}, and an attempt that lost the
 * race removes whatever it built instead of attaching it.
 */
export function createBadgeController<H extends BadgeHandle>(
  create: BadgeFactory<H>,
): BadgeController<H> {
  const latest = createLatestOnly();
  let mounted: H | null = null;
  /** Repository whose badge is currently on screen. */
  let showing: string | null = null;
  /** Repository whose badge is currently being built, if any. */
  let building: string | null = null;

  function teardown(): void {
    showing = null;
    building = null;
    // Supersedes any in-flight attempt so it cannot attach after this call.
    latest.begin();
    mounted?.remove();
    mounted = null;
  }

  async function show(repo: RepoRef): Promise<void> {
    building = repo.fullName;
    const isStale = latest.begin();

    mounted?.remove();
    mounted = null;
    showing = null;

    const created = await create(repo, isStale);
    if (isStale()) {
      created?.remove();
      return;
    }
    if (building === repo.fullName) building = null;
    mounted = created;
    // A build that found no anchor leaves `showing` unset so a later navigation
    // to the same repository can try again instead of being deduplicated away.
    if (created) showing = repo.fullName;
  }

  return {
    async sync(url: string): Promise<void> {
      const next = parseRepoUrl(url);
      if (!next) {
        teardown();
        return;
      }
      // Re-syncing the repository already on screen (or already being built,
      // which happens because GitHub fires one event per in-app navigation)
      // must not rebuild and flicker the badge.
      if (next.fullName === showing || next.fullName === building) return;
      await show(next);
    },
    currentRepo: () => showing,
    dispose: teardown,
  };
}
