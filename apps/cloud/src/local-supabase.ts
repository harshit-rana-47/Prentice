import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudConfig } from "./server.js";

export function cloudConfigFromEnv(): CloudConfig & { publishableKey: string } {
  loadLocalSupabaseEnv();
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!supabaseUrl || !secretKey || !publishableKey || !databaseUrl) {
    throw new Error("Start the local Supabase stack with npx supabase start, then rerun the tests.");
  }
  return { supabaseUrl, secretKey, publishableKey, databaseUrl };
}

export async function signIn(email: string): Promise<{ userId: string; accessToken: string }> {
  const config = cloudConfigFromEnv();
  const admin = createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const linked = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (linked.error || !linked.data.user || !linked.data.properties?.email_otp) {
    throw new Error(linked.error?.message ?? "Could not create a magic link.");
  }
  const user = createClient(config.supabaseUrl, config.publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const verification = linked.data.properties.verification_type;
  const verified = await user.auth.verifyOtp({
    email,
    token: linked.data.properties.email_otp,
    type: verification === "magiclink" ? "magiclink" : "email",
  });
  const accessToken = verified.data.session?.access_token;
  if (verified.error || !accessToken) throw new Error(verified.error?.message ?? "Magic link verification failed.");
  return { userId: linked.data.user.id, accessToken };
}

export async function forgetUser(userId: string): Promise<void> {
  const config = cloudConfigFromEnv();
  const admin = createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const deleted = await admin.auth.admin.deleteUser(userId);
  if (deleted.error && !/not found/i.test(deleted.error.message)) throw new Error(deleted.error.message);
}

function loadLocalSupabaseEnv(): void {
  loadDotEnv(join(repoRoot(), ".env"));
  if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY && process.env.DATABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY) {
    return;
  }
  const output = execFileSync("npx", ["--yes", "supabase@latest", "status", "-o", "env"], {
    cwd: repoRoot(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const line of output.split("\n")) {
    const match = /^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] ?? "";
    const value = match[2] ?? match[3] ?? "";
    if (!process.env[key]) process.env[key] = value;
  }
  process.env.SUPABASE_URL ||= process.env.API_URL;
  process.env.SUPABASE_SECRET_KEY ||= process.env.SERVICE_ROLE_KEY;
  process.env.SUPABASE_PUBLISHABLE_KEY ||= process.env.ANON_KEY;
  process.env.DATABASE_URL ||= process.env.DB_URL;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../..");
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
    if (key && !process.env[key]) process.env[key] = value;
  }
}
