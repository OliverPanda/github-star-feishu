import { useCallback, useEffect, useState } from "react";
import { ApiError, type FeishuSpace, type FeishuTarget } from "../lib/api.js";
import { createClient } from "../lib/settings.js";

interface Props {
  /** Disables the controls until the service address and token are usable. */
  disabled?: boolean;
  /** Bumped by the login card so a fresh sign-in reloads the space list. */
  refreshKey?: number;
}

/**
 * Picks the knowledge base that sync writes into.
 *
 * Without this the service has to guess from a name, and a name is not unique:
 * Feishu happily holds several knowledge bases called "GitHub Star 精选", so the
 * only reliable handle is the `space_id`.
 */
export function FeishuSpaceTarget({ disabled = false, refreshKey = 0 }: Props) {
  const [spaces, setSpaces] = useState<FeishuSpace[] | null>(null);
  const [target, setTarget] = useState<FeishuTarget | null>(null);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const client = await createClient();
      // Sequential on purpose: a 401 from the listing is the common case and its
      // message is the useful one, so do not let the target read mask it.
      const current = await client.feishuTarget();
      setTarget(current);
      setSelected((previous) => previous || current.spaceId || "");
      const list = await client.listFeishuSpaces();
      setSpaces(list);
    } catch (cause) {
      setSpaces(null);
      setError(describe(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const save = async () => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const client = await createClient();
      const chosen = spaces?.find((space) => space.spaceId === selected);
      const next = await client.setFeishuTarget(
        chosen ? { spaceId: chosen.spaceId, name: chosen.name } : { spaceId: selected },
      );
      setTarget(next);
      setStatus(`已设为「${next.space ?? next.spaceId}」。下次同步写入这里。`);
    } catch (cause) {
      setError(describe(cause));
    } finally {
      setBusy(false);
    }
  };

  const dirty = Boolean(selected) && selected !== (target?.spaceId ?? "");

  return (
    <div className="card stack" style={{ gap: 8 }}>
      <div className="spread">
        <h2>同步到哪个知识库</h2>
        <button type="button" className="link" onClick={() => void load()} disabled={loading || disabled}>
          {loading ? "加载中…" : "刷新"}
        </button>
      </div>

      <p className="muted small" style={{ margin: 0 }}>
        选定一个已有知识库后，同步会把内容写进去，而不是每次都新建一个。
      </p>

      {spaces === null ? (
        error ? null : (
          <div className="alert warning">
            {disabled ? "请先填写服务地址和 API Token。" : "正在读取知识库列表…"}
          </div>
        )
      ) : spaces.length === 0 ? (
        <div className="alert warning">
          你的飞书里还没有知识库。先在飞书里创建一个，再回来点「刷新」。
        </div>
      ) : (
        <label className="stack" style={{ gap: 4 }}>
          <span>知识库</span>
          <select
            value={selected}
            disabled={busy || disabled}
            onChange={(event) => setSelected(event.target.value)}
          >
            <option value="">请选择…</option>
            {spaces.map((space) => (
              <option key={space.spaceId} value={space.spaceId}>
                {label(space, spaces)}
              </option>
            ))}
          </select>
          <span className="muted small">
            同名知识库用编号区分。编号就是它的 <code>space_id</code>，可用来核对。
          </span>
        </label>
      )}

      {target?.spaceId ? (
        <p className="muted small" style={{ margin: 0 }}>
          当前：<code>{target.space ?? target.spaceId}</code>
          {target.space ? ` · ${target.spaceId}` : ""}
        </p>
      ) : (
        <p className="muted small" style={{ margin: 0 }}>
          当前：未指定。同步会按 <code>.env</code> 里配置的知识库名称查找。
        </p>
      )}

      <div className="row">
        <button type="button" className="primary" onClick={() => void save()} disabled={!dirty || busy || disabled}>
          {busy ? "保存中…" : "保存目标"}
        </button>
      </div>

      {status ? <div className="alert success">{status}</div> : null}
      {error ? <div className="alert error">{error}</div> : null}
    </div>
  );
}

/**
 * Prefixes the id only when the name is ambiguous.
 *
 * A unique name stays clean; duplicates stay tellable apart, which is the whole
 * point of showing ids here.
 */
function label(space: FeishuSpace, all: FeishuSpace[]): string {
  const duplicated = all.filter((other) => other.name === space.name).length > 1;
  if (!duplicated) return space.name;
  return `${space.name}（${short(space.spaceId)}）`;
}

/** Feishu ids are long; the tail is what differs between two spaces. */
function short(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id;
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}
