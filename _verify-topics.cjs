const fs = require("fs");
const token = (fs.readFileSync(".env", "utf8").match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();

const TOPICS = [
  "ecommerce", "shopify", "dropshipping", "cross-border-ecommerce", "seo",
  "marketing-automation", "affiliate-marketing", "email-marketing",
  "ai-agent", "text-to-video", "ai-art", "llm", "rag",
  "automation", "scraping", "erp", "crm", "saas",
  "newsletter", "indie-hackers", "side-project", "monetization",
  "trading-bot", "quantitative-finance", "dropshipping-tools",
];

const QUERY = `query($q: String!) {
  search(query: $q, type: REPOSITORY, first: 20) {
    nodes {
      ... on Repository {
        nameWithOwner
        stargazerCount
        owner {
          login
          __typename
          ... on User { name followers { totalCount } starredRepositories { totalCount } }
        }
      }
    }
  }
}`;

(async () => {
  const people = new Map();
  for (const topic of TOPICS) {
    const res = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: { authorization: `bearer ${token}`, "content-type": "application/json", "user-agent": "roster-verify" },
      body: JSON.stringify({ query: QUERY, variables: { q: `topic:${topic} sort:stars-desc` } }),
    });
    const body = await res.json();
    if (body.errors) { console.log(`! ${topic}: ${body.errors[0].message.slice(0, 80)}`); continue; }
    for (const node of body.data.search.nodes) {
      const o = node?.owner;
      if (!o || o.__typename !== "User") continue;
      const entry = people.get(o.login) ?? {
        login: o.login, name: o.name,
        followers: o.followers.totalCount,
        stars: o.starredRepositories.totalCount,
        tops: [],
      };
      entry.tops.push(`${node.nameWithOwner}(${node.stargazerCount})`);
      people.set(o.login, entry);
    }
    await new Promise((r) => setTimeout(r, 2200));
  }

  const all = [...people.values()];
  console.log(`唯一 User 作者：${all.length}\n`);
  console.log("=== star 列表够厚（>=150）且粉丝 >=800 ===");
  for (const p of all.filter((p) => p.stars >= 150 && p.followers >= 800).sort((a, b) => b.stars - a.stars)) {
    console.log(`${String(p.login).padEnd(22)} ${String(p.name ?? "").slice(0, 22).padEnd(24)} f=${String(p.followers).padStart(6)} st=${String(p.stars).padStart(5)} | ${p.tops.slice(0, 3).join(", ")}`);
  }
  console.log("\n=== 其余（供人工判断） ===");
  for (const p of all.filter((p) => !(p.stars >= 150 && p.followers >= 800)).sort((a, b) => b.followers - a.followers).slice(0, 60)) {
    console.log(`${String(p.login).padEnd(22)} ${String(p.name ?? "").slice(0, 22).padEnd(24)} f=${String(p.followers).padStart(6)} st=${String(p.stars).padStart(5)} | ${p.tops.slice(0, 2).join(", ")}`);
  }
})();
