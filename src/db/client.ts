import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

export interface OpenDbOptions {
  /** Path to the SQLite file, or ":memory:" for tests. */
  dbPath: string;
  /** Directory holding drizzle migrations. */
  migrationsFolder?: string;
}

export function openDb(options: OpenDbOptions): Db {
  const { dbPath, migrationsFolder } = options;

  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const sqlite = new Database(dbPath);
  // WAL keeps the CLI responsive if a sync is running while another command
  // reads the DB; foreign_keys is OFF by default in SQLite and our cascades
  // depend on it.
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  const db = drizzle(sqlite, { schema });

  if (migrationsFolder && fs.existsSync(migrationsFolder)) {
    migrate(db, { migrationsFolder });
  }

  return db;
}

export { schema };
