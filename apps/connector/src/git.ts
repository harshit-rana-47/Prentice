import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DiffFile, FileChangeKind } from "@prentice/domain";

const exec = promisify(execFile);

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: repo,
    maxBuffer: 12_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

/** `git diff` exits 1 when a difference exists. That stdout is still the diff. */
export function gitText(repo: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: repo, maxBuffer: 12_000_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (error, stdout) => {
        const code = typeof error === "object" && error && "code" in error ? Number(error.code) : 0;
        if (!error || code === 1) resolve(stdout ?? "");
        else reject(error);
      },
    );
  });
}

export async function isGitRepo(repo: string): Promise<boolean> {
  return (await gitRoot(repo)) !== null;
}

/** Repository root as git reports it. Null when the path is not inside a work tree. */
export async function gitRoot(repo: string): Promise<string | null> {
  try {
    const inside = (await git(repo, ["rev-parse", "--is-inside-work-tree"])).trim();
    if (inside !== "true") return null;
    const root = (await git(repo, ["rev-parse", "--show-toplevel"])).trim();
    return root || null;
  } catch {
    return null;
  }
}

/**
 * Content identity of HEAD plus every dirty path.
 * `git status` alone stays `??` when an already-untracked file is edited.
 */
export async function worktreeFingerprint(repo: string): Promise<string> {
  const head = (await headCommit(repo)) ?? "none";
  const raw = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const records = raw.split("\0").filter((record) => record.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    if (status.includes("R") || status.includes("C")) {
      paths.push(records[index + 1] || path);
      index += 1;
    } else {
      paths.push(path);
    }
  }
  const lines: string[] = [];
  for (const path of [...new Set(paths)].sort()) {
    try {
      lines.push(`${path} ${(await git(repo, ["hash-object", "--", path])).trim()}`);
    } catch {
      lines.push(`${path} missing`);
    }
  }
  return `${head}\n${lines.join("\n")}`;
}

export async function headCommit(repo: string): Promise<string | null> {
  try {
    const commit = (await git(repo, ["rev-parse", "HEAD"])).trim();
    return commit || null;
  } catch {
    return null;
  }
}

export async function showFile(repo: string, commit: string, path: string): Promise<string | null> {
  try {
    return await git(repo, ["show", `${commit}:${path}`]);
  } catch {
    return null;
  }
}

const MISSING = "missing";
const ABSENT = "absent";

export interface WorktreeSnapshot {
  head: string;
  entries: Map<string, { hash: string; text: string | null }>;
}

export interface TurnChange extends DiffFile {
  beforeText: string | null;
  afterText: string | null;
}

/** Dirty, staged, and untracked paths, including files git already considers deleted. */
export async function dirtyPaths(repo: string): Promise<string[]> {
  const raw = await git(repo, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  const records = raw.split("\0").filter((record) => record.length > 0);
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index] ?? "";
    const status = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;
    if (status.includes("R") || status.includes("C")) {
      paths.push(path);
      paths.push(records[index + 1] || path);
      index += 1;
    } else {
      paths.push(path);
    }
  }
  return [...new Set(paths)];
}

/**
 * Content of every dirty path plus HEAD.
 * The stored text is the worktree at this moment, so a later diff does not reach back to an older commit.
 */
export async function captureWorktree(repo: string): Promise<WorktreeSnapshot> {
  const head = (await headCommit(repo)) ?? "none";
  const entries = new Map<string, { hash: string; text: string | null }>();
  for (const path of await dirtyPaths(repo)) {
    const hash = await contentHash(repo, path);
    entries.set(path, { hash, text: hash === MISSING ? null : await readText(repo, path) });
  }
  return { head, entries };
}

export function sameWorktree(before: WorktreeSnapshot, after: WorktreeSnapshot): boolean {
  if (before.head !== after.head || before.entries.size !== after.entries.size) return false;
  for (const [path, entry] of before.entries) {
    if (after.entries.get(path)?.hash !== entry.hash) return false;
  }
  return true;
}

/**
 * Difference between two captured worktree states.
 * A path whose content hash matches on both sides is omitted, including when a commit only recorded dirt that was already there.
 */
export async function diffWorktrees(repo: string, before: WorktreeSnapshot, after: WorktreeSnapshot): Promise<TurnChange[]> {
  const paths = new Set<string>([...before.entries.keys(), ...after.entries.keys()]);
  if (before.head !== after.head && before.head !== "none" && after.head !== "none") {
    const named = await gitText(repo, ["diff", "--name-status", before.head, after.head]);
    for (const line of named.split("\n")) {
      if (!line.trim()) continue;
      const parts = line.split("\t");
      for (const path of parts.slice(1)) {
        if (path.trim()) paths.add(path.trim());
      }
    }
  }

  const changes: TurnChange[] = [];
  for (const path of [...paths].sort()) {
    const start = await sideState(repo, before, path, "before");
    const end = await sideState(repo, after, path, "after");
    if (start.hash === end.hash) continue;
    const change: FileChangeKind = !start.exists && end.exists ? "added" : start.exists && !end.exists ? "deleted" : "modified";
    const delta =
      start.text === null && end.text === null && (start.exists || end.exists)
        ? { additions: 0, deletions: 0 }
        : await lineDelta(start.exists ? start.text : null, end.exists ? end.text : null);
    changes.push({
      evidenceId: `file:${path}`,
      path,
      change,
      additions: delta.additions,
      deletions: delta.deletions,
      beforeText: start.exists ? start.text : null,
      afterText: end.exists ? end.text : null,
    });
  }
  return changes;
}

async function sideState(
  repo: string,
  snapshot: WorktreeSnapshot,
  path: string,
  side: "before" | "after",
): Promise<{ hash: string; text: string | null; exists: boolean }> {
  const captured = snapshot.entries.get(path);
  if (captured) {
    const exists = captured.hash !== MISSING;
    return { hash: captured.hash, text: exists ? captured.text : null, exists };
  }
  if (side === "before") {
    if (snapshot.head === "none") return { hash: ABSENT, text: null, exists: false };
    const hash = await blobHash(repo, snapshot.head, path);
    if (!hash) return { hash: ABSENT, text: null, exists: false };
    return { hash, text: await showFile(repo, snapshot.head, path), exists: true };
  }
  const hash = await contentHash(repo, path);
  if (hash === MISSING) return { hash: ABSENT, text: null, exists: false };
  return { hash, text: await readText(repo, path), exists: true };
}

async function contentHash(repo: string, path: string): Promise<string> {
  try {
    const hash = (await git(repo, ["hash-object", "--", path])).trim();
    return hash || MISSING;
  } catch {
    return MISSING;
  }
}

async function blobHash(repo: string, commit: string, path: string): Promise<string | null> {
  try {
    const hash = (await git(repo, ["rev-parse", `${commit}:${path}`])).trim();
    return hash || null;
  } catch {
    return null;
  }
}

async function readText(repo: string, path: string): Promise<string | null> {
  try {
    const buffer = await readFile(join(repo, path));
    if (buffer.includes(0) || buffer.length > 1_000_000) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

async function lineDelta(before: string | null, after: string | null): Promise<{ additions: number; deletions: number }> {
  if (before === null && after === null) return { additions: 0, deletions: 0 };
  if (before === null) return { additions: lineCount(after ?? ""), deletions: 0 };
  if (after === null) return { additions: 0, deletions: lineCount(before) };
  const dir = await mkdtemp(join(tmpdir(), "prentice-turn-"));
  try {
    await writeFile(join(dir, "before"), before);
    await writeFile(join(dir, "after"), after);
    const raw = await gitText(dir, ["diff", "--numstat", "--no-index", "--", "before", "after"]);
    const [additions, deletions] = (raw.split("\n")[0] ?? "").split("\t");
    return {
      additions: additions === "-" ? 0 : Number(additions) || 0,
      deletions: deletions === "-" ? 0 : Number(deletions) || 0,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function collectDiff(repo: string, baseCommit: string): Promise<DiffFile[]> {
  const nameStatus = await git(repo, ["diff", "--name-status", baseCommit, "--"]);
  const numstat = await git(repo, ["diff", "--numstat", baseCommit, "--"]);
  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [additions, deletions, path] = line.split("\t");
    if (!path) continue;
    counts.set(path, {
      additions: additions === "-" ? 0 : Number(additions) || 0,
      deletions: deletions === "-" ? 0 : Number(deletions) || 0,
    });
  }

  const files: DiffFile[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0] ?? "";
    const path = parts.length >= 3 ? parts[2]! : parts[1];
    if (!path || !status) continue;
    const change: FileChangeKind = status.startsWith("A")
      ? "added"
      : status.startsWith("D")
        ? "deleted"
        : "modified";
    const count = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({ evidenceId: `file:${path}`, path, change, ...count });
  }

  const untracked = await git(repo, ["ls-files", "--others", "--exclude-standard"]);
  for (const path of untracked.split("\n")) {
    if (!path.trim() || files.some((file) => file.path === path)) continue;
    const content = await readFile(join(repo, path), "utf8").catch(() => "");
    const additions = lineCount(content);
    files.push({
      evidenceId: `file:${path}`,
      path,
      change: "added",
      additions,
      deletions: 0,
    });
  }
  return files;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
}
