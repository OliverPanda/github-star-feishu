import { useEffect, useState } from "react";
import { ApiError } from "../lib/api.js";
import { FeishuLogin } from "./FeishuLogin.js";
import { FeishuSpaceTarget } from "./FeishuSpaceTarget.js";
import { GitHubLogin } from "./GitHubLogin.js";
import { DEFAULT_BASE_URL, loadSettings, saveSettings, createClient } from "../lib/settings.js";

export function Options() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [token, setToken] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feishuRevision, setFeishuRevision] = useState(0);

  useEffect(() => {
    void (async () => {
      const settings = await loadSettings();
      setBaseUrl(settings.baseUrl);
      setToken(settings.token);
    })();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      await saveSettings({ baseUrl, token });
      setStatus("已保存。");
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    setError(null);
    setStatus(null);
    try {
      // Persist first, otherwise the test would probe the previous values and
      // report a failure the user cannot connect to what they just typed.
      await saveSettings({ baseUrl, token });
      await probeHealth();
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setTesting(false);
    }
  };

  /** Split out so the login cards can refresh the line after they change a credential. */
  const probeHealth = async (): Promise<void> => {
    const client = await createClient();
    const health = await client.health;
    const parts = [
      health.github
        ? `GitHub ✓${health.githubUser ? `（${health.githubUser}）` : ""}`
        : "GitHub ✗（未登录，请在下方扫码登录）",
      health.llm ? "LLM ✓" : "LLM ✗（未配置 LLM_API_KEY，将跳过分类）",
      health.feishu
        ? `飞书 ✓${health.feishuUser ? `（${health.feishuUser}）` : ""}`
        : "飞书 ✗（未登录，请在下方扫码登录）",
    ];
    setStatus(`连接成功。服务端状态：${parts.join(" ｜ ")}`);
    // A malformed or expired token reads as "not logged in" with a reason; show
    // it instead of leaving the user with a bare ✗.
    setError(!health.github && health.githubHint ? `GitHub：${health.githubHint}` : null);
  };

  return (
    <div className="stack" style={{ padding: 20, maxWidth: 560 }}>
      <h1>GitHub Star RAG 设置</h1>
      <p className="muted small" style={{ margin: 0 }}>
        插件本身不保存任何 GitHub、LLM 或飞书凭证，真正的同步由本机的服务完成。先在项目目录运行{" "}
        <code>npm run api</code>，再把它的地址和 <code>API_TOKEN</code> 填到这里。
      </p>

      <form className="stack" onSubmit={save}>
        <label className="stack" style={{ gap: 4 }}>
          <span>服务地址</span>
          <input
            type="text"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder={DEFAULT_BASE_URL}
          />
          <span className="muted small">
            默认 <code>http://127.0.0.1:8787</code>。如果服务跑在别的机器上，改成那台机器的地址。
          </span>
        </label>

        <label className="stack" style={{ gap: 4 }}>
          <span>API Token</span>
          <input
            type="password"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="与服务端 .env 里的 API_TOKEN 一致"
          />
          <span className="muted small">
            Token 只存在浏览器本地（<code>storage.local</code>），不随插件分发。
          </span>
        </label>

        <div className="row">
          <button type="submit" className="primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button type="button" onClick={test} disabled={testing}>
            {testing ? "测试中…" : "保存并测试连接"}
          </button>
        </div>
      </form>

      {status ? <div className="alert success">{status}</div> : null}
      {error ? <div className="alert error">{error}</div> : null}

      <GitHubLogin
        disabled={!token.trim()}
        onLoggedIn={() => {
          // The test above may have said "GitHub ✗"; re-probe so the line reflects
          // the token that was just written into .env.
          void probeHealth().catch((cause) => setError(describe(cause)));
        }}
      />

      <FeishuLogin disabled={!token.trim()} onLoggedIn={() => setFeishuRevision((n) => n + 1)} />

      <FeishuSpaceTarget disabled={!token.trim()} refreshKey={feishuRevision} />

      <div className="card stack" style={{ gap: 6 }}>
        <h2>在 GitHub 页面上看到什么</h2>
        <p className="muted small" style={{ margin: 0 }}>
          打开任意仓库页面时，插件会查询订阅列表里有多少人 star 过它，并在右上角显示徽标。
          需要在浏览器里授予该站点权限（第一次点击时会询问）。
        </p>
      </div>
    </div>
  );
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
