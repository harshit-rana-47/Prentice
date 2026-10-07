import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Local development stack: connector (dev HTTP), website, and a loopback Prentice cloud for the Learning AI.
// The cloud holds the Groq key. The connector reaches it with a random token created for this run only,
// and the cloud accepts that token only while it is bound to 127.0.0.1.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const env = { ...process.env, PRENTICE_DEV_LEARNING_TOKEN: randomBytes(32).toString("hex") };
const hasCloudConfig = cloudConfigured();
if (!hasCloudConfig) {
  console.warn("Prentice dev: SUPABASE_URL, SUPABASE_SECRET_KEY, or DATABASE_URL is missing from .env, so the local cloud is not started and the Learning AI is off.");
}
if (!env.PRENTICE_CLOUD_URL) env.PRENTICE_CLOUD_URL = "http://127.0.0.1:4740";
env.PRENTICE_CLOUD_HOST = "127.0.0.1";

const names = ["connector", "web", ...(hasCloudConfig ? ["cloud"] : []), "open"];
const commands = [
  "npm run dev -w @prentice/connector",
  "npm run dev -w @prentice/web",
  ...(hasCloudConfig ? ["npm run dev -w @prentice/cloud"] : []),
  "node scripts/open-dev-website.mjs",
];
const bin = join(root, "node_modules", ".bin", process.platform === "win32" ? "concurrently.cmd" : "concurrently");
const child = spawn(bin, ["-n", names.join(","), "-c", "blue,green,yellow,magenta", ...commands], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: process.platform === "win32",
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));

function cloudConfigured() {
  const file = join(root, ".env");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  return ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "DATABASE_URL"].every(
    (key) => (process.env[key] ?? "").trim() || new RegExp(`^${key}=\\S+`, "m").test(text),
  );
}
