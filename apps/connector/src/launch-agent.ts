import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { log } from "./log.js";

const label = "com.prentice.connector";

/** Only launchd owns the long-lived connector; opening the app starts this job. */
export function launchAgentPlist(executable: string, logDirectory?: string, revision?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(executable)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>KeepAlive</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRENTICE_LAUNCH_AGENT</key>
    <string>1</string>
    <key>PRENTICE_REVEAL_PAIRING</key>
    <string>0</string>
${revision ? `    <key>PRENTICE_APP_VERSION</key>\n    <string>${escapeXml(revision)}</string>\n` : ""}  </dict>
${logDirectory ? `  <key>StandardOutPath</key>
  <string>${escapeXml(join(logDirectory, "startup.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logDirectory, "startup.log"))}</string>
` : ""}  <key>Umask</key>
  <integer>63</integer>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

type Command = (command: string, args: string[]) => string;
export interface LaunchAgentOptions {
  directory?: string; logDirectory?: string; revision?: string; run?: Command;
  wait?: () => Promise<void>; timeoutMs?: number;
}

export async function installLaunchAgent(
  executable: string,
  options: LaunchAgentOptions = {},
): Promise<number> {
  const directory = options.directory ?? join(homedir(), "Library", "LaunchAgents");
  const run = options.run ?? defaultRun;
  const file = join(directory, `${label}.plist`);
  const desired = launchAgentPlist(executable, options.logDirectory, options.revision);
  const wait = options.wait ?? (() => new Promise<void>(resolve => setTimeout(resolve, 100)));
  const until = async <T>(check: () => T | undefined, message: string): Promise<T> => {
    const deadline = Date.now() + (options.timeoutMs ?? 15_000);
    do {
      const value = check();
      if (value !== undefined) return value;
      if (Date.now() >= deadline) break;
      await wait();
    } while (true);
    throw new Error(message);
  };
  mkdirSync(directory, { recursive: true });
  // Separate Finder launches must not unload/bootstrap the same job concurrently.
  // A crashed installer leaves an owner PID that a subsequent launch can reclaim.
  const lock = `${file}.lock`;
  const startedAt = (pid: number): string | undefined => {
    try { return execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 1_000 }).trim() || undefined; }
    catch { return undefined; }
  };
  const ownStart = startedAt(process.pid);
  await until(() => {
    try {
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(join(lock, "pid"), JSON.stringify({ pid: process.pid, startedAt: ownStart }), { mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        const value = JSON.parse(readFileSync(join(lock, "pid"), "utf8")) as number | { pid: number; startedAt?: string };
        const owner = typeof value === "number" ? { pid: value } : value;
        if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
            const currentStart = startedAt(owner.pid);
            // PIDs can be reused after a crash/reboot; an unrelated process is not
            // evidence that the previous installer still owns this lock.
            if (owner.startedAt && currentStart && owner.startedAt !== currentStart) rmSync(lock, { recursive: true, force: true });
          }
          catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") rmSync(lock, { recursive: true }); }
        }
      } catch (e) {
        if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === "ENOENT") {
          try { if (Date.now() - statSync(lock).mtimeMs > 30_000) rmSync(lock, { recursive: true, force: true }); }
          catch (missing) { if ((missing as NodeJS.ErrnoException).code !== "ENOENT") throw missing; }
        } else throw e;
      }
      return undefined;
    }
  }, "Another Prentice installation is still changing its background service. Close that installer and try again.");
  try {
    if (options.logDirectory) mkdirSync(options.logDirectory, { recursive: true, mode: 0o700 });
    let unchanged = false;
    try {
      unchanged = readFileSync(file, "utf8") === desired;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    // Rewriting even identical LaunchAgent files can notify Background Task
    // Management. Leave the registration untouched on ordinary launches.
    if (!unchanged) {
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, desired, { mode: 0o644 });
      renameSync(temporary, file);
    }
    const domain = `gui/${userInfo().uid}`;
    const target = `${domain}/${label}`;
    const current = run("launchctl", ["print", target]);
    if (unchanged && current.includes(executable)) {
      // A job can be loaded for days with no live process after a successful exit.
      // kickstart without -k starts a stopped job without interrupting a running one.
      if (!/^\s*pid = \d+\s*$/m.test(current)) run("launchctl", ["kickstart", target]);
    } else {
      if (current) {
        log("info", "Stopping the previous background service before upgrade", { revision: options.revision });
        run("launchctl", ["bootout", target]);
        // bootout acknowledges the request before launchd has removed the old job.
        // A bootstrap during that interval fails with EIO / EINPROGRESS (37).
        await until(() => run("launchctl", ["print", target]) ? undefined : true,
          "macOS has not finished stopping the previous Prentice service. Check startup.log and try again.");
      }
      log("info", "Registering the background service", { revision: options.revision });
      run("launchctl", ["bootstrap", domain, file]);
    }
    return await until(() => {
      const loaded = run("launchctl", ["print", target]);
      const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(loaded)?.[1]);
      return loaded.includes(executable) && pid > 0 ? pid : undefined;
    }, "Prentice's background service was registered but did not start. Check Login Items & Extensions and ~/.prentice/logs/startup.log.");
  } finally { rmSync(lock, { recursive: true, force: true }); }
}

function defaultRun(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (args[0] === "print" && status === 113) return ""; // service not registered
    const detail = String((error as { stderr?: unknown }).stderr ?? "").trim().slice(0, 1_000);
    throw new Error(`launchctl ${args[0]} failed (exit ${status ?? "unknown"})${detail ? `: ${detail}` : "."} Check macOS Login Items & Extensions.`);
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
