import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const label = "com.prentice.connector";

/** Only launchd owns the long-lived connector; opening the app starts this job. */
export function launchAgentPlist(executable: string, logDirectory?: string): string {
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
  </dict>
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

export function installLaunchAgent(
  executable: string,
  options: { directory?: string; logDirectory?: string; run?: Command } = {},
): void {
  const directory = options.directory ?? join(homedir(), "Library", "LaunchAgents");
  const run = options.run ?? defaultRun;
  const file = join(directory, `${label}.plist`);
  const desired = launchAgentPlist(executable, options.logDirectory);
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
    mkdirSync(directory, { recursive: true });
    writeFileSync(file, desired, { mode: 0o644 });
  }
  const domain = `gui/${userInfo().uid}`;
  const target = `${domain}/${label}`;
  const current = run("launchctl", ["print", target]);
  if (unchanged && current.includes(executable)) {
    // A job can be loaded for days with no live process after a successful exit.
    // kickstart without -k starts a stopped job without interrupting a running one.
    if (!/^\s*pid = \d+\s*$/m.test(current)) run("launchctl", ["kickstart", target]);
    return;
  }
  if (current) run("launchctl", ["bootout", target]);
  run("launchctl", ["bootstrap", domain, file]);
}

function defaultRun(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch (error) {
    const status = (error as { status?: number }).status;
    if (args[0] === "print" && status === 113) return ""; // service not registered
    throw new Error(`launchctl ${args[0]} failed (exit ${status ?? "unknown"}). Check macOS Login Items & Extensions.`);
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
