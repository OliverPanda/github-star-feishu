import { describe, expect, it, vi } from "vitest";
import { getTenantAccessToken, sendChatCard } from "../src/feishu/app-notify.js";

const CARD = { header: { title: { tag: "plain_text", content: "搞钱项目精选" } } };

function tokenThenMessage(
  messageBody: Record<string, unknown> = { code: 0, msg: "success" },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string, init: RequestInit) => {
    if (url.includes("tenant_access_token")) {
      expect(JSON.parse(init.body as string)).toMatchObject({ app_id: expect.any(String) });
      return new Response(
        JSON.stringify({ code: 0, tenant_access_token: "t-123", expire: 7200 }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify(messageBody), { status: 200 });
  });
}

describe("getTenantAccessToken", () => {
  it("returns the tenant token and reuses it for the same app", async () => {
    const fetchImpl = tokenThenMessage();
    const first = await getTenantAccessToken({ appId: "cli_cache", appSecret: "s", fetchImpl: fetchImpl as any });
    const second = await getTenantAccessToken({ appId: "cli_cache", appSecret: "s", fetchImpl: fetchImpl as any });

    expect(first).toBe("t-123");
    expect(second).toBe("t-123");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when Feishu rejects the credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 10003, msg: "invalid param" }), { status: 200 }),
    );

    await expect(
      getTenantAccessToken({ appId: "cli_bad", appSecret: "nope", fetchImpl: fetchImpl as any }),
    ).rejects.toThrow(/10003 invalid param/);
  });
});

describe("sendChatCard", () => {
  it("posts the card as a JSON string to the configured chat", async () => {
    const fetchImpl = tokenThenMessage();

    await sendChatCard(CARD, {
      appId: "cli_send",
      appSecret: "s",
      chatId: "oc_abc",
      fetchImpl: fetchImpl as any,
    });

    const [url, init] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(url).toContain("/im/v1/messages?receive_id_type=chat_id");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t-123");
    const body = JSON.parse(init.body as string);
    expect(body.receive_id).toBe("oc_abc");
    expect(body.msg_type).toBe("interactive");
    // The message API wants the card double-encoded; a nested object is the
    // documented cause of "field validation failed".
    expect(typeof body.content).toBe("string");
    expect(JSON.parse(body.content)).toEqual(CARD);
  });

  it("throws with the Feishu code when the message is rejected", async () => {
    const fetchImpl = tokenThenMessage({ code: 99992402, msg: "field validation failed" });

    await expect(
      sendChatCard(CARD, {
        appId: "cli_reject",
        appSecret: "s",
        chatId: "oc_abc",
        fetchImpl: fetchImpl as any,
      }),
    ).rejects.toThrow(/99992402 field validation failed/);
  });
});
