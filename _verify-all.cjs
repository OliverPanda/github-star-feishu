const fs = require("fs");
const src = fs.readFileSync("src/roster.ts", "utf8");
const logins = [...src.matchAll(/^\s*login:\s*"([^"]+)"/gm)].map((m) => m[1]);
console.log("名册读取到", logins.length, "人");
const token = (fs.readFileSync(".env", "utf8").match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();
const QUERY = `query($login: String!) {
  user(login: $login) {
    login name followers { totalCount }
    starredRepositories(first: 1) { totalCount }
  }
}`;
async function post(variables, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "roster-verify" },
        body: JSON.stringify({ query: QUERY, variables }),
      });
      return await res.json();
    } catch (e) {
      if (i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 2500 * (i + 1)));
    }
  }
}
(async () => {
  const bad = [];
  for (const login of logins) {
    let body;
    try { body = await post({ login }); } catch (e) { bad.push({ login, why: String(e).slice(0, 50) }); continue; }
    if (body.errors) { bad.push({ login, why: body.errors.map((e) => e.message).join(";").slice(0, 80) }); continue; }
    const u = body.data?.user;
    if (!u) { bad.push({ login, why: "no user (组织账号或不存在)" }); continue; }
    const stars = u.starredRepositories.totalCount;
    if (stars < 60) { bad.push({ login, why: `star 列表仅 ${stars}` }); continue; }
    console.log(`${login.padEnd(20)} ${String(u.followers.totalCount).padStart(8)} ${String(stars).padStart(6)}  ${u.name ?? "-"}`);
    await new Promise((r) => setTimeout(r, 350));
  }
  console.log("\n=== 不合格条目 ===");
  console.log(bad.length ? bad.map((b) => `${b.login}: ${b.why}`).join("\n") : "无，全部通过");
})();