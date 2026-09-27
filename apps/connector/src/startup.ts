import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLaunchAgent } from "./launch-agent.js";

type Command = (command: string, args: string[]) => string;

/** Starts Prentice when the person signs in to this computer. */
export function installLoginItem(executable: string, options: { directory?: string; run?: Command } = {}): void {
  if (process.platform === "darwin") {
    installLaunchAgent(executable, options);
    return;
  }
  if (process.platform === "win32") {
    installWindowsStartup(executable, options);
    return;
  }
  throw new Error("Prentice starts at sign-in on macOS and Windows.");
}

export function windowsLogonTask(executable: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions>
    <Exec>
      <Command>${escapeXml(executable)}</Command>
    </Exec>
  </Actions>
</Task>
`;
}

export function installWindowsStartup(executable: string, options: { directory?: string; run?: Command } = {}): void {
  const directory = options.directory ?? join(homedir(), "AppData", "Local", "Prentice");
  const run = options.run ?? defaultRun;
  mkdirSync(directory, { recursive: true });
  const xml = join(directory, "prentice-logon.xml");
  writeFileSync(xml, `\uFEFF${windowsLogonTask(executable)}`, { encoding: "utf16le" });
  run("schtasks", ["/Create", "/TN", "Prentice", "/XML", xml, "/F"]);
}

function defaultRun(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" });
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return entities[character] ?? character;
  });
}
