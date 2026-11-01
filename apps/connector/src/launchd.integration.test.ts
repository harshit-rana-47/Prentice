import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { installLaunchAgent, launchAgentPlist } from "./launch-agent.js";

const enabled = process.platform === "darwin" && process.env.PRENTICE_TEST_LAUNCHD === "1";
// Opt-in only: registers an isolated, temporary job; never touches the user's real job or data.
it.skipIf(!enabled)("upgrades a stopping legacy job and restarts the actual connector after exit 0 and SIGKILL", async () => {
  const root = mkdtempSync(join(tmpdir(), "prentice-launchd-test-"));
  const home = join(root, "home"), logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  const label = `com.prentice.connector.test.${process.pid}`;
  const domain = `gui/${userInfo().uid}`, target = `${domain}/${label}`;
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  const executable = join(root, "connector-service");
  const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  writeFileSync(executable, `#!/bin/sh\n${Object.entries({
    PRENTICE_HOME: home, PRENTICE_PACKAGED: "1", PRENTICE_CONFIG: "", PRENTICE_APP_PATH: "", PRENTICE_DEV_HTTP: "0",
    PRENTICE_INSTALL_LOGIN_ITEM: "0", PRENTICE_PAIR_PORT: String(port), PRENTICE_CLOUD_URL: "http://127.0.0.1:1",
    PRENTICE_PAIRING_CODE: "", PRENTICE_REVEAL_PAIRING: "0", NODE_OPTIONS: "--experimental-sqlite",
  }).map(([key, value]) => `export ${key}=${quote(value)}`).join("\n")}\nexec ${quote(process.execPath)} --import ${quote(loader)} ${quote(join(import.meta.dirname, "main.ts"))}\n`, { mode: 0o700 });
  const plist = join(root, `${label}.plist`);
  const oldExecutable = join(root, "old-service");
  const supervisor = join(root, "old-supervisor.mjs");
  writeFileSync(supervisor, `import {spawn} from 'node:child_process';\nconst child=spawn(${JSON.stringify(process.execPath)},['--import',${JSON.stringify(loader)},${JSON.stringify(join(import.meta.dirname, "main.ts"))}],{stdio:'inherit'});\nprocess.on('SIGTERM',()=>{child.kill('SIGTERM');setTimeout(()=>process.exit(0),2000)});\n`);
  writeFileSync(oldExecutable, readFileSync(executable, "utf8").replace(/exec .*\n$/, `exec ${quote(process.execPath)} ${quote(supervisor)}\n`), { mode: 0o700 });
  const oldPlist = launchAgentPlist(oldExecutable, logs).replaceAll("com.prentice.connector", label);
  writeFileSync(plist, oldPlist);
  const ctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const ready = async (previous = 0) => {
    const end = Date.now() + 25_000;
    while (Date.now() < end) {
      const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(ctl("print", target))?.[1]);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) });
        if (pid && pid !== previous && response.ok) return pid;
      } catch { /* waiting for restart */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Isolated launchd connector did not start or restart");
  };
  try {
    ctl("bootstrap", domain, plist);
    await ready();
    // Reproduce the shipped upgrader's failure with a real, still-stopping job.
    ctl("bootout", target);
    try { ctl("bootstrap", domain, plist); throw new Error("The legacy race was not reproduced"); }
    catch (e) { expect((e as { status?: number }).status).toBe(5); }
    const deadline = Date.now() + 15_000;
    while (true) {
      try { ctl("print", target); }
      catch { break; }
      if (Date.now() > deadline) throw new Error("Legacy fixture did not unload");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    ctl("bootstrap", domain, plist); await ready();
    let unloadChecks = 0, upgrading = false;
    const upgraded = await installLaunchAgent(executable, { directory: root, logDirectory: logs, revision: "upgrade-test", run: (_command, args) => {
      const translated = args.map(arg => arg.replaceAll(`com.prentice.connector`, label));
      if (args[0] === "bootout") upgrading = true;
      if (args[0] === "print" && upgrading) unloadChecks++;
      if (args[0] === "bootstrap") {
        writeFileSync(plist, readFileSync(args[2], "utf8").replaceAll("com.prentice.connector", label));
        translated[2] = plist;
      }
      try { return ctl(...translated); }
      catch (e) { if (args[0] === "print" && (e as {status?: number}).status === 113) return ""; throw e; }
    } });
    expect(unloadChecks).toBeGreaterThan(2);
    const first = await ready(); expect(first).toBe(upgraded);
    process.kill(first, "SIGTERM");
    const second = await ready(first);
    expect(second).not.toBe(first);
    expect(readFileSync(join(logs, "connector.log"), "utf8")).toContain('"code":0');
    process.kill(second, "SIGKILL");
    const third = await ready(second);
    expect(third).not.toBe(second);
    expect(readFileSync(join(logs, "connector.log"), "utf8").match(/Connector process starting/g)?.length).toBeGreaterThanOrEqual(3);
  } finally {
    try { ctl("bootout", target); } catch { /* bootstrap may have failed */ }
    rmSync(root, { recursive: true, force: true });
  }
}, 90_000);
