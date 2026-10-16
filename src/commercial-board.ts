import type { LanguageModel } from "ai";
import seedrandom from "seedrandom";
import { COMMERCIAL_PROJECTS, type CommercialProject } from "./commercial-projects.js";

export const COMMERCIAL_DOC_KEY = "__commercial_top20";
export const COMMERCIAL_TITLE = "搞钱项目精选 Top 20";

/** 第一批发布的日期；页面从这天开始按批留档。 */
export const COMMERCIAL_START_DATE = "2026-10-16";

/** 每批项目数，也是页面和推送卡片里的粒度。 */
export const COMMERCIAL_PER_DAY = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 北京时间偏移。
 *
 * 日报在北京时间早上推送，若按 UTC 换日，早上八点前跑的那一轮会被算成前一天，
 * 于是同一批项目连着发两天。统一按北京时间判断，同一天重跑一定得到同一批。
 */
const CHINA_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 一天发布的一批项目。 */
export interface CommercialBatch {
  /** 发布日期（北京时间），同时用作页面上的小标题。 */
  date: string;
  /** 第几批，从 1 开始。 */
  batch: number;
  projects: CommercialProject[];
}

/** 一轮要发多少天；项目池按整批划分。 */
export function commercialDaysPerCycle(): number {
  return Math.floor(COMMERCIAL_PROJECTS.length / COMMERCIAL_PER_DAY);
}

/** 北京时间日期（YYYY-MM-DD）。 */
export function commercialDate(now: Date = new Date()): string {
  return new Date(now.getTime() + CHINA_OFFSET_MS).toISOString().slice(0, 10);
}

/** 距离第一批的天数：首批当天为 0，之后每天加一；早于首批按 0 处理。 */
export function commercialDayIndex(date: string = commercialDate()): number {
  const start = Date.parse(`${COMMERCIAL_START_DATE}T00:00:00Z`);
  const target = Date.parse(`${date}T00:00:00Z`);
  return Math.max(0, Math.round((target - start) / DAY_MS));
}

/** 第 day 天对应的日期，用来给历史批次写标题。 */
function dateOfDay(day: number): string {
  const start = Date.parse(`${COMMERCIAL_START_DATE}T00:00:00Z`);
  return new Date(start + day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * 第 cycle 轮里项目的排列顺序。
 *
 * 第 0 轮按整理时的顺序首发，之后每一轮用固定种子重新洗牌：轮内 20 个一批互不
 * 重叠，跨轮也不会照抄上一轮的顺序。种子只取决于轮次，所以同一天重跑永远得到
 * 同一批项目——缓存丢了、工作流被手动触发，都不会把推过的项目当成新的再推一次。
 */
function cycleOrder(cycle: number): CommercialProject[] {
  const order = [...COMMERCIAL_PROJECTS];
  if (cycle <= 0) return order;

  const random = seedrandom(`commercial-cycle-${cycle}`);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const swap = order[i]!;
    order[i] = order[j]!;
    order[j] = swap;
  }
  return order;
}

function rosterForDay(day: number): CommercialProject[] {
  const perCycle = commercialDaysPerCycle();
  const order = cycleOrder(Math.floor(day / perCycle));
  const slot = day % perCycle;
  return order.slice(slot * COMMERCIAL_PER_DAY, (slot + 1) * COMMERCIAL_PER_DAY);
}

/** 某一天（默认今天）发布的那 20 个项目。 */
export function commercialRoster(date: string | Date = new Date()): CommercialProject[] {
  return rosterForDay(commercialDayIndex(typeof date === "string" ? date : commercialDate(date)));
}

/**
 * 从第一批到今天，每一天的批次，最新的一天排在最前面。
 *
 * 页面靠它把历史攒起来：同一天重跑得到完全一样的文档，内容哈希没变时写入会被
 * 跳过，第二天再跑才多出一节。
 */
export function commercialHistory(now: Date = new Date()): CommercialBatch[] {
  const batches: CommercialBatch[] = [];
  for (let day = commercialDayIndex(commercialDate(now)); day >= 0; day -= 1) {
    batches.push({ date: dateOfDay(day), batch: day + 1, projects: rosterForDay(day) });
  }
  return batches;
}

/**
 * The board page: every batch published so far, newest first.
 *
 * History lives in the render instead of the database because the roster is a
 * pure function of the date. A rebuild after a lost cache reproduces the page
 * rather than publishing a second copy of Monday's projects.
 */
export function renderCommercialBoard(now: Date = new Date(), _model?: LanguageModel): string {
  const history = commercialHistory(now);
  const latest = history[0]!;
  const directions = new Set(COMMERCIAL_PROJECTS.map((project) => project.category)).size;
  const sections = history.map((entry) =>
    [
      `## ${entry.date}（第 ${entry.batch} 批 · ${entry.projects.length} 个）`,
      "",
      entry.projects.map((project, index) => renderProject(project, index + 1)).join("\n\n"),
    ].join("\n"),
  );

  return [
    `# ${COMMERCIAL_TITLE}`,
    "",
    `> 项目池 ${COMMERCIAL_PROJECTS.length} 个，覆盖 ${directions} 个细分业务方向；每天发布 20 个新项目，` +
      `${commercialDaysPerCycle()} 天一轮，同一轮内不重复，轮与轮之间重新洗牌。每批按日期留档，历史全部保留。` +
      "上线前请核对项目许可证、第三方服务条款、数据合规和实际成本。",
    "",
    `> 最新一批：${latest.date}（第 ${latest.batch} 批）`,
    "",
    sections.join("\n\n"),
  ].join("\n");
}

function renderProject(project: CommercialProject, index: number): string {
  return [
    `### ${index}. ${project.name}`,
    `- 项目地址：[${project.repo}](https://github.com/${project.repo})`,
    `- 业务类型：${project.category}`,
    `- 直接落地场景：${project.scenario}`,
    `- 部署方式：${project.deploy}`,
    `- 搞钱路径：${project.monetization}`,
    `- 适合谁：${project.fit}`,
  ].join("\n");
}

/**
 * Short digest of today's batch for the daily Feishu push.
 *
 * One line per project so the card stays scannable on a phone; the scenario and
 * the money path are what make an entry actionable, so those are the two fields
 * that survive the compression.
 */
export function summarizeCommercialBoard(now: Date = new Date()): string {
  const date = commercialDate(now);
  const day = commercialDayIndex(date);
  const projects = rosterForDay(day);

  return [
    `**搞钱项目精选 Top 20**（${date} · 第 ${day + 1} 批）`,
    "今天这 20 个都能直接部署上线，同一轮内不重复，每批都按日期留在知识库里。",
    ...projects.map(
      (project, index) =>
        `${index + 1}. **${project.name}**（${project.category}）：${project.scenario} → ${project.monetization}`,
    ),
  ].join("\n");
}
