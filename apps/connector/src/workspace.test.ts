import { mkdtemp, writeFile, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { readWorkspaceFile, readWorkspaceDiff } from "./workspace.js";
const race = vi.hoisted(() => ({ beforeOpen: null as null | (() => Promise<void>) }));
vi.mock("node:fs/promises", async importOriginal => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, open: async (...args: Parameters<typeof original.open>) => {
    const replace = race.beforeOpen; race.beforeOpen = null;
    if (replace) await replace();
    return original.open(...args);
  } };
});
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
it("reads legitimate files and rejects direct, directory and ancestor symlink escapes and traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "prentice-containment-")); roots.push(root);
  const repo = join(root, "repo"); const outside = join(root, "outside");
  await mkdir(repo); await mkdir(outside);
  await writeFile(join(repo, "safe.txt"), "safe"); await writeFile(join(outside, "secret.txt"), "private");
  await symlink(join(outside, "secret.txt"), join(repo, "link.txt"));
  await symlink(outside, join(repo, "linked"));
  await mkdir(join(repo, "nested")); await symlink(outside, join(repo, "nested", "ancestor"));
  expect((await readWorkspaceFile(repo, "safe.txt")).content).toBe("safe");
  for (const path of ["link.txt", "linked/secret.txt", "nested/ancestor/secret.txt", "../outside/secret.txt"]) {
    await expect(readWorkspaceFile(repo, path)).rejects.toThrow("PATH_OUTSIDE");
    await expect(readWorkspaceDiff(repo, path)).rejects.toThrow("PATH_OUTSIDE");
  }
});

it("rejects a symlink replacement between ancestor inspection and descriptor open", async () => {
  const root = await mkdtemp(join(tmpdir(), "prentice-containment-race-")); roots.push(root);
  const repo = join(root,"repo"); const inside = join(repo,"folder"); const outside = join(root,"outside");
  await mkdir(inside,{recursive:true}); await mkdir(outside);
  await writeFile(join(inside,"file.txt"),"inside"); await writeFile(join(outside,"file.txt"),"outside-secret");
  race.beforeOpen=async()=>{ await rm(inside,{recursive:true}); await symlink(outside,inside); };
  await expect(readWorkspaceFile(repo,"folder/file.txt")).rejects.toThrow("PATH_CHANGED");
});

it('keeps staged, unstaged and untracked counts current after parallel snapshot reads', async () => {
  const { execFileSync } = await import('node:child_process');
  const { workspaceSnapshot } = await import('./workspace.js');
  const repo = await mkdtemp(join(tmpdir(), 'prentice-workspace-snapshot-')); roots.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q');
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\n');
  await writeFile(join(repo, 'deleted.txt'), 'gone\n');
  git('add', '.'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Initial');
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\nthree\n'); git('add', 'file.txt');
  await writeFile(join(repo, 'file.txt'), 'one\ntwo\nthree\nfour\n');
  await rm(join(repo, 'deleted.txt')); await writeFile(join(repo, 'new.txt'), 'new\n');
  const first = await workspaceSnapshot(repo);
  expect(first.additions).toBe(3); expect(first.deletions).toBe(1);
  expect(first.changes).toEqual(expect.arrayContaining([{path:'file.txt',change:'modified'},{path:'deleted.txt',change:'deleted'},{path:'new.txt',change:'added'}]));
  const { patch } = await readWorkspaceDiff(repo, 'new.txt');
  expect(patch).toContain('diff --git a/new.txt b/new.txt');
  expect(patch).toContain('+++ b/new.txt');
  expect(patch).not.toContain('prentice-file-diff-');
  await writeFile(join(repo, 'new.txt'), 'new\nsecond\n');
  expect((await workspaceSnapshot(repo)).additions).toBe(4);
});
