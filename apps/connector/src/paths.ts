import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { gitRoot } from "./git.js";

/**
 * One directory identity for a git repository.
 * The walk uses the names stored in each parent directory, so a different
 * capitalization of the same folder matches. It keeps the path git reported,
 * including a `/var` prefix that is a symlink to `/private/var`.
 */
export async function canonicalRepoPath(input: string): Promise<string> {
  return onDiskPath(resolve(input));
}

export async function identifiesRepository(storedPath: string, canonical: string): Promise<boolean> {
  const root = await gitRoot(storedPath);
  if (root) return (await canonicalRepoPath(root)) === canonical;
  try {
    return (await canonicalRepoPath(storedPath)) === canonical;
  } catch {
    return false;
  }
}

/**
 * The open repository is the agent's workspace.
 * This is a session binding, not a summary of the files.
 */
export function repositorySessionNote(repoPath: string): string {
  return [
    `You are working in the git repository at ${repoPath}.`,
    "That directory is the project the user has open.",
    "Read and edit files there, and run commands there.",
    'When the user says "this", "this project", "this app", "this code", or "the current repository", they mean this directory.',
    "Inspect the repository before asking them which folder they mean.",
  ].join(" ");
}

async function onDiskPath(absolute: string): Promise<string> {
  const parts = absolute.split(sep).filter((part) => part.length > 0);
  let current = absolute.startsWith(sep) ? sep : "";
  if (!absolute.startsWith(sep)) {
    current = parts.shift() ?? "";
  }
  for (const part of parts) {
    const entries = await readdir(current || ".").catch(() => [] as string[]);
    const folded = part.normalize("NFC").toLowerCase();
    const match =
      entries.find((entry) => entry === part) ??
      entries.find((entry) => entry.normalize("NFC").toLowerCase() === folded);
    current = join(current, match ?? part);
  }
  return current;
}
