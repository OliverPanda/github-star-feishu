const fs = require("fs");
const token = (fs.readFileSync(".env", "utf8").match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();

const FINAL = [
  // 外贸与跨境电商
  "dgtlmoon","itswadesh","markshust","imranhsayed","aimeos","goenning",
  // 营销增长与获客
  "StanGirard","AgriciDaniel","knadh","phodal","feder-cr",
  // AIGC 内容生产
  "harry0703","FujiwaraChoki","gyoridavid","debpalash","camenduru","Anil-matcha","Sanster","hua1995116",
  // 内容获客
  "Evil0ctal","davidteather",
  // 数据采集与自动化
  "D4Vinci","mishushakov","enescingoz",
  // 量化与金融
  "polakowo","stefan-jansen","chrisleekr",
  // AI 应用与独立产品
  "Yidadaa","lencx","JimmyLv",
  // 中文技术影响力
  "521xueweihan","DIYgod",
];

const QUERY = `query($login: String!) {
  user(login: $login) {
    login name bio followers { totalCount }
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
  const rows = [];
  for (const login of FINAL) {
    let body;
    try { body = await post({ login }); } catch (e) { rows.push({ login, ok: false, why: String(e).slice(0, 60) }); continue; }
    if (body.errors) { rows.push({ login, ok: false, why: body.errors.map((e) => e.message).join(";").slice(0, 90) }); continue; }
    const u = body.data?.user;
    if (!u) { rows.push({ login, ok: false, why: "no user" }); continue; }
    rows.push({ login, ok: true, name: u.name, followers: u.followers.totalCount, stars: u.starredRepositories.totalCount, bio: (u.bio ?? "").replace(/\s+/g, " ").slice(0, 60) });
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log("login".padEnd(20), "followers".padStart(9), "stars".padStart(6), " name / bio");
  for (const r of rows) {
    if (!r.ok) { console.log(`${r.login.padEnd(20)} ${"FAILED".padStart(9)}   ${r.why}`); continue; }
    console.log(`${r.login.padEnd(20)} ${String(r.followers).padStart(9)} ${String(r.stars).padStart(6)}  ${r.name ?? "-"} | ${r.bio}`);
  }
  const thin = rows.filter((r) => r.ok && r.stars < 60);
  console.log(`\nstar 列表偏薄(<60)的：${thin.map((r) => `${r.login}(${r.stars})`).join(", ") || "无"}`);
})();
