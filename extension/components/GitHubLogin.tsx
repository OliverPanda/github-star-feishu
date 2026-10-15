import { useEffect, useRef, useState } from "react";
import {
  ApiError,
  type GitHubLoginSession,
  type GitHubLoginStatus,
} from "../lib/api.js";
import { createClient } from "../lib/settings.js";

/** Polling cadence while the device flow waits for the user to approve. */
const POLL_INTERVAL_MS = 1500;

interface Props {
  /** Disables the controls until the service address and token are usable. */
  disabled?: boolean;
  /** Called after a successful sign-in, so dependent cards can reload. */
  onLoggedIn?: () => void;
}

/**
 * Scan-to-sign-in for GitHub.
 *
 * GitHub ships its own device flow, so there is no app to register and no
 * settings page to visit: the service runs `gh auth login --web`, the user
 * approves the one-time code in a browser, and the resulting token is written
 * straight into the project's `.env`.
 */
export function GitHubLogin({ disabled = false, onLoggedIn }: Props) {
  const [status, setStatus] = useState<GitHubLoginStatus | null>(null);
  const [session, setSession] = useState<GitHubLoginSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The finished session, kept only long enough to tell the user which .env
  // file the scanned token was written to.
  const [saved, setSaved] = useState<GitHubLoginSession | null>(null);
  // Cancels the polling loop when the component unmounts or a new run starts.
  const generation = useRef(0);

  const refresh = async (): Promise<void> => {
    const client = await createClient();
    setStatus(await client.githubStatus());
  };

  useEffect(() => {
    const current = ++generation.current;
    void (async () => {
      try {
        const client = await createClient();
        const latest = await client.githubStatus();
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

      let next: GitHubLoginSession;
      try {
        next = await client.githubLoginSession(id);
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
        // The token landed in .env, which is what the next sync reads, so the
        // write is confirmed on screen instead of silently happening.
        setStatus(await client.githubStatus().catch(() => null));
        setError(null);
        setSaved(next);
        onLoggedIn?.();
        return;
      }
      if (next.state === "failed") {
        setBusy(false);
        setError(next.error ?? "GitHub 登录失败");
        return;
      }
    }
  };

  const start = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    generation.current += 1;
    try {
      const client = await createClient();
      const created = await client.startGitHubLogin();
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
      await client.cancelGitHubLogin(id);
    } catch {
      // Already finished server-side; nothing left to cancel.
    }
  };

  const logout = async () => {
    setBusy(true);
    setError(null);
    setSaved(null);
    try {
      const client = await createClient();
      await client.githubLogout();
      await refresh();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="spread">
        <h2>GitHub 账号</h2>
        <StatusBadge status={status} />
      </div>

      {session ? (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted small" style={{ margin: 0 }}>
            用手机相机扫描下面的二维码（会打开 GitHub 授权页），或直接在浏览器打开下面的链接并输入设备码。
          </p>
          {session.qrDataUrl ? (
            <img
              src={session.qrDataUrl}
              alt="GitHub 登录二维码"
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
              设备码：<code>{session.prompt.userCode}</code>
            </p>
          ) : null}
          {linkFor(session) ? (
            <p className="small" style={{ margin: 0, textAlign: "center" }}>
              在浏览器打开并输入设备码后点 Authorize：
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
              ? `已登录${status.login ? `：${status.login}` : ""}。同步时会用这个账号读取 star 记录。`
              : "扫码登录你自己的 GitHub 账号，登录成功后服务会把 Token 自动写入项目 .env，无需手动创建 PAT。"}
          </p>

          {status?.loggedIn && status.tokenSource ? (
            <p className="muted small" style={{ margin: 0 }}>
              凭据来源：<code>{status.tokenSource}</code>
              {status.scopes.length ? `（授权范围：${status.scopes.join("、")}）` : ""}
            </p>
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
                {busy ? "正在启动…" : "扫码登录 GitHub"}
              </button>
            )}
          </div>
        </>
      )}

      {saved ? (
        <div className="alert">
          登录成功，Token 已写入 <code>{saved.envFile}</code>。
        </div>
      ) : null}
      {error ? <div className="alert error">{error}</div> : null}
    </div>
  );
}

function StatusBadge({ status }: { status: GitHubLoginStatus | null }) {
  if (!status) return <span className="badge">未检测</span>;
  return status.loggedIn ? (
    <span className="badge accent">已登录</span>
  ) : (
    <span className="badge paused">未登录</span>
  );
}

/**
 * GitHub's device page takes no code parameter, so the link is always the bare
 * approval URL and the code is typed in by hand.
 */
function linkFor(session: GitHubLoginSession): string | null {
  return session.prompt?.verificationUri ?? null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
