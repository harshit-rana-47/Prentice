import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installLaunchAgent, launchAgentPlist } from "./launch-agent.js";

const directories: string[] = [];
const executable = "/Users/ada/Applications/Prentice.app/Contents/MacOS/Prentice";
async function fixture(contents?: string) {
  const directory = await mkdtemp(join(tmpdir(), "prentice-agent-")); directories.push(directory);
  const file = join(directory, "com.prentice.connector.plist");
  if (contents) await writeFile(file, contents);
  let loaded = !!contents, pid = loaded ? 101 : 0, removing = 0, boots = 0;
  const calls: string[][] = [];
  const run = (_command: string, args: string[]) => {
    calls.push(args);
    if (args[0] === "print") {
      if (removing && --removing === 0) { loaded = false; pid = 0; }
      return loaded ? `program = ${executable}\n${pid ? ` pid = ${pid}\n` : ' state = not running\n last exit code = 0'}` : "";
    }
    if (args[0] === "bootout") { removing = 3; return ""; }
    if (args[0] === "bootstrap") {
      if (loaded || removing) throw new Error("Operation already in progress");
      boots++; loaded = true; pid = 202; return "";
    }
    if (args[0] === "kickstart") pid = 303;
    return "";
  };
  return { directory, file, calls, run, wait: async () => {}, stopped: () => { pid = 0; }, boots: () => boots };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe("login item", () => {
  it("starts at login and survives clean exits and crashes", () => {
    const plist = launchAgentPlist(executable);
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>PRENTICE_LAUNCH_AGENT</key>");
    expect(plist).toContain("<key>RunAtLoad</key>");
  });
  it("starts a registered stopped job", async () => {
    const f = await fixture(launchAgentPlist(executable)); f.stopped();
    expect(await installLaunchAgent(executable, f)).toBe(303);
    expect(f.calls.map(a => a[0])).toEqual(["print", "kickstart", "print"]);
  });
  it("loads a missing job and verifies a live PID", async () => {
    const f = await fixture(); expect(await installLaunchAgent(executable, f)).toBe(202);
    expect(await readFile(f.file, "utf8")).toBe(launchAgentPlist(executable));
    expect(f.calls.map(a => a[0])).toEqual(["print", "bootstrap", "print"]);
  });
  it("does not rewrite or restart an unchanged running job", async () => {
    const f = await fixture(launchAgentPlist(executable)); await utimes(f.file, new Date(0), new Date(0));
    await installLaunchAgent(executable, f); await installLaunchAgent(executable, f);
    expect((await stat(f.file)).mtimeMs).toBe(0);
    expect(f.calls.every(a => a[0] === "print")).toBe(true);
  });
  it("waits for asynchronous bootout removal before bootstrapping an upgrade", async () => {
    const f = await fixture(launchAgentPlist(executable).replace("<integer>10</integer>", "<integer>20</integer>"));
    expect(await installLaunchAgent(executable, f)).toBe(202);
    expect(f.calls.map(a => a[0])).toEqual(["print", "bootout", "print", "print", "print", "bootstrap", "print"]);
    expect(await readFile(f.file, "utf8")).toBe(launchAgentPlist(executable));
  });
  it("restarts the old runtime when a new app version replaces the same path", async () => {
    const f = await fixture(launchAgentPlist(executable, undefined, "0.1.2"));
    await installLaunchAgent(executable, { ...f, revision: "0.1.3" });
    expect(f.boots()).toBe(1); expect(await readFile(f.file, "utf8")).toContain("0.1.3");
  });
  it("serializes concurrent app opens so only one job is bootstrapped", async () => {
    const f = await fixture();
    expect(await Promise.all([installLaunchAgent(executable, f), installLaunchAgent(executable, f)])).toEqual([202, 202]);
    expect(f.boots()).toBe(1);
  });
  it("reclaims a lock whose owner has terminated", async () => {
    const f = await fixture(); await mkdir(f.file + ".lock"); await writeFile(join(f.file + ".lock", "pid"), "2147483647");
    expect(await installLaunchAgent(executable, f)).toBe(202);
  });
  it("does not mistake a reused PID for an installer that is still running", async () => {
    const f = await fixture(); await mkdir(f.file + ".lock");
    await writeFile(join(f.file + ".lock", "pid"), JSON.stringify({ pid: process.pid, startedAt: "previous boot" }));
    expect(await installLaunchAgent(executable, f)).toBe(202);
  });
  it("does not bootstrap while the old job is still stopping", async () => {
    const f = await fixture("old plist");
    await expect(installLaunchAgent(executable, { ...f, timeoutMs: 0, run: (_c, a) => { f.calls.push(a); return executable; } })).rejects.toThrow("not finished stopping");
    expect(f.calls.some(a => a[0] === "bootstrap")).toBe(false);
  });
  it("does not mistake registration without a PID for successful startup", async () => {
    const f = await fixture();
    await expect(installLaunchAgent(executable, { ...f, timeoutMs: 0, run: (_c, a) => a[0] === "print" ? "" : "" })).rejects.toThrow("did not start");
  });
  it("surfaces failed bootstrap and releases its lock for a later retry", async () => {
    const f = await fixture();
    await expect(installLaunchAgent(executable, { ...f, run: (_c, a) => { if (a[0] === "bootstrap") throw new Error("bootstrap failed"); return ""; } })).rejects.toThrow("bootstrap failed");
    expect(await installLaunchAgent(executable, f)).toBe(202);
  });
});
