import postgres, { type Sql } from "postgres";

export type Database = Sql;

/** Transaction-mode pooler safe: prepared statements stay off. */
export function openDatabase(url: string): Database {
  const host = new URL(url).hostname;
  const local = host === "127.0.0.1" || host === "localhost";
  return postgres(url, {
    max: 10,
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 15,
    ssl: local ? false : "require",
  });
}
