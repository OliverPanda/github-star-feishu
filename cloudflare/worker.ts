interface Env {
  /** GitHub fine-grained token with Actions: write permission. */
  GITHUB_TOKEN: string;
  /** Repository in owner/name form, for example octocat/github-star-rag. */
  GITHUB_REPOSITORY: string;
  /** Workflow file name or workflow id. */
  WORKFLOW_FILE?: string;
  /** Branch or tag to run the workflow on. */
  WORKFLOW_REF?: string;
  /** Bearer token for the manual endpoint. */
  CRON_TOKEN?: string;
}

const WORKFLOW_DEFAULT = "daily.yml";
const REF_DEFAULT = "main";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function requiredEnv(env: Env): string | null {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPOSITORY) {
    return "GITHUB_TOKEN 和 GITHUB_REPOSITORY 尚未配置";
  }
  if (!env.GITHUB_REPOSITORY.includes("/")) {
    return "GITHUB_REPOSITORY 必须是 owner/name 格式";
  }
  return null;
}

async function dispatchSync(env: Env): Promise<Response> {
  const configError = requiredEnv(env);
  if (configError) return json({ ok: false, error: configError }, 500);

  const [owner, repo] = env.GITHUB_REPOSITORY.split("/", 2);
  const workflow = env.WORKFLOW_FILE || WORKFLOW_DEFAULT;
  const ref = env.WORKFLOW_REF || REF_DEFAULT;
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "content-type": "application/json",
        "user-agent": "github-star-rag-cloudflare-scheduler",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({ ref, inputs: { full: "false" } }),
    },
  );

  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    return json({ ok: false, error: `GitHub dispatch 失败（${response.status}）`, detail }, 502);
  }
  return json({ ok: true, repository: env.GITHUB_REPOSITORY, workflow, ref });
}

function authorized(request: Request, env: Env): boolean {
  if (!env.CRON_TOKEN) return false;
  return request.headers.get("authorization") === `Bearer ${env.CRON_TOKEN}`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "github-star-rag-sync", schedule: "每天北京时间 09:00" });
    }
    if (request.method === "POST" && url.pathname === "/run") {
      if (!authorized(request, env)) return json({ ok: false, error: "未授权" }, 401);
      return dispatchSync(env);
    }
    return json({ ok: false, error: "Not Found" }, 404);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(dispatchSync(env));
  },
};
