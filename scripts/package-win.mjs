import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertNode, bundleConnector, copyRuntimeModules, publicConfig, root } from "./package-common.mjs";

assertNode();
const { cloudUrl, websiteUrl } = publicConfig();
const version = process.versions.node;
const stage = join(root, "dist", "windows-stage");
const app = join(stage, "Prentice");
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

const nodeZip = join(stage, `node-v${version}-win-x64.zip`);
const nodeUrl = `https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`;
execFileSync("curl", ["-fsSL", "-o", nodeZip, nodeUrl], { stdio: "inherit" });
execFileSync("unzip", ["-q", nodeZip, "-d", stage], { stdio: "inherit" });
cpSync(join(stage, `node-v${version}-win-x64`, "node.exe"), join(app, "node.exe"));

bundleConnector(join(app, "connector.mjs"));
copyRuntimeModules(join(app, "node_modules"));
writeFileSync(join(app, "prentice.config.json"), JSON.stringify({ cloudUrl, websiteUrl }, null, 2));
writeFileSync(join(app, "Prentice.cmd"), windowsLauncher(), { mode: 0o755 });
chmodSync(join(app, "Prentice.cmd"), 0o755);

const zip = join(root, "dist", "Prentice-Windows.zip");
rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
console.log(`Packaged ${zip}`);

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
