import { scrubEvidence } from "@prentice/domain";
import { appendFileSync, chmodSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

let destination: { file: string; maxBytes: number } | undefined;

/** Retain two bounded, redacted logs across background launches, including clean exits. */
export function configureLogFile(file?: string, maxBytes = 1_048_576): void {
  destination = file ? { file, maxBytes } : undefined;
  if (file) mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
}

export function log(level: "info" | "warn" | "error", message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify(scrubEvidence({ at: new Date().toISOString(), pid: process.pid, level, message, ...fields }));
  if (destination) {
    try {
      let size = 0;
      try { size = statSync(destination.file).size; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (size && size + Buffer.byteLength(line) + 1 > destination.maxBytes) renameSync(destination.file, `${destination.file}.1`);
      appendFileSync(destination.file, `${line}\n`, { mode: 0o600 });
      chmodSync(destination.file, 0o600);
      return;
    } catch {
      // A full or unavailable log disk must not take the connector offline.
      console.error("Prentice could not write its diagnostic log.");
    }
  }
  if (level === "error") console.error(line);
  else console.log(line);
}
