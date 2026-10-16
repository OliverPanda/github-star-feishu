import {
  CATEGORIES,
  FALLBACK_CATEGORY,
  normalizeMonetization,
  normalizeMoneyScore,
  type Category,
} from "../taxonomy.js";
import { TRENDING_URL } from "../github/trending.js";

export interface RenderedRepo {
  fullName: string;
  url: string;
  description: string | null;
  language: string | null;
  stars: number;
  starredAt: string;
  category: Category;
  summaryZh: string | null;
  /** How the repo is expected to earn money; absent on legacy rows. */
  monetization?: string | null;
  /** 1-5 monetary promise; absent on legacy rows. */
  moneyScore?: number | null;
  /** Number of tracked authors who starred this repo; >=2 means cross-endorsed. */
  endorsedBy: number;
}

export interface RenderContext {
  login: string;
  displayName: string | null;
  followers: number;
  starredCount: number;
  isSelf: boolean;
  generatedAt: Date;
  /** Newest starredAt across the document; stable across runs unless data changed. */
  dataUpdatedAt?: string | null;
  /** Logins of every author in the database, for the cross-endorsement note. */
  trackedAuthors: string[];
}

export interface RenderResult {
  markdown: string;
  /** Per-category counts, so callers can log or diff a summary. */
  counts: Record<string, number>;
}

function formatNumber(value: number): string {
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Escape the characters that would break a Markdown table cell. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

/**
 * Feishu rejects a table block whose cell count exceeds 2000 with
 * `DOC_TABLE_CELL_LIMIT`; a 797-row category is 3985 cells and fails the whole
 * document write. A long category is therefore emitted as several consecutive
 * tables instead of one.
 *
 * The budget stays below the hard limit because the header row consumes cells
 * too, and because the exact boundary (>= vs >) is not documented.
 */
const TABLE_CELL_BUDGET = 1800;

/** Column headers of the per-category repository table. */
const REPO_TABLE_COLUMNS = [
  "仓库",
  "变现路径",
  "潜力",
  "语言",
  "Stars",
  "收藏时间",
  "一句话说明",
];

/** Rows shown in the headline ranking; the long tail stays in its category. */
const TOP_MONEY_ROWS = 15;

/** A repo needs at least this score to be worth a line in the headline ranking. */
const TOP_MONEY_MIN_SCORE = 4;

/** Render a score as filled dots so the ranking is scannable without reading digits. */
function formatMoneyScore(score: number | null | undefined): string {
  if (score === null || score === undefined) return "-";
  const value = normalizeMoneyScore(score);
  return `${"●".repeat(value)}${"○".repeat(5 - value)} ${value}`;
}

/** How many data rows fit in one table without busting the cell budget. */
function tableRowBudget(columnCount: number): number {
  return Math.max(1, Math.floor(TABLE_CELL_BUDGET / columnCount) - 1);
}

function chunkRows<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * First heading of one author's document.
 *
 * Exported because Feishu shows this line as the document title, so the
 * publisher needs the exact same text to recognise its own page again after a
 * lost local index. The title handed to the wiki API and this heading have to
 * stay in step, which is why both are derived here.
 */
export function authorDocumentHeading(context: { login: string; isSelf: boolean }): string {
  return context.isSelf ? "我的 GitHub Star 精选" : `${context.login} 的 GitHub Star 精选`;
}

/**
 * Render the star list as a Markdown document grouped by category.
 *
 * The output is deterministic given the same inputs (categories in taxonomy
 * order, repos by stars then star date) so that an unchanged library produces
 * byte-identical Markdown. That is what lets the writer skip no-op updates
 * instead of rewriting the whole Feishu document on every sync.
 */
export function renderMarkdown(repos: RenderedRepo[], context: RenderContext): RenderResult {
  const grouped = new Map<Category, RenderedRepo[]>();
  for (const repo of repos) {
    const list = grouped.get(repo.category) ?? [];
    list.push(repo);
    grouped.set(repo.category, list);
  }

  const counts: Record<string, number> = {};
  const heading = authorDocumentHeading(context);

  const lines: string[] = [];
  lines.push(`# ${heading}`);
  lines.push("");

  const who = context.displayName ? `${context.login}（${context.displayName}）` : context.login;
  const dataDate = context.dataUpdatedAt ? formatDate(context.dataUpdatedAt) : "-";
  lines.push(
    `> 数据来源：[${who}](https://github.com/${context.login}?tab=stars) ｜ ` +
      `共 **${repos.length}** 个已分类仓库 ｜ 作者粉丝数 ${formatNumber(context.followers)} ｜ ` +
      `数据更新至 ${dataDate}`,
  );
  lines.push(">");
  lines.push(`> 生成时间 ${context.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  lines.push("");

  // The reader's stated goal is to find what can make money, so the ranking
  // leads the document instead of being derivable only by scanning 12 tables.
  const ranked = repos
    .filter((repo) => (repo.moneyScore ?? 0) >= TOP_MONEY_MIN_SCORE)
    .sort(
      (a, b) =>
        (b.moneyScore ?? 0) - (a.moneyScore ?? 0) ||
        b.endorsedBy - a.endorsedBy ||
        b.stars - a.stars,
    )
    .slice(0, TOP_MONEY_ROWS);

  if (ranked.length) {
    lines.push("## 变现机会榜");
    lines.push("");
    lines.push(
      `> 按「变现潜力」排序，取潜力 ${TOP_MONEY_MIN_SCORE} 分以上的前 ${ranked.length} 个。` +
        `同一批仓库在下方按赛道完整列出。`,
    );
    lines.push("");
    lines.push("| 排名 | 仓库 | 赛道 | 变现路径 | 潜力 | 一句话说明 |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    ranked.forEach((repo, index) => {
      const desc = repo.summaryZh ?? repo.description ?? "";
      lines.push(
        `| ${index + 1} | [${repo.fullName}](${repo.url}) | ${repo.category} | ` +
          `${normalizeMonetization(repo.monetization)} | ${formatMoneyScore(repo.moneyScore)} | ` +
          `${escapeCell(desc)} |`,
      );
    });
    lines.push("");
  }

  // Cross-endorsement is the distinctive signal of tracking several experts, so
  // surface it up front rather than burying it inside each section.
  if (context.trackedAuthors.length > 1) {
    const shared = repos
      .filter((r) => r.endorsedBy >= 2)
      .sort((a, b) => b.endorsedBy - a.endorsedBy || b.stars - a.stars)
      .slice(0, 10);

    if (shared.length) {
      lines.push("## 多位关注对象共同收藏");
      lines.push("");
      lines.push(`> 下列仓库被 ${context.trackedAuthors.length} 个跟踪账号中的多个账号同时 star，是可信度最高的推荐。`);
      lines.push("");
      lines.push("| 仓库 | 共同收藏数 | Stars | 一句话说明 |");
      lines.push("| --- | --- | --- | --- |");
      for (const repo of shared) {
        const desc = repo.summaryZh ?? repo.description ?? "";
        lines.push(
          `| [${repo.fullName}](${repo.url}) | ${repo.endorsedBy} | ${formatNumber(repo.stars)} | ${escapeCell(desc)} |`,
        );
      }
      lines.push("");
    }
  }

  lines.push("## 目录");
  lines.push("");
  for (const category of CATEGORIES) {
    const list = grouped.get(category);
    if (!list?.length) continue;
    counts[category] = list.length;
    // Average potential next to the count answers "is this whole track worth
    // my time" without opening the section; "-" when nothing was scored yet.
    const scored = list
      .map((repo) => repo.moneyScore)
      .filter((score): score is number => typeof score === "number");
    const average = scored.length
      ? (scored.reduce((sum, score) => sum + score, 0) / scored.length).toFixed(1)
      : null;
    const suffix = average ? `，平均潜力 ${average}` : "";
    lines.push(`- ${category}（${list.length}${suffix}）`);
  }
  lines.push("");

  for (const category of CATEGORIES) {
    const list = grouped.get(category);
    if (!list?.length) continue;

    const sorted = [...list].sort(
      (a, b) => b.stars - a.stars || b.starredAt.localeCompare(a.starredAt),
    );
    const chunks = chunkRows(sorted, tableRowBudget(REPO_TABLE_COLUMNS.length));
    const separator = REPO_TABLE_COLUMNS.map(() => "---").join(" | ");

    chunks.forEach((rows, index) => {
      // Only a category big enough to be split gets a part suffix, so small
      // documents keep the plain heading and their content hash stays stable.
      const suffix = chunks.length > 1 ? `（${index + 1}/${chunks.length}）` : "";
      lines.push(`## ${category}${suffix}`);
      lines.push("");
      lines.push(`| ${REPO_TABLE_COLUMNS.join(" | ")} |`);
      lines.push(`| ${separator} |`);

      for (const repo of rows) {
        const desc = repo.summaryZh ?? repo.description ?? "";
        lines.push(
          `| [${repo.fullName}](${repo.url}) | ${normalizeMonetization(repo.monetization)} | ` +
            `${formatMoneyScore(repo.moneyScore)} | ${escapeCell(repo.language ?? "-")} | ` +
            `${formatNumber(repo.stars)} | ${formatDate(repo.starredAt)} | ${escapeCell(desc)} |`,
        );
      }
      lines.push("");
    });
  }

  if (!repos.length) {
    lines.push("_暂无可展示的条目。_");
    lines.push("");
  }

  return { markdown: lines.join("\n"), counts };
}

export interface IndexAuthor {
  login: string;
  displayName: string | null;
  repoCount: number;
  /** Marks the reader's own account, which the index calls out explicitly. */
  isSelf?: boolean | undefined;
  /** Direct link to the author's document, when the writer could provide one. */
  nodeUrl?: string | undefined;
  /** Node token, shown when no link can be built. */
  nodeToken?: string | undefined;
  /** Populated when the last sync failed, so a broken author is visible. */
  error?: string | undefined;
}

export interface IndexContext {
  generatedAt: Date;
}

/**
 * Render the landing page that ties every tracked author together.
 *
 * It deliberately uses a table rather than a table of contents: Markdown
 * anchors inside table cells do not resolve in Feishu, so links point at the
 * author documents instead of jumping within this page.
 *
 * The run timestamp is written as `生成时间 ...` on purpose — `hashContent`
 * normalizes that exact wording, so a no-op run still produces a byte-identical
 * page and skips the write. Per-run stats such as "new stars this run" belong
 * in the notification card, not here, or they would rewrite the page daily.
 */
export function renderIndex(authors: IndexAuthor[], context: IndexContext): string {
  const failed = authors.filter((author) => author.error).length;
  const lines: string[] = [];
  lines.push("# GitHub Star 知识库");
  lines.push("");
  lines.push(
    `> 由 github-star-rag 自动生成 ｜ 收录 ${authors.length} 个账号` +
      (failed ? ` ｜ ${failed} 个账号同步失败` : ""),
  );
  lines.push(">");
  lines.push(
    `> 生成时间 ${context.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  );
  lines.push("");
  lines.push("## 跟踪的作者");
  lines.push("");
  lines.push("| 作者 | 已整理仓库数 | 状态 | 文档 |");
  lines.push("| --- | --- | --- | --- |");
  for (const author of authors) {
    lines.push(
      `| ${linkToProfile(author)} | ${author.repoCount} | ${statusOf(author)} | ${linkToDoc(author)} |`,
    );
  }
  lines.push("");
  if (!authors.length) {
    lines.push("_还没有配置任何作者。在 star-subscriptions.yaml 的 authors 下添加一个 login 即可。_");
    lines.push("");
  }
  return lines.join("\n");
}

function linkToProfile(author: IndexAuthor): string {
  const suffixes: string[] = [];
  if (author.displayName) suffixes.push(author.displayName);
  if (author.isSelf) suffixes.push("本人");
  const name = suffixes.length ? `${author.login}（${suffixes.join("、")}）` : author.login;
  return `[${escapeCell(name)}](https://github.com/${author.login})`;
}

function statusOf(author: IndexAuthor): string {
  if (!author.error) return "正常";
  return `失败：${escapeCell(author.error)}`;
}

function linkToDoc(author: IndexAuthor): string {
  if (author.nodeUrl) return `[打开文档](${author.nodeUrl})`;
  if (author.nodeToken) return `node_token: \`${author.nodeToken}\``;
  return "-";
}

export interface TrendingRow {
  fullName: string;
  url: string;
  /** Stars gained in the trending window; the ranking key of this document. */
  starsToday: number;
  stars: number;
  language: string | null;
  description: string | null;
  category: Category;
  summaryZh: string | null;
  monetization?: string | null;
  moneyScore?: number | null;
}

export interface TrendingContext {
  generatedAt: Date;
  /** Window the board covers, echoed in the header so the numbers are readable. */
  since?: "daily" | "weekly" | "monthly";
}

export interface TrendingResult {
  markdown: string;
  counts: Record<string, number>;
}

const SINCE_LABELS: Record<"daily" | "weekly" | "monthly", string> = {
  daily: "每日",
  weekly: "每周",
  monthly: "每月",
};

/**
 * Thousands separator with an explicit locale.
 *
 * The daily gain is the headline number of this document and rounding it to
 * "2.3k" would hide the ordering, so it is written out in full. The locale is
 * pinned because the output feeds a content hash: a machine-dependent
 * separator would rewrite the page on every run.
 */
function formatGain(value: number): string {
  return `+${value.toLocaleString("en-US")}`;
}

/**
 * Render GitHub's trending board as a money-oriented Chinese document.
 *
 * The columns answer "what is gaining attention today, and could it make
 * money" rather than restating GitHub's own page: the daily gain leads, and
 * each repository carries the same taxonomy fields as the star documents so
 * both ends of the knowledge base can be read the same way.
 */
export function renderTrending(rows: TrendingRow[], context: TrendingContext): TrendingResult {
  const counts: Record<string, number> = {};
  const since = context.since ?? "daily";
  const lines: string[] = [];

  lines.push("# GitHub 上涨趋势榜");
  lines.push("");
  lines.push(
    `> 数据来源：[GitHub Trending（${SINCE_LABELS[since]}）]` +
      `(${TRENDING_URL}?since=${since}) ｜ 按「今日新增 Star」排序的 TOP ${rows.length}`,
  );
  lines.push(">");
  lines.push(`> 生成时间 ${context.generatedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  lines.push("");

  if (!rows.length) {
    lines.push("_暂无数据：趋势榜抓取失败或 GitHub 页面结构变化，稍后会自动重试。_");
    lines.push("");
    return { markdown: lines.join("\n"), counts };
  }

  // Same reasoning as the star documents: the reader is looking for something
  // to build a business on, so the highest-potential entries lead instead of
  // being derivable only by scanning the table.
  const ranked = rows
    .filter((row) => (row.moneyScore ?? 0) >= TOP_MONEY_MIN_SCORE)
    .sort(
      (a, b) =>
        (b.moneyScore ?? 0) - (a.moneyScore ?? 0) || b.starsToday - a.starsToday,
    )
    .slice(0, TOP_MONEY_ROWS);

  if (ranked.length) {
    lines.push("## 变现机会榜");
    lines.push("");
    lines.push(
      `> 从今天的榜单里挑出变现潜力 ${TOP_MONEY_MIN_SCORE} 分以上的 ${ranked.length} 个，` +
        "按潜力排序；完整榜单见下方表格。",
    );
    lines.push("");
    lines.push("| 排名 | 仓库 | 今日新增 | 赛道 | 变现路径 | 潜力 | 一句话说明 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    ranked.forEach((row, index) => {
      const desc = row.summaryZh ?? row.description ?? "";
      lines.push(
        `| ${index + 1} | [${row.fullName}](${row.url}) | ${formatGain(row.starsToday)} | ` +
          `${row.category} | ${normalizeMonetization(row.monetization)} | ` +
          `${formatMoneyScore(row.moneyScore)} | ${escapeCell(desc)} |`,
      );
    });
    lines.push("");
  }

  lines.push("## 今日上涨 TOP " + rows.length);
  lines.push("");
  lines.push("| 排名 | 仓库 | 今日新增 | 赛道 | 变现路径 | 潜力 | 语言 | 总 Stars | 一句话说明 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  rows.forEach((row, index) => {
    const desc = row.summaryZh ?? row.description ?? "";
    counts[row.category] = (counts[row.category] ?? 0) + 1;
    lines.push(
      `| ${index + 1} | [${row.fullName}](${row.url}) | ${formatGain(row.starsToday)} | ` +
        `${row.category} | ${normalizeMonetization(row.monetization)} | ` +
        `${formatMoneyScore(row.moneyScore)} | ${escapeCell(row.language ?? "-")} | ` +
        `${formatNumber(row.stars)} | ${escapeCell(desc)} |`,
    );
  });
  lines.push("");

  const tracks = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (tracks.length) {
    lines.push("## 赛道分布");
    lines.push("");
    for (const [category, count] of tracks) {
      lines.push(`- ${category}（${count}）`);
    }
    lines.push("");
  }

  return { markdown: lines.join("\n"), counts };
}

export { FALLBACK_CATEGORY };
