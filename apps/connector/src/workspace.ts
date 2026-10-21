import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { readdir, lstat, realpath, open, mkdtemp, writeFile, rm } from "node:fs/promises";
import { relative, resolve, sep, isAbsolute, join } from "node:path";
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
  if (isAbsolute(requestPath) || requestPath.split(/[\\/]/).includes("..")) return null;
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
  const [branchName, porcelain, head, canonical] = await Promise.all([
    git(repo, ["branch", "--show-current"]).catch(() => ""),
    git(repo, ["status", "--porcelain", "--untracked-files=all"]),
    headCommit(repo),
    realpath(repo),
  ]);
  const branch = branchName.trim() || "HEAD";
  const changes = parseStatus(porcelain);
  const [diffs, tree] = await Promise.all([head ? collectDiff(repo, head) : [], readTree(canonical, "", canonical)]);
  const additions = diffs.reduce((sum, file) => sum + file.additions, 0);
  const deletions = diffs.reduce((sum, file) => sum + file.deletions, 0);
  return { branch, changes, additions, deletions, tree };
}

export async function readWorkspaceFile(repo: string, requestPath: string): Promise<{ path: string; content: string; binary: boolean }> {
  const { path, buffer } = await containedFile(repo, requestPath);
  if (buffer === null) return { path, content: "", binary: true };
  return { path, content: buffer.includes(0) ? "" : buffer.toString("utf8"), binary: buffer.includes(0) };
}

/** Reject symlinks at every component, then read the verified descriptor rather than reopening a pathname. */
async function containedFile(repo: string, requestPath: string, missing = false): Promise<{ path: string; buffer: Buffer | null }> {
  const root = await realpath(repo);
  const full = resolveInside(root, requestPath);
  if (!full) throw new Error("PATH_OUTSIDE");
  const path = relative(root, full);
  const components = [root];
  let current = root;
  for (const part of path.split(sep)) { current = join(current, part); components.push(current); }
  const identities: Array<{ path: string; dev: number; ino: number }> = [];
  for (const component of components) {
    const info = await lstat(component).catch((error: NodeJS.ErrnoException) => {
      if (missing && component === full && error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) return { path, buffer: Buffer.alloc(0) };
    if (info.isSymbolicLink()) throw new Error("PATH_OUTSIDE");
    identities.push({ path: component, dev: info.dev, ino: info.ino });
  }
  const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    const expected = identities.at(-1)!;
    if (!info.isFile()) throw new Error("NOT_A_FILE");
    if (info.dev !== expected.dev || info.ino !== expected.ino) throw new Error("PATH_CHANGED");
    const check = async () => {
      if (await realpath(repo) !== root) throw new Error("PATH_CHANGED");
      for (const identity of identities) {
        const now = await lstat(identity.path);
        if (now.isSymbolicLink() || now.dev !== identity.dev || now.ino !== identity.ino) throw new Error("PATH_CHANGED");
      }
    };
    await check();
    const buffer = info.size > 1_000_000 ? null : await handle.readFile();
    await check();
    return { path, buffer: buffer && buffer.length > 1_000_000 ? null : buffer };
  } finally { await handle.close(); }
}

export async function readWorkspaceDiff(repo: string, requestPath: string): Promise<{ path: string; patch: string }> {
  const { path, buffer } = await containedFile(repo, requestPath, true);
  if (buffer === null) return { path, patch: "Binary or large file; patch omitted." };
  // Git reads the index directly. Worktree bytes come only from the contained, verified file descriptor.
  const indexed = await gitText(repo, ["show", `:${path}`]).catch(() => "");
  const staged = await gitText(repo, ["diff", "--cached", "--", path]);
  const temporary = await mkdtemp(join(tmpdir(), "prentice-file-diff-"));
  try {
    const before = join(temporary, "before");
    const after = join(temporary, "after");
    await writeFile(before, indexed);
    await writeFile(after, buffer);
    const work = await gitText(repo, ["diff", "--no-index", "--", before, after]);
    const patch = work.replaceAll(`a${before}`, `a/${path}`).replaceAll(`b${after}`, `b/${path}`)
      .replaceAll(before, path).replaceAll(after, path);
    return { path, patch: [staged.trim(), patch.trim()].filter(Boolean).join("\n") };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function readTree(directory: string, prefix: string, root: string): Promise<TreeNode[]> {
  const identity = await lstat(directory);
  if (identity.isSymbolicLink() || !identity.isDirectory()) return [];
  const canonical = await realpath(directory);
  if (canonical !== root && !canonical.startsWith(`${root}${sep}`)) return [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const nodes: TreeNode[] = [];
  const sorted = entries.filter((entry) => !SKIP.has(entry.name)).sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const entry of sorted) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({ name: entry.name, path, kind: "dir", children: await readTree(resolve(directory, entry.name), path, root).catch(() => []) });
    } else if (entry.isFile()) {
      nodes.push({ name: entry.name, path, kind: "file" });
    }
  }
  const after = await lstat(directory);
  if (after.isSymbolicLink() || after.dev !== identity.dev || after.ino !== identity.ino) return [];
  return nodes;
}
