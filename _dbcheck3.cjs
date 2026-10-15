const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("data/stars.db");
const r = db.prepare("select a.login, count(s.id) total, sum(case when s.category is not null then 1 else 0 end) withCat, sum(case when s.classified_at is not null then 1 else 0 end) done from authors a left join stars s on s.author_id=a.id where a.login='D4Vinci' group by a.login").get();
console.log(r);