import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

function helper(): string | undefined {
  const app = process.env.PRENTICE_APP_PATH;
  const file = app && join(app, "Contents", "Resources", "mac-service");
  return process.platform === "darwin" && file && existsSync(file) ? file : undefined;
}

/** User-facing permission/error handling lives in the app, not in the hosted UI. */
export function showMacStartupError(error: unknown): boolean {
  const file = helper(); if (!file) return false;
  const plist = join(homedir(), "Library", "LaunchAgents", "com.prentice.connector.plist");
  try { log("info", "macOS background service authorization", { status: Number(execFileSync(file, ["status", plist], { encoding: "utf8", timeout: 5_000 }).trim()) }); }
  catch { log("warn", "Could not read macOS background service authorization"); }
  try {
    execFileSync(file, ["startup-error", plist,
      error instanceof Error ? error.message : "The background connector did not start."], { stdio: "ignore" });
  } catch (e) { return (e as { status?: number }).status === 10; }
  return false;
}

export function finishMacInstallation(): void {
  const file = helper(); if (!file) return;
  try {
    const result = JSON.parse(execFileSync(file, ["finish-install", process.env.PRENTICE_APP_PATH!], { encoding: "utf8", timeout: 30_000 })) as { movedCopies: string[] };
    log("info", "Installed app ready; duplicate download copies moved to Trash", { count: result.movedCopies.length });
  } catch { log("warn", "Installed app is ready, but download cleanup could not finish"); }
}
