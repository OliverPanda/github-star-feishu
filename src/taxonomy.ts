/**
 * Fixed, money-oriented taxonomy for classifying starred repositories.
 *
 * The axis is deliberately commercial rather than technical: instead of
 * "frontend / backend / devops", a repo is filed under the business it could
 * actually earn money in. A closed set keeps the generated wiki stable across
 * runs — an open-ended taxonomy drifts, so the same repo lands in a different
 * folder each sync and the wiki churns. Categories are ordered by monetization
 * strength so the rendered document leads with the most actionable sections.
 */
export const CATEGORIES = [
  "AI应用与变现",
  "AI模型与训练基建",
  "量化交易与金融",
  "电商与跨境出海",
  "内容创作与自媒体",
  "营销增长与SEO",
  "自动化与效率工具",
  "企业与SaaS软件",
  "数据产品与分析",
  "开发者工具与云服务",
  "学习资源与技能",
  "其他",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** Fallback used whenever the LLM returns something outside the taxonomy. */
export const FALLBACK_CATEGORY: Category = "其他";

/** Short descriptions injected into the prompt to disambiguate adjacent buckets. */
export const CATEGORY_HINTS: Record<Category, string> = {
  AI应用与变现:
    "能直接做成产品/服务卖的 AI：Agent、RAG、Chatbot、提示词工程、多模态应用、AI 套壳工具、AI 工作流",
  AI模型与训练基建:
    "作为技术底座的模型侧工程：训练与微调、推理引擎、向量库、GPU 调度、模型权重与评测",
  量化交易与金融:
    "直接产生现金流或管理资金的：量化策略、回测、行情与金融数据、交易所、支付清结算、记账理财、加密货币",
  电商与跨境出海: "独立站、跨境电商、订单履约、物流、支付网关、选品与铺货",
  内容创作与自媒体: "视频剪辑、字幕、TTS、AI 绘图、写作、播客、社媒发布自动化",
  营销增长与SEO: "SEO、广告投放、埋点分析、邮件营销、联盟分销、落地页与转化",
  自动化与效率工具: "爬虫、浏览器自动化、RPA、工作流编排、批处理，替人省时间就能收费",
  企业与SaaS软件: "CRM、ERP、低代码、后台管理、协同办公、客服系统",
  数据产品与分析: "BI、数据仓库、报表、可视化、数据管道与指标平台",
  开发者工具与云服务: "CI/CD、部署、监控、API 网关、数据库、云基础设施",
  学习资源与技能: "教程、书籍配套代码、课程、面试题库、awesome 清单、论文合集",
  其他: "确实无法归入以上任何一类",
};

/**
 * How a repo is expected to turn into revenue. Separate from the category
 * because the same vertical is monetized differently: a RAG framework is
 * usually API usage billing or SaaS, while a backtesting library is trading
 * income. Kept closed for the same anti-drift reason as the categories.
 */
export const MONETIZATION_PATHS = [
  "SaaS 订阅",
  "API 用量计费",
  "交易与投资",
  "内容与流量",
  "服务与咨询",
  "买断与授权",
  "平台佣金",
  "数据与情报",
  "教学与课程",
  "暂不明朗",
] as const;

export type MonetizationPath = (typeof MONETIZATION_PATHS)[number];

export const FALLBACK_MONETIZATION: MonetizationPath = "暂不明朗";

/** What each revenue path means, injected into the prompt for consistent labeling. */
export const MONETIZATION_HINTS: Record<MonetizationPath, string> = {
  "SaaS 订阅": "部署成在线服务按月/年收费",
  "API 用量计费": "按调用量或 token 收费",
  交易与投资: "直接用于交易、投资、资金管理获利",
  内容与流量: "靠内容获客、广告分成或带货变现",
  服务与咨询: "作为交付工具承接定制项目或咨询",
  买断与授权: "一次性售卖或商业授权",
  平台佣金: "撮合交易抽成或收平台费",
  数据与情报: "售卖数据、行情、榜单或研究报告",
  教学与课程: "靠课程、训练营、书籍变现",
  暂不明朗: "看不到清晰的直接变现路径",
};

/** Monetary promise, 1 (纯学习) to 5 (直接产生现金流). */
export const MONEY_SCORE_MIN = 1;
export const MONEY_SCORE_MAX = 5;

export function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/**
 * Bump whenever CATEGORIES, CATEGORY_HINTS or the prompt rules change.
 *
 * The taxonomy is not just a label set — it decides which folder a repo lands
 * in, so a changed taxonomy makes every cached classification stale. Storing
 * the version alongside each row lets a sync re-classify exactly the rows
 * written by an older taxonomy, instead of the operator hand-clearing the
 * `classified_at` column (and instead of silently keeping a stale folder).
 */
export const TAXONOMY_VERSION = 2;

export function isMonetizationPath(value: string): value is MonetizationPath {
  return (MONETIZATION_PATHS as readonly string[]).includes(value);
}

/** Fold case/space/separator noise so a near-miss label still matches. */
function fold(value: string): string {
  return value.toLowerCase().replace(/[\s_\-/]/g, "");
}

/** Map an arbitrary LLM label onto the taxonomy, tolerating case/spacing noise. */
export function normalizeCategory(value: string | undefined | null): Category {
  if (!value) return FALLBACK_CATEGORY;
  const cleaned = value.trim();
  if (isCategory(cleaned)) return cleaned;

  const folded = fold(cleaned);
  for (const category of CATEGORIES) {
    if (fold(category) === folded) return category;
  }
  return FALLBACK_CATEGORY;
}

export function normalizeMonetization(value: string | undefined | null): MonetizationPath {
  if (!value) return FALLBACK_MONETIZATION;
  const cleaned = value.trim();
  if (isMonetizationPath(cleaned)) return cleaned;

  const folded = fold(cleaned);
  for (const path of MONETIZATION_PATHS) {
    if (fold(path) === folded) return path;
  }
  return FALLBACK_MONETIZATION;
}

/**
 * Clamp a model-reported score into 1-5.
 *
 * Models occasionally answer with a 0-10 scale or a float despite the prompt,
 * and an out-of-range score would sort a junk repo above a real one; clamping
 * keeps the ranking meaningful without dropping the row.
 */
export function normalizeMoneyScore(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return MONEY_SCORE_MIN;
  const rounded = Math.round(numeric);
  return Math.min(MONEY_SCORE_MAX, Math.max(MONEY_SCORE_MIN, rounded));
}
