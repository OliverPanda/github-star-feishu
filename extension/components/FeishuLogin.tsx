import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type FeishuLoginSession,
  type FeishuLoginStatus,
} from "../lib/api.js";
import { createClient } from "../lib/settings.js";

/** Polling cadence while a device flow is waiting for the user to scan. */
const POLL_INTERVAL_MS = 1500;

interface Props {
  /** Disables the controls until the service address and token are usable. */
  disabled?: boolean;
  /** Called after a successful sign-in, so dependent cards can reload. */
  onLoggedIn?: () => void;
}

/**
 * Scan-to-sign-in for Feishu.
 *
 * The user never visits the Feishu open platform: the service runs
 * `feishu-cli`, which registers a personal app and then asks that app for a
 * user token, both confirmed by scanning with the Feishu mobile app.
 */
export function FeishuLogin({ disabled = false, onLoggedIn }: Props) {
  const [status, setStatus] = useState<FeishuLoginStatus | null>(null);
  const [session, setSession] = useState<FeishuLoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Cancels the polling loop when the component unmounts or a new run starts.
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const client = await createClient();
        const latest = await client.feishuStatus();
        if (current === generation.current) setStatus(latest);
      } catch {
        // The service may not be running yet; the form below will say so when
        // the user actually presses a button.
      }
    })();
    return () => {
      generation.current += 1;
    };
  }, []);

  const poll = async (id: string) => {
    const current = generation.current;
    const client = await createClient();

    for (;;) {
      await delay(POLL_INTERVAL_MS);
      if (current !== generation.current) return;

      let next: FeishuLoginSession;
      try {
        next = await client.feishuLoginSession(id);
      } catch (cause) {
        if (current === generation.current) {
          setError(describe(cause));
          setBusy(false);
        }
        return;
      }
      if (current !== generation.current) return;

      setSession(next);
      if (next.state === "success") {
        setBusy(false);
        setSession(null);
        setStatus(await client.feishuStatus().catch(() => null));
        onLoggedIn?.();
        return;
      }
      if (next.state === "failed") {
        setBusy(false);
        setError(next.error ?? "飞书登录失败");
        return;
      }
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    generation.current += 1;
    try {
      const client = await createClient();
      const created = await client.startFeishuLogin();
      setSession(created);
      void poll(created.id);
    } catch (cause) {
      setError(describe(cause));
      setBusy(false);
    }
  };

  const cancel = async () => {
    const id = session?.id;
    generation.current += 1;
    setSession(null);
    setBusy(false);
    if (!id) return;
    try {
      const client = await createClient();
      await client.cancelFeishuLogin(id);
    } catch {
      // Already finished server-side; nothing left to cancel.
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    try {
      const client = await createClient();
      await client.feishuLogout();
      setStatus(await client.feishuStatus());
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="spread">
        <h2>飞书知识库</h2>
        <StatusBadge status={status} />
      </div>

      {session ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            {session.step === "create_app"
              ? "第 1 步：创建属于你自己的飞书应用。用手机飞书扫描下面的二维码即可，无需访问开放平台。"
              : "第 2 步：授权访问你的知识库。用手机飞书扫描下面的二维码。"}
          </p>
          {session.qrDataUrl ? (
            <img
              src={session.qrDataUrl}
              alt="飞书登录二维码"
              width={220}
              height={220}
              style={{
                alignSelf: "center",
                background: "#ffffff",
                padding: 8,
                borderRadius: 6,
              }}
            />
          ) : (
            <div className="alert warning">正在生成二维码，请稍候…</div>
          )}
          {session.prompt?.userCode ? (
            <p className="small" style={{ margin: 0, textAlign: "center" }}>
              用户码：<code>{session.prompt.userCode}</code>
            </p>
          ) : null}
          {linkFor(session) ? (
            <p className="small" style={{ margin: 0, textAlign: "center" }}>
              也可以直接在浏览器打开：
              <br />
              <code style={{ wordBreak: "break-all" }}>{linkFor(session)}</code>
            </p>
          ) : null}
          <div className="row" style={{ justifyContent: "center" }}>
            <button type="button" onClick={() => void cancel()}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small" style={{ margin: 0 }}>
            {status?.loggedIn
              ? `已登录${status.userName ? `：${status.userName}` : ""}。同步时会以你的身份写入知识库。`
              : "扫码登录你的飞书账号，同步时会以你自己的身份写入知识库。首次登录会自动创建一个属于你的飞书应用。"}
          </p>

          {status?.loggedIn && status.appId ? (
            <p className="muted small" style={{ margin: 0 }}>
              应用：<code>{status.appId}</code>
            </p>
          ) : null}

          {status?.loggedIn && status.missingScopes.length ? (
            <div className="alert warning">
              缺少权限：{status.missingScopes.join("、")}
              <br />
              重新登录即可补齐。
            </div>
          ) : null}

          {!status?.loggedIn && status?.hint ? (
            <div className="alert warning">{status.hint}</div>
          ) : null}

          <div className="row">
            {status?.loggedIn ? (
              <>
                <button type="button" onClick={() => void start()} disabled={busy || disabled}>
                  {busy ? "请稍候…" : "重新登录"}
                </button>
                <button type="button" onClick={() => void logout()} disabled={busy || disabled}>
                  退出登录
                </button>
              </>
            ) : (
              <button
                type="button"
                className="primary"
                onClick={() => void start()}
                disabled={busy || disabled}
              >
                {busy ? "正在启动…" : "扫码登录飞书"}
              </button>
            )}
          </div>
        </>
      )}

      {error ? <div className="alert error">{error}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: FeishuLoginStatus | null }) {
  if (!status) return <span className="badge">未检测</span>;
  return status.loggedIn ? (
    <span className="badge accent">已登录</span>
  ) : (
    <span className="badge paused">未登录</span>
  );
}

function linkFor(session: FeishuLoginSession): string | null {
  return session.prompt?.verificationUriComplete ?? session.prompt?.verificationUri ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
