const fs = require("fs");
const src = fs.readFileSync("src/roster.ts", "utf8");
const entries = [...src.matchAll(/login:\s*"([^"]+)",\s*\n\s*name:\s*"([^"]*)",\s*\n\s*tag:\s*"([^"]*)",\s*\n\s*blurb:\s*"([^"]*)",\s*\n\s*knownFollowers:\s*(\d+)/g)]
  .map((m) => ({ login: m[1], name: m[2], tag: m[3], blurb: m[4], followers: Number(m[5]) }));
console.log("解析到完整条目:", entries.length);
const seen = new Map();
for (const e of entries) { const k = e.login.toLowerCase(); seen.set(k, (seen.get(k) ?? 0) + 1); }
console.log("重复 login:", [...seen].filter(([, c]) => c > 1).map(([l]) => l).join(", ") || "无");
const tags = new Map();
for (const e of entries) tags.set(e.tag, (tags.get(e.tag) ?? 0) + 1);
console.log("\n赛道标签分布:");
for (const [t, c] of [...tags].sort((a, b) => b[1] - a[1])) console.log("  " + t.padEnd(20) + " " + c);