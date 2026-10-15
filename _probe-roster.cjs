const fs = require("fs");
const t = fs.readFileSync(".env", "utf8").match(/GITHUB_TOKEN=(.*)/)[1].trim();
const names = ["karpathy","ggerganov","lucidrains","rasbt","hwchase17","jerryjliu","jxnl","chiphuyen","eugeneyan","antfu","yyx990803","sindresorhus","tj","gaearon","Rich-Harris","ry","shadcn","steven-tey","Nutlope","mckaywrigley","sdan","levelsio","yongfook","ranaroussi","labuladong","jackfrued","ruanyf","jwasham","kelseyhightower","donnemartin","t3dotgg","ThePrimeagen","kentcdodds","leerob","zhangyoufu","lydiahallie","kamranahmedse","OpenBB-finance","bentoml","lm-sys","tloen","oobabooga","AUTOMATIC1111"];
const q = `query($login: String!) { user(login: $login) { login name followers { totalCount } starredRepositories { totalCount } } }`;
(async () => {
  for (const n of names) {
    const r = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json", "User-Agent": "probe" },
      body: JSON.stringify({ query: q, variables: { login: n } }),
    });
    const j = await r.json();
    if (j.errors) { console.log(`${n} | ERR | ${(j.errors[0].message || "").slice(0, 60)}`); continue; }
    const u = j.data.user;
    console.log([n, u.login, u.name, u.followers.totalCount, u.starredRepositories.totalCount].join(" | "));
  }
})();
