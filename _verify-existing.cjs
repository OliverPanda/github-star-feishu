const fs = require("fs");
const token = (fs.readFileSync(".env", "utf8").match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();
const EXISTING = ["karpathy","ggerganov","lucidrains","rasbt","hwchase17","jerryjliu","jxnl","chiphuyen","eugeneyan","antfu","yyx990803","sindresorhus","tj","gaearon","Rich-Harris","ry","steven-tey","Nutlope","mckaywrigley","t3dotgg","kentcdodds","ranaroussi","labuladong","jackfrued","ruanyf","donnemartin","sdan","zhangyoufu"];
const QUERY = `query($login: String!) { user(login: $login) { login followers { totalCount } starredRepositories(first: 1) { totalCount } } }`;
async function post(v, attempts = 4) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch("https://api.github.com/graphql", { method: "POST", headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "roster-verify" }, body: JSON.stringify({ query: QUERY, variables: v }) });
      return await res.json();
    } catch (e) { if (i === attempts - 1) throw e; await new Promise((r) => setTimeout(r, 2500 * (i + 1))); }
  }
}
(async () => {
  const rows = [];
  for (const login of EXISTING) {
    let b; try { b = await post({ login }); } catch (e) { rows.push({ login, err: 1 }); continue; }
    const u = b.data?.user;
    rows.push(u ? { login, f: u.followers.totalCount, s: u.starredRepositories.totalCount } : { login, err: 1 });
    await new Promise((r) => setTimeout(r, 300));
  }
  for (const r of rows.sort((a, b) => (a.s ?? -1) - (b.s ?? -1))) {
    console.log(r.err ? `${r.login.padEnd(18)} FAILED` : `${r.login.padEnd(18)} f=${String(r.f).padStart(7)} stars=${String(r.s).padStart(5)}`);
  }
  const ok = rows.filter((r) => !r.err);
  console.log(`\n现有 ${ok.length} 人 star 中位数=${ok.map((r) => r.s).sort((a,b)=>a-b)[Math.floor(ok.length/2)]}，最小=${Math.min(...ok.map((r) => r.s))}`);
})();
