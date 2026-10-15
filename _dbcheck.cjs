const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/stars.db");
console.log(db.prepare("select sql from sqlite_master where name in ('authors','stars')").all().map((r) => r.sql).join("\n\n"));
const rows = db.prepare("select login, followers, last_synced_at from authors order by last_synced_at desc").all();
console.log("\n--- authors ---");
for (const r of rows) console.log(String(r.login).padEnd(16), String(r.followers ?? "-").padStart(8), r.last_synced_at ?? "-");
console.log("\n--- per-author star count ---");
for (const r of db.prepare("select a.login, count(s.id) as c from authors a left join stars s on s.author_id = a.id group by a.login order by c desc").all()) console.log(String(r.login).padEnd(16), r.c);