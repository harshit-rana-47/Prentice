import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const label = "com.prentice.connector";

/** Login item for the Mac app. A clean exit does not restart, so a second click cannot loop. */
export function launchAgentPlist(executable: string): string {
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
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
</dict>
</plist>
`;
}

type Command = (command: string, args: string[]) => string;

export function installLaunchAgent(
  executable: string,
  options: { directory?: string; run?: Command } = {},
): void {
  const directory = options.directory ?? join(homedir(), "Library", "LaunchAgents");
  const run = options.run ?? defaultRun;
  mkdirSync(directory, { recursive: true });
  const file = join(directory, `${label}.plist`);
  writeFileSync(file, launchAgentPlist(executable), { mode: 0o644 });
  const domain = `gui/${userInfo().uid}`;
  const target = `${domain}/${label}`;
  const current = run("launchctl", ["print", target]);
  if (current.includes(executable)) return;
  if (current) run("launchctl", ["bootout", target]);
  run("launchctl", ["bootstrap", domain, file]);
}

function defaultRun(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: "utf8" });
  } catch {
    return "";
  }
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
