import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startCloud } from "./server.js";

loadDotEnv(join(dirname(fileURLToPath(import.meta.url)), "../../../.env"));

const supabaseUrl = required("SUPABASE_URL");
const secretKey = required("SUPABASE_SECRET_KEY");
const databaseUrl = required("DATABASE_URL");
const host = process.env.PRENTICE_CLOUD_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? process.env.PRENTICE_CLOUD_PORT ?? 4740);
const cloud = await startCloud({ supabaseUrl, secretKey, databaseUrl }, port, host);
console.log(
  JSON.stringify({
    at: new Date().toISOString(),
    level: "info",
    message: "Prentice cloud listening",
    host,
    port: cloud.port,
  }),
);

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Prentice cloud needs ${name}.`);
    process.exit(1);
  }
  return value;
}

function loadDotEnv(path: string): void {
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key.startsWith("GROQ_")) continue;
    if (key && !process.env[key]) process.env[key] = value;
  }
}
