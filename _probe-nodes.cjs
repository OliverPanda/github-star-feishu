const Database = require("better-sqlite3");
const db = new Database("data/stars.db", { readonly: true });
const nodes = db.prepare("select id, author_id, doc_key, space_id, node_token, title from wiki_nodes").all();
console.log(JSON.stringify(nodes, null, 2));
const settings = db.prepare("select key, value from settings").all();
console.log(JSON.stringify(settings, null, 2));
const authors = db.prepare("select id, login, name, followers, starred_count, is_self from authors").all();
console.log(JSON.stringify(authors, null, 2));
