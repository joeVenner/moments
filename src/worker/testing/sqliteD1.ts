/**
 * Test-only D1 stand-in backed by Node's built-in SQLite, with every file in
 * `migrations/` applied in order. Lets route and module tests run the real SQL
 * (constraints, indexes, upserts) instead of hand-written query fakes.
 *
 * Only the D1 surface the worker uses is implemented: prepare/bind/first/all/run
 * and batch (run atomically in one transaction, like D1).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations", import.meta.url));

type Bindable = string | number | bigint | null | Uint8Array;

function toSqlValue(value: unknown): SQLInputValue {
  // D1 rejects undefined bindings; mirror that so tests catch the bug.
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: undefined is not a supported bind value");
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as Bindable;
}

class SqliteStatement {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly args: SQLInputValue[] = []
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values.map(toSqlValue));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>(): Promise<{ results: T[]; success: true }> {
    const rows = this.db.prepare(this.sql).all(...this.args) as Record<string, unknown>[];
    return { results: rows.map((row) => ({ ...row }) as T), success: true };
  }

  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    return { success: true, meta: this.execute() };
  }

  execute(): { changes: number; last_row_id: number } {
    const result = this.db.prepare(this.sql).run(...this.args);
    return { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) };
  }
}

export interface SqliteD1 {
  db: D1Database;
  raw: DatabaseSync;
}

export function createSqliteD1(): SqliteD1 {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON;");
  const files = readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith(".sql")).sort();
  for (const file of files) raw.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));

  const db = {
    prepare: (sql: string) => new SqliteStatement(raw, sql),
    batch: async (statements: SqliteStatement[]) => {
      raw.exec("BEGIN");
      try {
        const results = statements.map((statement) => ({ success: true, meta: statement.execute() }));
        raw.exec("COMMIT");
        return results;
      } catch (error) {
        raw.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db: db as unknown as D1Database, raw };
}
