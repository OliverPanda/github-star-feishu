/**
 * Push a card to a Feishu chat through the tenant app's own bot.
 *
 * The group-bot webhook is the low-effort channel, but it needs someone to
 * create a group and copy a URL out of it. An app that is already authorized to
 * write the knowledge base can also post to a chat it belongs to, which lets a
 * scheduled run notify the reader with no extra manual setup.
 */

export const FEISHU_OPEN_API = "https://open.feishu.cn/open-apis";

export interface AppNotifyOptions {
  appId: string;
  appSecret: string;
  /** Chat that receives the card; the app's bot must be a member. */
  chatId: string;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

/** Card payload shared by both notification channels. */
export type CardPayload = Record<string, unknown>;

interface TokenResponse {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
}

interface MessageResponse {
  code?: number;
  msg?: string;
}

/**
 * Tenant tokens live two hours, and a daily job only ever asks for one.
 *
 * The cache still matters because a single run notifies once per batch and the
 * local server keeps the process alive across days: without it every task would
 * trade a round trip for a token it just fetched.
 */
let cachedToken: { appId: string; token: string; expiresAt: number } | null = null;

export async function getTenantAccessToken(options: {
  appId: string;
  appSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const { appId, appSecret, fetchImpl = fetch } = options;
  if (cachedToken && cachedToken.appId === appId && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const response = await fetchImpl(`${FEISHU_OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  if (!response.ok) {
    throw new Error(`获取飞书 tenant_access_token 失败：HTTP ${response.status}`);
  }

  const body = (await response.json()) as TokenResponse;
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取飞书 tenant_access_token 失败：${body.code ?? "?"} ${body.msg ?? ""}`.trim());
  }

  // Renew a minute early so a message in flight never uses a token that expires
  // between the check and the request.
  const ttl = Math.max((body.expire ?? 7200) - 60, 60) * 1000;
  cachedToken = { appId, token: body.tenant_access_token, expiresAt: Date.now() + ttl };
  return body.tenant_access_token;
}

/**
 * Send one interactive card into a chat.
 *
 * `content` must be a JSON *string* on the message API, even though the group
 * webhook takes the same card as a nested object — mixing the two shapes is the
 * usual cause of the opaque `field validation failed` reply.
 */
export async function sendChatCard(card: CardPayload, options: AppNotifyOptions): Promise<void> {
  const { appId, appSecret, chatId, fetchImpl = fetch, log = () => {} } = options;
  const token = await getTenantAccessToken({ appId, appSecret, fetchImpl });

  const response = await fetchImpl(
    `${FEISHU_OPEN_API}/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`飞书消息发送失败：HTTP ${response.status}`);
  }

  const body = (await response.json().catch(() => null)) as MessageResponse | null;
  if (body && typeof body.code === "number" && body.code !== 0) {
    throw new Error(`飞书消息发送失败：${body.code} ${body.msg ?? ""}`.trim());
  }

  log("      已推送飞书群消息");
}
