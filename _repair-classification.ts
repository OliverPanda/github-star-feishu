import { loadConfig } from './src/config.js';
import { openDb } from './src/db/client.js';
import { createLanguageModel } from './src/llm/provider.js';
import { classifyRepos } from './src/llm/classify.js';
import { saveClassifications } from './src/store.js';
import { sql } from 'drizzle-orm';

const config = loadConfig();
const db = openDb({ dbPath: config.dbPath });
const model = createLanguageModel(config);
type Entry = { starId: number; fullName: string; description: string | null; language: string | null; topics: string };
const entries = db.all<Entry>(sql`select s.id as starId, r.full_name as fullName,
  r.description, r.language, r.topics from stars s join repos r on r.id=s.repo_id
  where s.classified_at is not null and
  (s.summary_zh is null or trim(s.summary_zh) = '' or s.money_score is null)`);
console.log(`待补齐 ${entries.length} 条记录`);
let saved = 0;
for (let offset = 0; offset < entries.length; offset += 25) {
  const batch = entries.slice(offset, offset + 25);
  const unique = [...new Map(batch.map(e => [e.fullName, {
    ...e, topics: JSON.parse(e.topics || '[]') as string[],
  }])).values()];
  const results = await classifyRepos(unique, { model });
  const valid = batch.filter(e => Boolean(results.get(e.fullName)?.summaryZh.trim()));
  saved += saveClassifications(db, valid, results);
  console.log(`已补齐并保存 ${saved}/${entries.length}`);
}
if (saved !== entries.length) process.exitCode = 1;
