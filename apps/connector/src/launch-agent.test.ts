import { mkdtemp, readFile, rm } from "node:fs/promises";
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
});
