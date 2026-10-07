import { execFile } from "node:child_process";

type Runner = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const macScript = 'POSIX path of (choose folder with prompt "Choose a project folder")';
const windowsScript = [
  "Add-Type -AssemblyName System.Windows.Forms",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
  "$dialog.Description = 'Choose a project folder'",
  "$dialog.UseDescriptionForTitle = $true",
  "$result = $dialog.ShowDialog()",
  "if ($result -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
].join("; ");

/** How long the folder window may stay open before Prentice gives up and says so. */
export const FOLDER_DIALOG_TIMEOUT_MS = 5 * 60_000;

/** Opens the system folder dialog. A cancel returns null. The website never receives a typed path. */
export async function chooseFolder(run: Runner = defaultRun): Promise<string | null> {
  return chooseFolderOn(process.platform, run);
}

export async function chooseFolderOn(platform: NodeJS.Platform, run: Runner): Promise<string | null> {
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error("Choosing a folder is available on macOS and Windows.");
  }
  try {
    const result =
      platform === "win32"
        ? await run("powershell.exe", ["-NoProfile", "-STA", "-Command", windowsScript])
        : await run("osascript", ["-e", macScript]);
    const path = result.stdout.trim();
    if (path.length <= 3) return path || null;
    return path.replace(/[\\/]+$/, "") || null;
  } catch (error) {
    const detail = errorText(error);
    if (/user canceled|-128|cancel/i.test(detail)) return null;
    if (error && typeof error === "object" && "killed" in error && (error as { killed?: boolean }).killed) {
      throw new Error("The folder window on this computer was open too long without a choice. Choose the folder again when you are at this computer.");
    }
    throw new Error("The folder dialog could not be opened on this computer.");
  }
}

function defaultRun(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: FOLDER_DIALOG_TIMEOUT_MS, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stderr?: string };
        failure.stderr = stderr;
        reject(failure);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
  return `${error.message}\n${stderr}`;
}
