import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertNode, bundleConnector, copyRuntimeModules, publicConfig, root, windowsNodeBinary, writeManifest } from "./package-common.mjs";

assertNode();
const { cloudUrl, websiteUrl, channel } = publicConfig();
const stage = join(root, "dist", "windows-stage");
const app = join(stage, "Prentice");
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

windowsNodeBinary(join(app, "node.exe"));

bundleConnector(join(app, "connector.mjs"));
copyRuntimeModules(join(app, "node_modules"));
writeFileSync(join(app, "prentice.config.json"), JSON.stringify({ cloudUrl, websiteUrl }, null, 2));
writeFileSync(join(app, "Prentice.cmd"), windowsLauncher(), { mode: 0o755 });
chmodSync(join(app, "Prentice.cmd"), 0o755);

const zip = join(root, "dist", "Prentice-Windows.zip");
rmSync(zip, { force: true });
// Plain zip without macOS metadata (ditto adds ._ AppleDouble files that are junk on Windows).
execFileSync("zip", ["-qrX", zip, "Prentice"], { cwd: stage, stdio: "inherit" });
// Authenticode signs executables and installers, not .cmd files. A signed Windows release needs an installer
// (MSI or MSIX) or an .exe launcher; PRENTICE_WIN_SIGN_COMMAND is the hook for that step, run with the file path.
writeManifest([{ platform: "windows", file: "Prentice-Windows.zip", channel, cloudUrl, signed: "unsigned" }]);
console.log(`Packaged ${zip} (${channel}, unsigned)`);

function windowsLauncher() {
  return [
    "@echo off",
    "setlocal",
    'set "HERE=%~dp0"',
    'set "HOMEAPP=%LOCALAPPDATA%\\Prentice\\"',
    'if /I not "%HERE%"=="%HOMEAPP%" (',
    '  if not exist "%HOMEAPP%" mkdir "%HOMEAPP%"',
    '  robocopy "%HERE%" "%HOMEAPP%" /E /NFL /NDL /NJH /NJS /nc /ns /np >nul',
    "  if errorlevel 8 exit /b 1",
    '  start "" "%HOMEAPP%Prentice.cmd"',
    "  exit /b 0",
    ")",
    "set PRENTICE_PACKAGED=1",
    'set "PRENTICE_APP_PATH=%HERE%"',
    'set "PRENTICE_CONFIG=%HERE%prentice.config.json"',
    "set NODE_OPTIONS=--experimental-sqlite",
    '"%HERE%node.exe" "%HERE%connector.mjs"',
    "",
  ].join("\r\n");
}
