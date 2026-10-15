/**
 * A monotonic generation counter for work that is started asynchronously and
 * can be superseded before it finishes.
 *
 * The GitHub content script rebuilds its badge on every SPA navigation, and
 * building one badge spans several awaits: waiting for the repository header to
 * render, then fetching the shadow-root stylesheet. Two navigations in quick
 * succession therefore overlap, and without a guard the older attempt would
 * attach its badge after the newer one and leave two badges on the page.
 */
export type IsStale = () => boolean;

export interface LatestOnly {
  /**
   * Starts a new generation, superseding every predicate handed out before this
   * call, and returns a predicate for the new one. The predicate reports
   * whether its generation has been superseded.
   */
  begin(): IsStale;
}

export function createLatestOnly(): LatestOnly {
  let current = 0;
  return {
    begin(): IsStale {
      const generation = (current += 1);
      return () => generation !== current;
    },
  };
}
