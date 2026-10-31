import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { configureLogFile, log } from "./log.js";

const homes: string[] = [];
afterEach(() => { configureLogFile(); for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
it("persists redacted lifecycle logs with private permissions and bounded rotation", () => {
  const home = mkdtempSync(join(tmpdir(), "prentice-log-")); homes.push(home);
  const file = join(home, "connector.log");
  configureLogFile(file, 400);
  for (let n = 0; n < 12; n++) log("info", "Relay reconnecting", { token: "PRIVATE_SECRET", n });
  expect(readdirSync(home).sort()).toEqual(["connector.log", "connector.log.1"]);
  for (const name of readdirSync(home)) {
    const path = join(home, name);
    expect(statSync(path).size).toBeLessThanOrEqual(400);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain("PRIVATE_SECRET");
    expect(JSON.parse(text.trim().split("\n")[0]!)).toMatchObject({ message: "Relay reconnecting", pid: process.pid });
  }
});
