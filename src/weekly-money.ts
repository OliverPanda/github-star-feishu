import { z } from "zod";
import type { Db } from "./db/client.js";
import { COMMERCIAL_START_DATE, commercialRoster, projectUrl } from "./commercial-board.js";
import { COMMERCIAL_PROJECTS, type CommercialProject } from "./commercial-projects.js";
import { getSetting, setSetting } from "./store.js";

export const WEEKLY_MONEY_DOC_KEY = "__weekly_money_top10";
export const WEEKLY_MONEY_TITLE = "每周搞钱项目 Top 10";
export const WEEKLY_MONEY_CACHE_KEY = "weekly_money_cache";
export const WEEKLY_MONEY_PICK_COUNT = 10;

export const WEEKLY_MONEY_METHODOLOGY =
  "从统计周期内每天发布的项目中按仓库去重，再按需求强度 35%、变现清晰度 25%、交付速度 20%、持续收费能力 20% 打分；每个赛道先最多选 2 个，最后再按高分补齐，兼顾可落地性与方向分散。";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface WeeklyMoneyPeriod {
  /** Stable identity for one Monday-to-Sunday report. */
  key: string;
  start: string;
  end: string;
  label: string;
}

export interface WeeklyScoreBreakdown {
  /** How broad and urgent the paying demand is. */
  demand: number;
  /** How directly the project can be turned into an invoice. */
  monetization: number;
  /** How quickly a small team can deploy and demo it. */
  delivery: number;
  /** How naturally it turns into recurring revenue. */
  repeatability: number;
}

export interface WeeklyMoneyPick {
  rank: number;
  name: string;
  repo: string;
  url: string;
  category: string;
  source: "week" | "fallback";
  /** The daily batch the project came from; null for an evergreen fallback pick. */
  sourceDate: string | null;
  score: number;
  breakdown: WeeklyScoreBreakdown;
  reason: string;
  scenario: string;
  deploy: string;
  monetization: string;
  fit: string;
}

export interface WeeklyMoneyReport {
  generatedAt: string;
  period: WeeklyMoneyPeriod;
  candidateCount: number;
  fallbackCount: number;
  methodology: string;
  picks: WeeklyMoneyPick[];
}

export interface WeeklyMoneySnapshot {
  report: WeeklyMoneyReport;
  /** Null until the weekly card has actually reached a notification channel. */
  pushedAt: string | null;
}

const PeriodSchema = z.object({
  key: z.string(),
  start: z.string(),
  end: z.string(),
  label: z.string(),
});

const BreakdownSchema = z.object({
  demand: z.number(),
  monetization: z.number(),
  delivery: z.number(),
  repeatability: z.number(),
});

const PickSchema = z.object({
  rank: z.number(),
  name: z.string(),
  repo: z.string(),
  url: z.string(),
  category: z.string(),
  source: z.enum(["week", "fallback"]),
  sourceDate: z.string().nullable(),
  score: z.number(),
  breakdown: BreakdownSchema,
  reason: z.string(),
  scenario: z.string(),
  deploy: z.string(),
  monetization: z.string(),
  fit: z.string(),
});

const ReportSchema = z.object({
  generatedAt: z.string(),
  period: PeriodSchema,
  candidateCount: z.number(),
  fallbackCount: z.number(),
  methodology: z.string(),
  picks: z.array(PickSchema).max(WEEKLY_MONEY_PICK_COUNT),
});

const SnapshotSchema = z.object({
  report: ReportSchema,
  pushedAt: z.string().nullable(),
});

interface ScoredProject {
  project: CommercialProject;
  source: "week" | "fallback";
  sourceDate: string | null;
  score: number;
  breakdown: WeeklyScoreBreakdown;
}

function dateKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function nextDate(date: string): string {
  return dateKey(Date.parse(`${date}T00:00:00Z`) + DAY_MS);
}

/**
 * The report always covers the latest complete Monday-Sunday week.
 *
 * A Monday run therefore publishes last week's finished report instead of a
 * partial report containing only Monday. If the scheduler was down on Monday,
 * the next successful run in the same week still publishes the same period.
 */
export function weeklyReportPeriod(now: Date = new Date()): WeeklyMoneyPeriod {
  const beijing = new Date(now.getTime() + CHINA_OFFSET_MS);
  const mondayOffset = (beijing.getUTCDay() + 6) % 7;
  const currentMonday = Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate() - mondayOffset,
  );
  const reportMonday = currentMonday - 7 * DAY_MS;
  const reportSunday = currentMonday - DAY_MS;
  const start = dateKey(reportMonday);
  const end = dateKey(reportSunday);
  return {
    key: `${start}_${end}`,
    start,
    end,
    label: `${start} 至 ${end}`,
  };
}

function demandScore(category: string): number {
  if (/AI|Agent|知识库|客服/.test(category)) return 95;
  if (/电商|跨境|订单|支付/.test(category)) return 94;
  if (/营销|增长|SEO|邮件|预约/.test(category)) return 93;
  if (/CRM|销售|工单|客户/.test(category)) return 92;
  if (/自动化|无代码|内部工具|后台|协作/.test(category)) return 90;
  if (/数据|BI|分析|报表/.test(category)) return 89;
  if (/建站|内容|文档|媒体/.test(category)) return 87;
  if (/部署|监控|存储|备份|网关|容器/.test(category)) return 84;
  return 82;
}

function monetizationScore(monetization: string): number {
  if (/订阅|月费|月维护|按月|年|年费|年服务|按量|席位|分成|抽成|佣金/.test(monetization)) {
    return 95;
  }
  if (/实施|部署|项目|二开|定制|迁移|托管/.test(monetization)) return 86;
  if (/咨询|培训|课程|顾问/.test(monetization)) return 80;
  return 72;
}

function deliveryScore(deploy: string): number {
  if (/一键|单容器|单机|单二进制|脚本/.test(deploy)) return 95;
  if (/Docker Compose|Docker|AIO/.test(deploy)) return 88;
  if (/Node|PHP|Python|Laravel|Java|Elixir|pip|npm/.test(deploy)) return 78;
  if (/K8s|Kubernetes|集群/.test(deploy)) return 68;
  return 74;
}

function repeatabilityScore(monetization: string): number {
  if (/订阅|月费|月维护|按量|席位|年费|年服务|托管/.test(monetization)) return 95;
  if (/项目|实施|二开|定制|迁移/.test(monetization)) return 86;
  if (/培训|咨询|课程/.test(monetization)) return 76;
  return 80;
}

function scored(
  project: CommercialProject,
  source: "week" | "fallback",
  sourceDate: string | null,
): ScoredProject {
  const breakdown = {
    demand: demandScore(project.category),
    monetization: monetizationScore(project.monetization),
    delivery: deliveryScore(project.deploy),
    repeatability: repeatabilityScore(project.monetization),
  };
  const score = Math.round(
    breakdown.demand * 0.35 +
      breakdown.monetization * 0.25 +
      breakdown.delivery * 0.2 +
      breakdown.repeatability * 0.2,
  );
  return { project, source, sourceDate, score, breakdown };
}

/** Every unique project published in the completed week, in date order. */
export function weeklyMoneyCandidates(period: WeeklyMoneyPeriod): ScoredProject[] {
  const seen = new Set<string>();
  const candidates: ScoredProject[] = [];
  for (let date = period.start; date <= period.end; date = nextDate(date)) {
    // Dates before the first curated batch do not have a real roster. Calling
    // commercialRoster there would clamp to batch one and falsely mark those
    // projects as published during this week.
    if (date < COMMERCIAL_START_DATE) continue;
    for (const project of commercialRoster(date)) {
      if (seen.has(project.repo)) continue;
      seen.add(project.repo);
      candidates.push(scored(project, "week", date));
    }
  }
  return candidates;
}

function byScore(a: ScoredProject, b: ScoredProject): number {
  return (
    b.score - a.score ||
    b.breakdown.monetization - a.breakdown.monetization ||
    b.breakdown.delivery - a.breakdown.delivery ||
    a.project.name.localeCompare(b.project.name, "zh-CN")
  );
}

function categoryFamily(category: string): string {
  if (/AI|Agent|知识库|RAG|模型|推理|向量|提示词/.test(category)) return "AI";
  if (/电商|跨境|订单|支付|商城/.test(category)) return "电商";
  if (/营销|增长|SEO|邮件|预约|调研|票务/.test(category)) return "增长";
  if (/CRM|客服|销售|工单|客户|售后/.test(category)) return "客户经营";
  if (/自动化|无代码|内部工具|后台|表格|协作|工作流/.test(category)) return "效率工具";
  if (/数据|BI|分析|报表|仓库|埋点|可观测/.test(category)) return "数据";
  if (/建站|内容|文档|媒体|知识库|Wiki/.test(category)) return "内容";
  if (/部署|监控|存储|备份|网关|容器|数据库|服务器|组网/.test(category)) return "基础设施";
  return category;
}

/**
 * Pick a varied Top 10: at most two projects per business category in the
 * first pass, then fill any remaining slots by score if the pool is narrow.
 */
function diversify(candidates: ScoredProject[]): ScoredProject[] {
  const sorted = [...candidates].sort(byScore);
  const counts = new Map<string, number>();
  const selected: ScoredProject[] = [];
  const leftovers: ScoredProject[] = [];

  for (const candidate of sorted) {
    const family = categoryFamily(candidate.project.category);
    const count = counts.get(family) ?? 0;
    if (count < 2) {
      selected.push(candidate);
      counts.set(family, count + 1);
    } else {
      leftovers.push(candidate);
    }
  }

  for (const candidate of leftovers) {
    if (selected.length >= WEEKLY_MONEY_PICK_COUNT) break;
    selected.push(candidate);
  }

  return selected
    .sort(byScore)
    .slice(0, WEEKLY_MONEY_PICK_COUNT);
}

function pickReason(candidate: ScoredProject): string {
  const { project, source, sourceDate } = candidate;
  const lead =
    source === "fallback"
      ? "作为常备项目补位，它仍具备完整业务闭环"
      : `${sourceDate} 这一批里，它的客户和收费链条最清楚`;
  return `${lead}：${project.scenario}。面向${project.fit}，用${project.deploy}即可交付，收入来自${project.monetization}；需求、变现、交付和持续收费四项评分都适合小团队优先验证。`;
}

/**
 * Build the latest weekly editorial report.
 *
 * Projects are taken from that week's daily money batches. If a first rollout
 * does not yet have ten historical daily batches, curated evergreen projects
 * fill the remaining slots and are explicitly marked as fallback picks.
 */
export function buildWeeklyMoneyReport(now: Date = new Date()): WeeklyMoneyReport {
  const period = weeklyReportPeriod(now);
  const weekCandidates = weeklyMoneyCandidates(period);
  const selectedWeek = diversify(weekCandidates);
  const selectedRepos = new Set(selectedWeek.map((candidate) => candidate.project.repo));
  const known = new Set(weekCandidates.map((candidate) => candidate.project.repo));
  const fallbackCandidates = COMMERCIAL_PROJECTS.filter((project) => !known.has(project.repo)).map(
    (project) => scored(project, "fallback", null),
  );
  const fillers =
    selectedWeek.length < WEEKLY_MONEY_PICK_COUNT
      ? fallbackCandidates
          .filter((candidate) => !selectedRepos.has(candidate.project.repo))
          .sort(byScore)
          .slice(0, WEEKLY_MONEY_PICK_COUNT - selectedWeek.length)
      : [];
  const picks = [...selectedWeek, ...fillers]
    .sort(byScore)
    .slice(0, WEEKLY_MONEY_PICK_COUNT)
    .map((candidate, index) => ({
      rank: index + 1,
      name: candidate.project.name,
      repo: candidate.project.repo,
      url: projectUrl(candidate.project),
      category: candidate.project.category,
      source: candidate.source,
      sourceDate: candidate.sourceDate,
      score: candidate.score,
      breakdown: candidate.breakdown,
      reason: pickReason(candidate),
      scenario: candidate.project.scenario,
      deploy: candidate.project.deploy,
      monetization: candidate.project.monetization,
      fit: candidate.project.fit,
    }));

  return {
    generatedAt: now.toISOString(),
    period,
    candidateCount: weekCandidates.length,
    fallbackCount: picks.filter((pick) => pick.source === "fallback").length,
    methodology: WEEKLY_MONEY_METHODOLOGY,
    picks,
  };
}

/** Markdown page written into the knowledge base. */
export function renderWeeklyMoneyBoard(report: WeeklyMoneyReport): string {
  const intro =
    `> 统计周期：${report.period.label}。本周共汇总 ${report.candidateCount} 个不重复项目` +
    (report.fallbackCount ? `，其中 ${report.fallbackCount} 个为常备池补位。` : "。") +
    "\n>\n> 精选方法：" +
    report.methodology +
    "\n>\n> 评分考察的是「本周优先验证价值」，不代表收益承诺；上线前仍需核对许可证、第三方条款、数据合规和实际成本。";

  const sections = report.picks.map((pick) =>
    [
      `### ${pick.rank}. ${pick.name}`,
      `- 精选理由：${pick.reason}`,
      `- 入选指数：${pick.score}/100（需求 ${pick.breakdown.demand} · 变现 ${pick.breakdown.monetization} · 交付 ${pick.breakdown.delivery} · 持续收费 ${pick.breakdown.repeatability}）`,
      `- 本周来源：${pick.sourceDate ? `${pick.sourceDate} 的每日精选批次` : "常备项目池补位"}`,
      `- 业务类型：${pick.category}`,
      `- 直接落地场景：${pick.scenario}`,
      `- 起步方式：${pick.deploy}`,
      `- 搞钱路径：${pick.monetization}`,
      `- 适合谁：${pick.fit}`,
      `- 项目地址：[${pick.repo}](${pick.url})`,
    ].join("\n"),
  );

  return [`# ${WEEKLY_MONEY_TITLE}`, "", intro, "", sections.join("\n\n")].join("\n");
}

/** Short text for scheduler diagnostics; the detailed card renders the picks. */
export function summarizeWeeklyMoneyReport(report: WeeklyMoneyReport): string {
  return `${WEEKLY_MONEY_TITLE}已更新：${report.period.label}，共精选 ${report.picks.length} 个项目。`;
}

export function saveWeeklyMoneySnapshot(db: Db, snapshot: WeeklyMoneySnapshot): void {
  setSetting(db, WEEKLY_MONEY_CACHE_KEY, JSON.stringify(snapshot));
}

export function readWeeklyMoneySnapshot(db: Db): WeeklyMoneySnapshot | null {
  const raw = getSetting(db, WEEKLY_MONEY_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = SnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Record a completed push.
 *
 * A failed notification leaves `pushedAt` null, so the next scheduled run
 * retries the weekly card without regenerating the report or duplicating the
 * knowledge-base page.
 */
export function markWeeklyMoneyPushed(db: Db, periodKey: string, at: Date = new Date()): void {
  const snapshot = readWeeklyMoneySnapshot(db);
  if (!snapshot || snapshot.report.period.key !== periodKey) return;
  saveWeeklyMoneySnapshot(db, { ...snapshot, pushedAt: at.toISOString() });
}
