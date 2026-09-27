import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installWindowsStartup, windowsLogonTask } from "./startup.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Windows sign-in startup", () => {
  it("runs Prentice when the person signs in and does not start a second copy", async () => {
    const executable = "C:\\Users\\ada\\AppData\\Local\\Prentice\\Prentice.cmd";
    const xml = windowsLogonTask(executable);
    expect(xml).toContain(executable);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("IgnoreNew");
    const directory = await mkdtemp(join(tmpdir(), "prentice-win-"));
    directories.push(directory);
    const calls: string[][] = [];
    installWindowsStartup(executable, {
      directory,
      run(command, args) {
        calls.push([command, ...args]);
        return "";
      },
    });
    const saved = await readFile(join(directory, "prentice-logon.xml"), "utf16le");
    expect(saved).toContain("Prentice.cmd");
    expect(calls[0]?.[0]).toBe("schtasks");
    expect(calls[0]).toContain("/Create");
  });
});
