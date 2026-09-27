import { openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

/** One packaged connector per home directory. A second launch leaves the first one running. */
export function claimSingleInstance(home: string): boolean {
  const file = join(home, "connector.lock");
  if (tryClaim(file)) return true;
  if (!holderAlive(file)) {
    try {
      unlinkSync(file);
    } catch {
      return false;
    }
    return tryClaim(file);
  }
  return false;
}

function tryClaim(file: string): boolean {
  try {
    const handle = openSync(file, "wx", 0o600);
    writeSync(handle, String(process.pid));
    process.on("exit", () => {
      try {
        unlinkSync(file);
      } catch {
        // The next launch treats a dead pid as a stale lock.
      }
    });
    return true;
  } catch {
    return false;
  }
}

function holderAlive(file: string): boolean {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    return code === "EPERM";
  }
}
