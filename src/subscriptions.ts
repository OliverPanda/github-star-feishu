import { readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * One tracked account. `login` is the only required field because the whole
 * premise is "hand me a GitHub author and I will整理 their stars" — everything
 * else is an override for the rare case where the defaults do not fit.
 */
const SubscriptionSchema = z.object({
  login: z
    .string()
    .trim()
    .min(1, "login 不能为空")
    .regex(
      /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
      "不是合法的 GitHub 用户名",
    ),
  /** Shown instead of the login in the knowledge base index. */
  alias: z.string().trim().min(1).optional(),
  /** Marks the account as the reader's own, which changes the document title. */
  self: z.boolean().default(false),
  /** Allows temporarily parking an account without deleting its config block. */
  enabled: z.boolean().default(true),
});

/**
 * A Feishu id, accepting both the quoted string and the bare number.
 *
 * `space_id` and `parent_node` tokens from the console are long digit strings.
 * Written unquoted they parse as YAML numbers, and 19 digits exceed the safe
 * integer range, so the value silently rounds and then fails validation with a
 * message that blames the type rather than the quoting. Coercing a number back
 * to digits keeps the hand-written file working either way.
 */
const IdString = z
  .union([z.string(), z.number(), z.bigint()])
  .transform((value) => String(value).trim())
  .refine((value) => value.length > 0, "不能为空");

const FileSchema = z.object({
  /** Name of the knowledge base to write into. */
  space: z.string().trim().min(1).default("GitHub Star 精选"),
  /** Skips the name lookup and writes straight into a known space. */
  space_id: IdString.optional(),
  /** Parent node token, so every author subtree lands under one section. */
  parent_node: IdString.optional(),
  /** Webhook that receives the run summary; omitted means "do not notify". */
  webhook: z.string().trim().url("webhook 必须是完整 URL").optional(),
  /**
   * Whether to publish the GitHub trending board as its own document.
   *
   * On by default: the board is the only page in the knowledge base that is
   * useful before the reader has subscribed to anyone.
   */
  trending: z.boolean().default(true),
  authors: z
    .array(SubscriptionSchema)
    .min(1, "至少需要订阅一个作者")
    .describe("要跟踪的作者列表"),
});

export interface Subscription {
  login: string;
  alias: string | undefined;
  self: boolean;
  enabled: boolean;
}

export interface Subscriptions {
  space: string;
  spaceId: string | undefined;
  parentNode: string | undefined;
  webhook: string | undefined;
  trending: boolean;
  authors: Subscription[];
}

export class SubscriptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubscriptionConfigError";
  }
}

export const DEFAULT_SUBSCRIPTIONS_FILE = "star-subscriptions.yaml";

/**
 * Parse and validate a subscription file.
 *
 * Duplicate logins are a config bug that would otherwise cause the same author
 * to be synced twice and race on the same wiki node, so they are rejected
 * rather than silently deduplicated.
 */
export function parseSubscriptions(raw: string): Subscriptions {
  let document: unknown;
  try {
    // `intAsBigInt` keeps a 19-digit Feishu id intact; as a plain number it
    // would exceed Number.MAX_SAFE_INTEGER and come back visibly altered.
    document = parseYaml(raw, { intAsBigInt: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SubscriptionConfigError(`订阅文件不是合法 YAML：${detail}`);
  }

  const result = FileSchema.safeParse(document ?? {});
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => {
        const where = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `  - ${where}${issue.message}`;
      })
      .join("\n");
    throw new SubscriptionConfigError(`订阅文件校验失败：\n${issues}`);
  }

  const seen = new Map<string, number>();
  result.data.authors.forEach((author, index) => {
    const key = author.login.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined) {
      throw new SubscriptionConfigError(
        `作者 ${author.login} 重复出现（第 ${first + 1} 个与第 ${index + 1} 个）`,
      );
    }
    seen.set(key, index);
  });

  return {
    space: result.data.space,
    spaceId: result.data.space_id,
    parentNode: result.data.parent_node,
    webhook: result.data.webhook,
    trending: result.data.trending,
    authors: result.data.authors.map((author) => ({
      login: author.login,
      alias: author.alias,
      self: author.self,
      enabled: author.enabled,
    })),
  };
}

export function loadSubscriptions(filePath: string, cwd = process.cwd()): Subscriptions {
  // CI has no checkout of the subscription file (it holds the webhook), so the
  // whole YAML document can be supplied through the environment instead.
  const inline = process.env.STAR_SUBSCRIPTIONS?.trim();
  if (inline) return parseSubscriptions(unescapeInlineYaml(inline));

  const fromEnv = process.env.STAR_SUBSCRIPTIONS_FILE?.trim();
  if (fromEnv) filePath = fromEnv;

  const resolved = path.resolve(cwd, filePath);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    throw new SubscriptionConfigError(
      `找不到订阅文件 ${resolved}。可复制 ${DEFAULT_SUBSCRIPTIONS_FILE}.example 开始。`,
    );
  }
  return parseSubscriptions(raw);
}

/**
 * Secret stores such as GitHub Actions only accept a single-line value, so the
 * YAML pasted there arrives with escaped newlines. Collapse them back, but only
 * when the value really is one line — otherwise a literal `\n` inside a quoted
 * YAML scalar would be silently rewritten.
 */
function unescapeInlineYaml(raw: string): string {
  if (raw.includes("\n") || !raw.includes("\\n")) return raw;
  return raw.replace(/\\r\\n|\\n/g, "\n");
}

/** Authors that are not disabled, in config order. */
export function activeAuthors(subscriptions: Subscriptions): Subscription[] {
  return subscriptions.authors.filter((author) => author.enabled);
}

/** Display name used in the wiki index. */
export function displayLogin(subscription: Subscription): string {
  return subscription.alias ?? subscription.login;
}
