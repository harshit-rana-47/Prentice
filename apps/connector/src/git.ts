import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
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
