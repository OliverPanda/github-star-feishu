const Database = require("better-sqlite3");
const db = new Database("D:/My-Project/github_star_RAG/data/stars.db", { readonly: true });
console.log("settings:");
for (const row of db.prepare("select key, value from settings").all()) console.log("  ", row.key, "=", row.value);
console.log("wiki_nodes:");
for (const row of db.prepare("select id, author_id, doc_key, space_id, node_token, document_id, title from wiki_nodes").all()) {
  console.log("  ", JSON.stringify(row));
}
console.log("authors:", JSON.stringify(db.prepare("select login, name from authors").all()));
db.close();
