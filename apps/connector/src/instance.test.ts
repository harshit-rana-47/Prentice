import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimSingleInstance } from "./instance.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("packaged connector lock", () => {
  it("lets the first process keep the Mac and replaces a dead lock", async () => {
    const home = await mkdtemp(join(tmpdir(), "prentice-lock-"));
    directories.push(home);
    expect(claimSingleInstance(home)).toBe(true);
    expect(claimSingleInstance(home)).toBe(false);
    await writeFile(join(home, "connector.lock"), "not-a-pid");
    expect(claimSingleInstance(home)).toBe(true);
  });
});
