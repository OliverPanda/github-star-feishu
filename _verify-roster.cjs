const fs = require("fs");

const env = fs.readFileSync(".env", "utf8");
const token = (env.match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();
if (!token) { console.error("no GITHUB_TOKEN"); process.exit(1); }

const CANDIDATES = [
  "levelsio","marc-lou","dillionverma","Yidadaa","DIYgod","521xueweihan","phodal",
  "JimmyLv","PlexPt","lencx","pengzhile","wong2","f","lllyasviel","AUTOMATIC1111",
  "comfyanonymous","oobabooga","camenduru","TheLastBen","xmatthias","mementum",
  "kernc","polakowo","D4Vinci","ultrafunkamsterdam","omkarcloud","lorien","shadcn",
  "addyosmani","sdras","ColeMurray","mayooear","enricoros","n4ze3m","justjavac",
  "harry0703","assafelovic","VikParuchuri","berstend","axllent","Zie619",
  "itzCrazyKns","marmelab","hanshuaikang","kaixindelele","RimoChan","wongchito"
];

const QUERY = `query($login: String!) {
  user(login: $login) {
    login
    name
    followers { totalCount }
    starredRepositories(first: 1) { totalCount }
  }
}`;

async function one(login) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "roster-verify" },
    body: JSON.stringify({ query: QUERY, variables: { login } }),
  });
  const body = await res.json();
  if (body.errors) return { login, ok: false, why: body.errors.map((e) => e.message).join("; ").slice(0, 120) };
  const u = body.data?.user;
  if (!u) return { login, ok: false, why: "no user" };
  return {
    login,
    ok: true,
    name: u.name,
    followers: u.followers.totalCount,
    stars: u.starredRepositories.totalCount,
  };
}

(async () => {
  const out = [];
  for (const login of CANDIDATES) {
    try { out.push(await one(login)); } catch (e) { out.push({ login, ok: false, why: String(e).slice(0, 80) }); }
  }
  const good = out.filter((r) => r.ok).sort((a, b) => b.followers - a.followers);
  const bad = out.filter((r) => !r.ok);
  console.log("=== OK (sorted by followers) ===");
  for (const r of good) console.log(`${String(r.followers).padStart(7)}  stars=${String(r.stars).padStart(5)}  ${r.login.padEnd(22)} ${r.name ?? ""}`);
  console.log("\n=== FAILED ===");
  for (const r of bad) console.log(`${r.login.padEnd(22)} ${r.why}`);
})();
