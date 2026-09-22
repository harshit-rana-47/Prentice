import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { migrate, openDatabase } from "./db.js";
import { log } from "./log.js";
import { SecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";

const home = process.env.PRENTICE_HOME ?? join(homedir(), ".prentice");
const port = Number(process.env.PRENTICE_PORT ?? 4731);
const origins = (process.env.PRENTICE_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

mkdirSync(home, { recursive: true });
const token = randomBytes(32).toString("hex");
const runtimeFile = join(home, "runtime.json");
writeFileSync(runtimeFile, JSON.stringify({ token, port, origins }), { mode: 0o600 });
await chmod(runtimeFile, 0o600);
await chmod(home, 0o700);

const db = openDatabase(join(home, "prentice.db"));
migrate(db);
const store = new Store(db);
const secrets = new SecretStore(join(home, "secrets.json"));

const app = createApp({ store, secrets, token, allowedOrigins: origins });

serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  log("info", "Prentice runtime listening", { host: "127.0.0.1", port: info.port });
});
