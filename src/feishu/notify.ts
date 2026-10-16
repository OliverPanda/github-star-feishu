import type { BatchResult } from "../batch.js";

export interface NotifyOptions {
  /** Group bot webhook; when absent the caller simply skips notifying. */
  webhook?: string | undefined;
  /**
   * Prefix that turns a wiki node token into a clickable link, such as
   * `https://example.feishu.cn/wiki/`. Wiki节点只能拿到 token，链接前缀只能来自
   * 配置；没有配置时卡片就只写文档标题。
   */
  wikiBaseUrl?: string | undefined;
  /** Injected in tests to avoid real network calls. */
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/**
 * Push the run summary to a Feishu group bot.
 *
 * The custom-bot webhook takes a plain card payload and needs no app
 * credentials, which is why it is used instead of the messaging API: the
 * recipient only has to be a member of the group.
 */
export async function notifyBatchResult(
  result: BatchResult,
  options: NotifyOptions,
): Promise<boolean> {
  return sendPayload(buildSummaryCard(result, options), options);
}

export async function notifyText(message: string, options: NotifyOptions): Promise<boolean> {
  return sendPayload({ msg_type: "text", content: { text: message } }, options);
}

async function sendPayload(payload: Record<string, unknown>, options: NotifyOptions): Promise<boolean> {
  const { webhook, fetchImpl = fetch, log = () => {} } = options;
  if (!webhook) {
    log("      未配置 webhook，跳过通知");
    return false;
  }

  const response = await fetchImpl(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`飞书通知发送失败：HTTP ${response.status}`);
  }

  // Feishu answers 200 with `{"code":0}` even when the card was rejected, so
  // the body has to be inspected rather than trusting the status alone.
  const body = (await response.json().catch(() => null)) as { code?: number; msg?: string } | null;
  if (body && typeof body.code === "number" && body.code !== 0) {
    throw new Error(`飞书通知发送失败：${body.code} ${body.msg ?? ""}`.trim());
  }

  log("      已推送飞书通知");
  return true;
}

/**
 * A card with one line per author. Failures are listed first because a broken
 * account is the only part of the summary that needs a human to act.
 */
export function buildSummaryCard(
  result: BatchResult,
  options: Pick<NotifyOptions, "wikiBaseUrl"> = {},
): Record<string, unknown> {
  const failed = result.outcomes.filter((outcome) => outcome.error);
  const ok = result.outcomes.filter((outcome) => !outcome.error);
  const lines: string[] = [];

  lines.push(`**知识库**：${result.spaceId}`);
  lines.push(`**账号**：${result.outcomes.length} 个（成功 ${ok.length}，失败 ${failed.length}）`);
  lines.push(`**本次新增**：${result.newStars} 个 star`);
  lines.push("");

  for (const outcome of failed) {
    lines.push(`🔴 **${outcome.login}** 同步失败：${outcome.error}`);
  }
  for (const outcome of ok) {
    const suffix = outcome.unchanged ? "（内容未变化）" : "";
    lines.push(
      `🟢 **${outcome.login}** 累计 ${outcome.totalStars} 个仓库，新增 ${outcome.newStars}${suffix}`,
    );
  }

  if (!result.outcomes.length) lines.push("_还没有配置任何作者。_");

  const elements: Record<string, unknown>[] = [
    { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
  ];

  // The money board is the part of the run a reader acts on, so it gets its own
  // block instead of being appended to the author list.
  const money = buildMoneySection(result, options.wikiBaseUrl);
  if (money) elements.push({ tag: "hr" }, { tag: "div", text: { tag: "lark_md", content: money } });

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "GitHub Star 知识库同步完成" },
        // Red header when something failed, so a broken run is obvious at a glance.
        template: result.failed ? "red" : "green",
      },
      elements,
    },
  };
}

/** The money digest plus links to every page this run touched. */
function buildMoneySection(result: BatchResult, wikiBaseUrl?: string): string | null {
  if (!result.commercialSummary && !result.commercialNodeToken) return null;

  const blocks: string[] = [];
  if (result.commercialSummary) blocks.push(result.commercialSummary);
  if (result.commercialError) blocks.push(`⚠️ 知识库页面写入失败：${result.commercialError}`);

  const links: string[] = [];
  const money = wikiLink(wikiBaseUrl, result.commercialNodeToken, "搞钱项目精选 Top 20");
  if (money) links.push(money);
  const trending = wikiLink(wikiBaseUrl, result.trendingNodeToken, "GitHub 上涨趋势榜");
  if (trending) links.push(trending);
  const index = wikiLink(wikiBaseUrl, result.indexNodeToken, "知识库首页");
  if (index) links.push(index);
  if (links.length) blocks.push(`📄 ${links.join("　|　")}`);

  return blocks.length ? blocks.join("\n\n") : null;
}

function wikiLink(
  wikiBaseUrl: string | undefined,
  nodeToken: string | null,
  label: string,
): string | null {
  const base = wikiBaseUrl?.trim();
  if (!base || !nodeToken) return null;
  return `[${label}](${base.replace(/\/+$/, "")}/${nodeToken})`;
}
