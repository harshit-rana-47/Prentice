import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { accountStore } from "./account-home.js";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });

it("keeps account projects and history separate and leaves unowned legacy data untouched", () => {
  const home = mkdtempSync(join(tmpdir(), "prentice-accounts-")); homes.push(home);
  const legacy = join(home, "prentice.db");
  writeFileSync(legacy, "unowned legacy history");
  const a = "00000000-0000-4000-8000-000000000001";
  const b = "00000000-0000-4000-8000-000000000002";
  const first = accountStore(home, a);
  const project = first.upsertProject("/private/tmp/account-a", "Account A");
  first.insertTask(project.id, "private prompt for A");
  const second = accountStore(home, b);
  expect(second.listProjects()).toEqual([]);
  expect(second.latestProject()).toBeUndefined();
  expect(accountStore(home, a).listTasks(project.id)[0]?.prompt).toBe("private prompt for A");
  expect(readFileSync(legacy, "utf8")).toBe("unowned legacy history");
  expect(() => accountStore(home, "../../other")).toThrow();
});
