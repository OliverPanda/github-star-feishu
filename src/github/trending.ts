import * as cheerio from "cheerio";

/**
 * One repository on GitHub's trending page.
 *
 * `starsToday` is the reason this module exists: the total star count says how
 * popular a project is, while the day's gain says which way attention is
 * moving right now. A "上涨趋势" ranking is built from the latter.
 */
export interface TrendingRepo {
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  /** Stars gained in the trending window (the "N stars today" figure). */
  starsToday: number;
  /** Total stars, as shown on the trending card. */
  stars: number;
  forks: number;
}

export interface TrendingOptions {
  /** How many repositories to keep after sorting by today's gain. */
  top?: number;
  log?: (message: string) => void;
  fetchImpl?: typeof fetch;
  since?: "daily" | "weekly" | "monthly";
  signal?: AbortSignal;
}

export const TRENDING_URL = "https://github.com/trending";

/**
 * GitHub's trending page is server-rendered HTML with no JSON API behind it,
 * so the request has to look like a browser: the default Node user agent is
 * answered with a page GitHub renders differently.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** "30,777" -> 30777. Anything unparseable becomes 0 rather than NaN. */
function toCount(text: string | undefined): number {
  if (!text) return 0;
  const digits = text.replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : 0;
}

/**
 * Read the trending cards out of a trending page.
 *
 * The repository name is taken from the `href` rather than the anchor text on
 * purpose: the anchor renders owner and name as two spans separated by a
 * newline, so the text is `owner /\nname` and parsing it would need to special
 * case the separator.
 */
export function parseTrending(html: string): TrendingRepo[] {
  const $ = cheerio.load(html);
  const repos: TrendingRepo[] = [];

  $("article.Box-row").each((_, element) => {
    const card = $(element);
    const href = card.find("h2 a").attr("href")?.trim();
    if (!href || !href.startsWith("/")) return;

    const fullName = href.slice(1);
    if (!fullName.includes("/")) return;

    const description = card.find("p.col-9").text().trim();
    const language = card.find('span[itemprop="programmingLanguage"]').first().text().trim();
    const stars = toCount(card.find(`a[href$="/stargazers"]`).first().text());
    const forks = toCount(card.find(`a[href$="/forks"]`).first().text());

    // The daily gain is not its own element; it sits in a trailing span as
    // "<count> stars today". Matching the whole card keeps this working when
    // GitHub reshuffles the surrounding markup.
    const gained = card.text().match(/([\d,]+)\s+stars\s+today/i);

    repos.push({
      fullName,
      url: `https://github.com/${fullName}`,
      description: description || null,
      language: language || null,
      starsToday: toCount(gained?.[1]),
      stars,
      forks,
    });
  });

  return repos;
}

/**
 * Fetch today's trending repositories, most-gained first.
 *
 * Failure is deliberately non-fatal: the trending board is one page of a
 * knowledge base that also carries every author's star list, and a layout
 * change or a network blip must not take the whole daily sync down with it. An
 * unreachable page is reported in the log and rendered as "暂无数据".
 */
export async function fetchTrending(options: TrendingOptions = {}): Promise<TrendingRepo[]> {
  const { top = 10, log = () => {}, fetchImpl = fetch, since = "daily", signal } = options;

  try {
    const response = await fetchImpl(`${TRENDING_URL}?since=${since}`, {
      headers: {
        "User-Agent": BROWSER_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
      },
      signal: signal ?? AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      log(`      趋势榜抓取失败：HTTP ${response.status}`);
      return [];
    }

    const repos = parseTrending(await response.text());
    if (!repos.length) {
      log("      趋势榜抓取失败：页面结构可能已变化，未解析到任何仓库");
      return [];
    }

    // Cards without a parsed daily figure would sort to the bottom and push
    // real gainers out of a TOP-N list, so they are dropped instead.
    const ranked = repos
      .filter((repo) => repo.starsToday > 0)
      .sort((a, b) => b.starsToday - a.starsToday || b.stars - a.stars)
      .slice(0, top);

    if (!ranked.length) {
      log("      趋势榜抓取失败：所有条目都缺少今日涨幅");
      return [];
    }

    return ranked;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`      趋势榜抓取失败：${detail}`);
    return [];
  }
}
