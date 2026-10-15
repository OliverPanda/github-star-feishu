const Database = require("better-sqlite3");
const db = new Database("data/stars.db", { readonly: true });
console.log(db.prepare("select sql from sqlite_master where name='wiki_nodes'").get().sql);
console.log("---");
for (const r of db.prepare("select * from wiki_nodes").all()) console.log(JSON.stringify(r));
