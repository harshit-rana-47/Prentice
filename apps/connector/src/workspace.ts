import { readdir, readFile, stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { git, gitText, headCommit, collectDiff } from "./git.js";

const SKIP = new Set(["node_modules", ".git", "dist", ".next", "coverage", "build", ".prentice"]);

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: TreeNode[];
}

export interface WorkChange {
  path: string;
  change: "added" | "modified" | "deleted";
}

export function resolveInside(root: string, requestPath: string): string | null {
  const base = resolve(root);
  const full = resolve(base, requestPath);
  const rel = relative(base, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return full;
}

export function parseStatus(porcelain: string): WorkChange[] {
  const changes: WorkChange[] = [];
  for (const line of porcelain.split("\n")) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3).trim();
    if (path.includes(" -> ")) path = path.split(" -> ").at(-1)?.trim() ?? path;
    const change = code.includes("?") || code.includes("A") ? "added" : code.includes("D") ? "deleted" : "modified";
    changes.push({ path, change });
  }
  return changes;
}

export async function workspaceSnapshot(repo: string): Promise<{
  branch: string;
  changes: WorkChange[];
  additions: number;
  deletions: number;
  tree: TreeNode[];
}> {
  const branch = (await git(repo, ["branch", "--show-current"]).catch(() => "")).trim() || "HEAD";
  const porcelain = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  const changes = parseStatus(porcelain);
  const head = await headCommit(repo);
  const diffs = head ? await collectDiff(repo, head) : [];
  const additions = diffs.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diffs.reduce((sum, file) => sum + file.deletions, 0);
  const tree = await readTree(repo, "");
  return { branch, changes, additions, deletions, tree };
}

export async function readWorkspaceFile(repo: string, requestPath: string): Promise<{ path: string; content: string; binary: boolean }> {
  const full = resolveInside(repo, requestPath);
  if (!full) throw new Error("PATH_OUTSIDE");
  const info = await stat(full);
  if (!info.isFile()) throw new Error("NOT_A_FILE");
  if (info.size > 1_000_000) return { path: relative(resolve(repo), full), content: "", binary: true };
  const buffer = await readFile(full);
  if (buffer.includes(0)) return { path: relative(resolve(repo), full), content: "", binary: true };
  return { path: relative(resolve(repo), full), content: buffer.toString("utf8"), binary: false };
}

export async function readWorkspaceDiff(repo: string, requestPath: string): Promise<{ path: string; patch: string }> {
  const full = resolveInside(repo, requestPath);
  if (!full) throw new Error("PATH_OUTSIDE");
  const rel = relative(resolve(repo), full);
  const staged = await gitText(repo, ["diff", "--cached", "--", rel]);
  const work = await gitText(repo, ["diff", "--", rel]);
  const combined = [staged.trim(), work.trim()].filter(Boolean).join("\n");
  if (combined) return { path: rel, patch: combined };
  const untracked = await gitText(repo, ["diff", "--no-index", "--", "/dev/null", rel]).catch(() => "");
  return { path: rel, patch: untracked };
}

async function readTree(directory: string, prefix: string): Promise<TreeNode[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nodes: TreeNode[] = [];
  const sorted = entries.filter((entry) => !SKIP.has(entry.name)).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path, kind: "dir", children: await readTree(resolve(directory, entry.name), path) });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path, kind: "file" });
    }
  }
  return nodes;
}
