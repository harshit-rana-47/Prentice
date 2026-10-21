import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CloudConfig } from "./server.js";

let localTestEnv: Record<string, string> | undefined;

export function cloudConfigFromEnv(): CloudConfig & { publishableKey: string } {
  loadLocalSupabaseEnv();
  const supabaseUrl = process.env.SUPABASE_URL ?? "";
  const secretKey = process.env.SUPABASE_SECRET_KEY ?? "";
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? "";
  const databaseUrl = process.env.DATABASE_URL ?? "";
  if (!supabaseUrl || !secretKey || !publishableKey || !databaseUrl) {
    throw new Error("Tests need all four Supabase/database settings. Start local Supabase, or explicitly select a dedicated hosted test project with PRENTICE_TEST_SUPABASE=hosted and .env.test.");
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
  // Tests default to the real local stack. Production .env must not silently select a stale hosted database.
  if (process.env.PRENTICE_TEST_SUPABASE === "hosted") {
    loadDotEnv(join(repoRoot(), ".env.test"));
    return;
  }
  if (localTestEnv) {
    Object.assign(process.env, localTestEnv);
    return;
  }
  const binary = process.env.PRENTICE_SUPABASE_CLI;
  const output = execFileSync(binary || "npx", binary ? ["status", "-o", "env"] : ["--yes", "supabase@2.120.0", "status", "-o", "env"], {
    cwd: repoRoot(),
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const local: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const match = /^([A-Z0-9_]+)=(?:"(.*)"|(.*))$/.exec(line.trim());
    if (!match) continue;
    const key = match[1] ?? "";
    const value = match[2] ?? match[3] ?? "";
    local[key] = value;
  }
  localTestEnv = {
    SUPABASE_URL: local.API_URL ?? "",
    SUPABASE_SECRET_KEY: local.SERVICE_ROLE_KEY ?? "",
    SUPABASE_PUBLISHABLE_KEY: local.ANON_KEY ?? "",
    DATABASE_URL: local.DB_URL ?? "",
  };
  Object.assign(process.env, localTestEnv);
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
