import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { migrate, openDatabase } from "./db.js";
import { Store } from "./store.js";

/** The old root prentice.db is deliberately never read or moved here. */
export function accountDirectory(home: string, userId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
    throw new Error("An authenticated Prentice account is required.");
  }
  return join(home, "accounts", userId.toLowerCase());
}

export function accountStore(home: string, userId: string): Store {
  const directory = accountDirectory(home, userId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = openDatabase(join(directory, "prentice.db"));
  migrate(db);
  return new Store(db);
}
