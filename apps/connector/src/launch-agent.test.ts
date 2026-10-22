import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLaunchAgent, launchAgentPlist } from "./launch-agent.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("login item", () => {
  it("starts at login and stays down after a clean exit", () => {
    const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
    const plist = launchAgentPlist(executable);
    expect(plist).toContain(executable);
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });

  it("loads the agent once for the installed app", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prentice-agent-"));
    directories.push(directory);
    const calls: string[][] = [];
    const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
    installLaunchAgent(executable, {
      directory,
      run(command, args) {
        calls.push([command, ...args]);
        return "";
      },
    });
    const plist = await readFile(join(directory, "com.prentice.connector.plist"), "utf8");
    expect(plist).toContain(executable);
    expect(calls.map((call) => call[1])).toEqual(["print", "bootstrap"]);
  });

  it("leaves an unchanged, loaded login item untouched on repeated launches", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prentice-agent-"));
    directories.push(directory);
    const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
    const file = join(directory, "com.prentice.connector.plist");
    await writeFile(file, launchAgentPlist(executable));
    await utimes(file, new Date(0), new Date(0));
    const before = await stat(file);
    const calls: string[][] = [];
    const run = (_command: string, args: string[]) => { calls.push(args); return executable; };
    installLaunchAgent(executable, { directory, run });
    installLaunchAgent(executable, { directory, run });
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    expect(calls.map(args => args[0])).toEqual(["print", "print"]);
  });

  it("loads a missing job without rewriting its unchanged plist", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prentice-agent-"));
    directories.push(directory);
    const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
    const file = join(directory, "com.prentice.connector.plist");
    await writeFile(file, launchAgentPlist(executable));
    await utimes(file, new Date(0), new Date(0));
    const calls: string[][] = [];
    installLaunchAgent(executable, { directory, run: (_command, args) => { calls.push(args); return ""; } });
    expect((await stat(file)).mtimeMs).toBe(0);
    expect(calls.map(args => args[0])).toEqual(["print", "bootstrap"]);
  });

  it("reloads a changed configuration even when the executable path is unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "prentice-agent-"));
    directories.push(directory);
    const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
    const file = join(directory, "com.prentice.connector.plist");
    await writeFile(file, launchAgentPlist(executable).replace("<integer>10</integer>", "<integer>20</integer>"));
    const calls: string[][] = [];
    installLaunchAgent(executable, { directory, run: (_command, args) => { calls.push(args); return executable; } });
    expect(await readFile(file, "utf8")).toBe(launchAgentPlist(executable));
    expect(calls.map(args => args[0])).toEqual(["print", "bootout", "bootstrap"]);
  });
});
