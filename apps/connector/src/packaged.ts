import { readFileSync } from "node:fs";

/** Public addresses baked into the desktop app. Secrets are never read from this file. */
export function loadPackagedConfig(): void {
  const file = process.env.PRENTICE_CONFIG?.trim();
  if (!file) return;
  let parsed: { cloudUrl?: unknown; websiteUrl?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, "utf8")) as { cloudUrl?: unknown; websiteUrl?: unknown };
  } catch {
    return;
  }
  if (typeof parsed.cloudUrl === "string" && parsed.cloudUrl && process.env.PRENTICE_CLOUD_URL === undefined) {
    process.env.PRENTICE_CLOUD_URL = parsed.cloudUrl;
  }
  if (typeof parsed.websiteUrl === "string" && parsed.websiteUrl && process.env.PRENTICE_WEBSITE_URL === undefined) {
    process.env.PRENTICE_WEBSITE_URL = parsed.websiteUrl;
  }
}
