const fs = require("fs");
const token = (fs.readFileSync(".env", "utf8").match(/^GITHUB_TOKEN=(.*)$/m) || [])[1]?.trim();

const TOPICS = [
  "seo", "seo-tools", "keyword-research", "serp", "email-marketing", "cold-email",
  "crm", "lead-generation", "etsy", "aliexpress-scraper", "shopify-theme",
  "shopping-cart", "prestashop", "magento", "opencart", "amazon",
  "ebay-api", "dropshipping-automation", "tiktok-api", "youtube-automation",
  "text-to-video", "ai-video", "faceless-video", "voice-cloning", "ai-music",
  "stable-diffusion", "comfyui", "ai-avatars", "product-photography", "print-on-demand",
];

const QUERY = `query($q: String!) {
  search(query: $q, type: REPOSITORY, first: 15) {
    nodes {
      ... on Repository {
        nameWithOwner
        stargazerCount
        owner { login __typename ... on User { name followers { totalCount } starredRepositories { totalCount } } }
      }
    }
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
      await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
}

(async () => {
  const people = new Map();
  for (const topic of TOPICS) {
    let body;
    try { body = await post({ q: `topic:${topic} sort:stars-desc` }); }
    catch (e) { console.log(`! ${topic}: ${String(e).slice(0, 50)}`); continue; }
    if (body.errors) { console.log(`! ${topic}: ${body.errors[0].message.slice(0, 60)}`); continue; }
    for (const node of body.data.search.nodes) {
      const o = node?.owner;
      if (!o || o.__typename !== "User") continue;
      const e = people.get(o.login) ?? { login: o.login, name: o.name, followers: o.followers.totalCount, stars: o.starredRepositories.totalCount, tops: [], topics: new Set() };
      e.tops.push(`${node.nameWithOwner}(${node.stargazerCount})`);
      e.topics.add(topic);
      people.set(o.login, e);
    }
    await new Promise((r) => setTimeout(r, 2100));
  }
  const all = [...people.values()];
  console.log(`唯一 User 作者：${all.length}\n`);
  console.log("=== 粉丝>=400 且 star>=60（按粉丝） ===");
  for (const p of all.filter((p) => p.followers >= 400 && p.stars >= 60).sort((a, b) => b.followers - a.followers)) {
    console.log(`${String(p.login).padEnd(22)} ${String(p.name ?? "").slice(0,20).padEnd(22)} f=${String(p.followers).padStart(6)} st=${String(p.stars).padStart(5)} | ${p.tops.slice(0,2).join(", ")} | ${[...p.topics].slice(0,4).join("/")}`);
  }
  console.log("\n=== 粉丝>=1500 但 star<60 ===");
  for (const p of all.filter((p) => p.followers >= 1500 && p.stars < 60).sort((a, b) => b.followers - a.followers).slice(0, 25)) {
    console.log(`${String(p.login).padEnd(22)} ${String(p.name ?? "").slice(0,20).padEnd(22)} f=${String(p.followers).padStart(6)} st=${String(p.stars).padStart(5)} | ${p.tops.slice(0,2).join(", ")} | ${[...p.topics].slice(0,4).join("/")}`);
  }
})();
