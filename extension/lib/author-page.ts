/**
 * Where the "作者库" page lives, relative to the extension root.
 *
 * Kept in its own module so the click target can be asserted without rendering
 * React: the login goes into a query string, so it has to be escaped rather
 * than interpolated raw.
 */
export function authorPagePath(login: string): `/stars.html?login=${string}` {
  return `/stars.html?login=${encodeURIComponent(login)}`;
}

/**
 * The curated roster page. Lives beside the author page rather than inside the
 * popup: the list is a grid of cards and the popup is fixed at 380px wide.
 */
export const ROSTER_PAGE_PATH = "/roster.html" as const;

/**
 * The trending board page.
 *
 * Opens in a full tab for the same reason as the roster: the board is a wide
 * ranking table, and the popup is fixed at 380px.
 */
export const TRENDING_PAGE_PATH = "/trending.html" as const;

/** Reads the login back out of a `stars.html` location. */
export function loginFromSearch(search: string): string {
  return new URLSearchParams(search).get("login")?.trim() ?? "";
}
