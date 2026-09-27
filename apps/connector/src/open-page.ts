import { execFile } from "node:child_process";

type Run = (command: string, args: string[]) => void;

/** Opens the pairing page in the browser on this computer. */
export function openLocalPage(url: string, platform = process.platform, run: Run = defaultRun): void {
  if (!url) return;
  if (platform === "darwin") {
    run("open", [url]);
    return;
  }
  if (platform === "win32") {
    run("cmd", ["/c", "start", "", url]);
    return;
  }
  throw new Error("Prentice opens its pairing page on macOS and Windows.");
}

function defaultRun(command: string, args: string[]): void {
  execFile(command, args, () => undefined);
}
