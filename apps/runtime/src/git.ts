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
  try {
    const result = (await git(repo, ["rev-parse", "--is-inside-work-tree"])).trim();
    return result === "true";
  } catch {
    return false;
  }
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
    const additions = content.length === 0 ? 0 : content.split("\n").length;
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
