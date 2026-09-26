import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { NextConfig } from "next";

const rootEnv = readRootEnv(join(__dirname, "../../.env"));
assignPublic("NEXT_PUBLIC_SUPABASE_URL", rootEnv.SUPABASE_URL);
assignPublic("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", rootEnv.SUPABASE_PUBLISHABLE_KEY);
assignPublic("NEXT_PUBLIC_PRENTICE_CLOUD_URL", rootEnv.PRENTICE_CLOUD_URL);

const nextConfig: NextConfig = {
  transpilePackages: ["@prentice/domain", "@prentice/protocol"],
};

export default nextConfig;

function assignPublic(name: string, value: string | undefined): void {
  if (!process.env[name] && value) process.env[name] = value;
}

function readRootEnv(path: string): Record<string, string> {
  try {
    const values: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
      let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key === "SUPABASE_URL" || key === "SUPABASE_PUBLISHABLE_KEY" || key === "PRENTICE_CLOUD_URL") values[key] = value;
    }
    return values;
  } catch {
    return {};
  }
}
