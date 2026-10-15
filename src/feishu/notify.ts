import type { BatchResult } from "../batch.js";

export interface NotifyOptions {
  /** Group bot webhook; when absent the caller simply skips notifying. */
  webhook?: string | undefined;
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
  return sendPayload(buildSummaryCard(result), options);
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
export function buildSummaryCard(result: BatchResult): Record<string, unknown> {
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

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text", content: "GitHub Star 知识库同步完成" },
        // Red header when something failed, so a broken run is obvious at a glance.
        template: result.failed ? "red" : "green",
      },
      elements: [{ tag: "div", text: { tag: "lark_md", content: lines.join("\n") } }],
    },
  };
}
