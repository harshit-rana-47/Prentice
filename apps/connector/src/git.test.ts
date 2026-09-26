import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { captureWorktree, diffWorktrees, type TurnChange } from "./git.js";

const exec = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("turn attribution", () => {
  it("describes only the lines added to a tracked file that was already dirty", async () => {
    const repo = await repoWith("note.txt", "committed\n");
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\n");
    const before = await captureWorktree(repo);
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\nthis turn\n");
    const changes = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(summarize(changes)).toEqual([{ path: "note.txt", change: "modified", additions: 1, deletions: 0 }]);
    expect(changes[0]?.beforeText).toBe("committed\nalready dirty\n");
    expect(changes[0]?.afterText).toBe("committed\nalready dirty\nthis turn\n");
  });

  it("describes only the new lines in an untracked file that already existed", async () => {
    const repo = await repoWith("README.md", "seed\n");
    await writeFile(join(repo, "scratch.txt"), "kept\n");
    const before = await captureWorktree(repo);
    await writeFile(join(repo, "scratch.txt"), "kept\nthis turn\n");
    const changes = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(summarize(changes)).toEqual([{ path: "scratch.txt", change: "modified", additions: 1, deletions: 0 }]);
  });

  it("omits a dirty tracked file and an existing untracked file when the turn does not change them", async () => {
    const repo = await repoWith("note.txt", "committed\n");
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\n");
    await writeFile(join(repo, "scratch.txt"), "kept\n");
    const before = await captureWorktree(repo);
    await writeFile(join(repo, "fresh.txt"), "this turn\n");
    const changes = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(summarize(changes)).toEqual([{ path: "fresh.txt", change: "added", additions: 1, deletions: 0 }]);
  });

  it("omits a file whose content is unchanged when the turn only stages it or commits the dirt that was already there", async () => {
    const repo = await repoWith("note.txt", "committed\n");
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\n");
    await writeFile(join(repo, "scratch.txt"), "kept\n");
    const before = await captureWorktree(repo);
    await exec("git", ["add", "note.txt", "scratch.txt"], { cwd: repo });
    const staged = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(staged).toEqual([]);
    await commit(repo, "record existing dirt");
    const committed = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(committed).toEqual([]);
  });

  it("keeps the lines written during a turn that also commits that edit", async () => {
    const repo = await repoWith("note.txt", "committed\n");
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\n");
    const before = await captureWorktree(repo);
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\nthis turn\n");
    await exec("git", ["add", "note.txt"], { cwd: repo });
    await commit(repo, "edit and commit");
    const changes = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(summarize(changes)).toEqual([{ path: "note.txt", change: "modified", additions: 1, deletions: 0 }]);
    expect(changes[0]?.afterText).toContain("this turn");
    expect(changes[0]?.beforeText).toContain("already dirty");
  });

  it("records a file deleted during the turn and ignores another dirty file left untouched", async () => {
    const repo = await repoWith("note.txt", "committed\n");
    await writeFile(join(repo, "note.txt"), "committed\nalready dirty\n");
    await writeFile(join(repo, "scratch.txt"), "gone\n");
    const before = await captureWorktree(repo);
    await exec("git", ["clean", "-f", "scratch.txt"], { cwd: repo });
    const changes = await diffWorktrees(repo, before, await captureWorktree(repo));
    expect(summarize(changes)).toEqual([{ path: "scratch.txt", change: "deleted", additions: 0, deletions: 1 }]);
  });
});

function summarize(changes: TurnChange[]) {
  return changes.map(({ path, change, additions, deletions }) => ({ path, change, additions, deletions }));
}

async function repoWith(path: string, content: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "prentice-turn-"));
  directories.push(repo);
  await writeFile(join(repo, path), content);
  await exec("git", ["init"], { cwd: repo });
  await exec("git", ["add", path], { cwd: repo });
  await commit(repo, "init");
  return repo;
}

function commit(repo: string, message: string) {
  return exec("git", ["-c", "user.email=prentice@local", "-c", "user.name=Prentice", "commit", "-m", message], { cwd: repo });
}
