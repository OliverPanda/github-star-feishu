import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import {
  CATEGORIES,
  CATEGORY_HINTS,
  MONETIZATION_HINTS,
  MONETIZATION_PATHS,
  normalizeCategory,
  normalizeMonetization,
  normalizeMoneyScore,
  type Category,
  type MonetizationPath,
} from "../taxonomy.js";

export interface ClassifiableRepo {
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
}

export interface Classification {
  category: Category;
  summaryZh: string;
  /** How this repo is expected to earn money. */
  monetization: MonetizationPath;
  /** 1-5 monetary promise, used to rank a category by "can this make money". */
  moneyScore: number;
}

const ClassificationItemSchema = z.object({
  full_name: z.string(),
  category: z.string(),
  summary: z.string(),
  monetization: z.string().optional(),
  money_score: z.union([z.number(), z.string()]).optional(),
});

const SYSTEM_PROMPT = `你是资深技术选型与商业化顾问，负责判断 GitHub 仓库「能靠什么赚钱」，并写出精准的中文一句话摘要。

分类必须严格从以下列表中选择，不要自创类目：
${CATEGORIES.map((c) => `- ${c}：${CATEGORY_HINTS[c]}`).join("\n")}

变现路径必须严格从以下列表中选择，不要自创：
${MONETIZATION_PATHS.map((m) => `- ${m}：${MONETIZATION_HINTS[m]}`).join("\n")}

归类原则：
- 分类按「谁会用这个赚钱」判断，而不是按技术栈。同一个库可以从商业用途角度归到最能变现的那一类
- 「其他」是最后手段。只有确实无法归入任何一类时才用它，正常占比应低于 10%，不要因为仓库冷门、star 少或描述为空就丢进「其他」
- 机器学习、深度学习、计算机视觉、统计学习的库：能直接做成产品/服务（Agent、RAG、Chatbot、多模态应用）归「AI应用与变现」；偏训练、推理引擎、向量库、GPU 调度等底座归「AI模型与训练基建」
- 量化策略、回测、行情、交易所、支付、记账理财、加密货币归「量化交易与金融」
- 数据分析、BI、报表、可视化、数据管道归「数据产品与分析」
- 教程、书籍配套代码、课程、面试题、awesome 清单归入「学习资源与技能」
- CI/CD、部署、监控、数据库、API 网关等基础设施归「开发者工具与云服务」
- 描述为空的仓库，根据仓库名、主语言和 topics 推断，不要直接判为「其他」

money_score 判断标准（1-5 整数，衡量这个仓库本身对赚钱的杀伤力）：
- 5：直接产生现金流（交易系统、支付、能立刻上线的变现工具）
- 4：明确可商业化，稍加包装就能收费（成熟 SaaS 底座、Agent 框架）
- 3：是赚钱项目的重要组件，需配合其他东西使用
- 2：主要提升效率，间接省钱
- 1：纯学习、纯玩具、纯文档

输出要求：
1. 只输出 JSON 数组，不要任何解释、不要 Markdown 代码块
2. 每个元素格式：{"full_name": "...", "category": "...", "monetization": "...", "money_score": 4, "summary": "..."}
3. full_name 必须与输入完全一致，不得改写、翻译或省略
4. summary 为中文，一句话，不超过 40 字，说明这个库解决什么问题、能怎么变现
5. 每个输入仓库都必须有对应输出，顺序与输入保持一致
6. 实在无法判断时 category 才用「其他」`;

function buildUserPrompt(repos: ClassifiableRepo[]): string {
  const lines = repos.map((repo) => {
    const parts = [`${repo.fullName}`];
    if (repo.language) parts.push(`[${repo.language}]`);
    if (repo.description) parts.push(repo.description.slice(0, 200));
    if (repo.topics.length) parts.push(`topics: ${repo.topics.slice(0, 6).join(", ")}`);
    return parts.join(" | ");
  });
  return `请对以下 ${repos.length} 个仓库进行分类：\n\n${lines.join("\n")}`;
}

/**
 * Models wrap JSON in prose or code fences often enough that a plain
 * JSON.parse is not dependable, so pull out the outermost array/object before
 * validating. Validation then happens with zod, and anything that still fails
 * is dropped rather than aborting the whole batch.
 */
export function extractClassifications(text: string): z.infer<typeof ClassificationItemSchema>[] {
  let candidate = text.trim();

  const fence = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) candidate = fence[1].trim();

  const arrayStart = candidate.indexOf("[");
  const objectStart = candidate.indexOf("{");
  const starts = [arrayStart, objectStart].filter((i) => i >= 0);
  if (!starts.length) return [];

  const start = Math.min(...starts);
  const end = Math.max(candidate.lastIndexOf("]"), candidate.lastIndexOf("}"));
  if (end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }

  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as Record<string, unknown>).items ??
       (parsed as Record<string, unknown>).results ??
       (parsed as Record<string, unknown>).data);
  if (!Array.isArray(list)) return [];

  const valid: z.infer<typeof ClassificationItemSchema>[] = [];
  for (const entry of list) {
    const result = ClassificationItemSchema.safeParse(entry);
    if (result.success) valid.push(result.data);
  }
  return valid;
}

export interface ClassifyOptions {
  model: LanguageModel;
  /** Repos per request. Larger is cheaper but raises the odds of a malformed reply. */
  batchSize?: number;
  /** Concurrent requests. Kept low because providers throttle aggressively. */
  concurrency?: number;
  onProgress?: (info: { done: number; total: number }) => void;
  /** Retries per batch before falling back to the default category. */
  retries?: number;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function classifyBatch(
  model: LanguageModel,
  repos: ClassifiableRepo[],
  retries: number,
): Promise<Map<string, Classification>> {
  const results = new Map<string, Classification>();
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await generateText({
        model,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(repos),
      });

      const parsed = extractClassifications(response.text);
      if (!parsed.length) throw new Error("model returned no parseable classifications");

      const byName = new Map(repos.map((r) => [r.fullName, r]));
      for (const item of parsed) {
        // Guard against a model inventing repos that were not in the batch.
        if (!byName.has(item.full_name)) continue;
        results.set(item.full_name, {
          category: normalizeCategory(item.category),
          summaryZh: item.summary.trim().slice(0, 80),
          monetization: normalizeMonetization(item.monetization),
          moneyScore: normalizeMoneyScore(item.money_score),
        });
      }

      // A partial reply is still useful; only a completely empty one retries.
      if (results.size > 0) return results;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(`  ! classification batch failed, falling back: ${message}`);
  }
  return results;
}

/**
 * Classify repositories, returning a map keyed by `full_name`.
 *
 * Repos the model failed to classify are simply absent from the map so the
 * caller can decide the fallback; this keeps a single flaky batch from
 * destroying an otherwise good run.
 */
export async function classifyRepos(
  repos: ClassifiableRepo[],
  options: ClassifyOptions,
): Promise<Map<string, Classification>> {
  const { model, batchSize = 25, concurrency = 2, onProgress, retries = 1 } = options;
  const merged = new Map<string, Classification>();
  const batches = chunk(repos, batchSize);

  let done = 0;
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, batches.length)) }, async () => {
    while (cursor < batches.length) {
      const index = cursor++;
      const batch = batches[index];
      if (!batch) continue;
      const result = await classifyBatch(model, batch, retries);
      for (const [key, value] of result) merged.set(key, value);
      done += batch.length;
      onProgress?.({ done: Math.min(done, repos.length), total: repos.length });
    }
  });

  await Promise.all(workers);
  return merged;
}
