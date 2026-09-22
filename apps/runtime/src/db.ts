import { DatabaseSync } from "node:sqlite";

export interface Sql {
  exec(sql: string): void;
  run(sql: string, params?: SqlValue[]): void;
  get<T>(sql: string, params?: SqlValue[]): T | undefined;
  all<T>(sql: string, params?: SqlValue[]): T[];
}

type SqlValue = string | number | bigint | null | Uint8Array;

export function openDatabase(path: string): Sql {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  return {
    exec(sql: string) {
      db.exec(sql);
    },
    run(sql: string, params: SqlValue[] = []) {
      db.prepare(sql).run(...params);
    },
    get<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    all<T>(sql: string, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as T[];
    },
  };
}

export function migrate(db: Sql): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      opened_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_code TEXT,
      error_message TEXT,
      consent INTEGER NOT NULL DEFAULT 0,
      base_commit TEXT,
      provider_id TEXT
    );
    CREATE TABLE IF NOT EXISTS routing_decisions (
      task_id TEXT PRIMARY KEY,
      decision_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_packets (
      task_id TEXT PRIMARY KEY,
      packet_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS understand_artifacts (
      task_id TEXT PRIMARY KEY,
      artifact_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS explain_sessions (
      task_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telemetry (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
