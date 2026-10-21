import { cpSync, existsSync, chmodSync, mkdirSync, rmSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { APP_VERSION, assertNode, bundleConnector, copyRuntimeModules, isRelease, publicConfig, root, windowsNodeBinary, writeManifest } from "./package-common.mjs";

import { WIX_VERSION, assertWindowsBinary, msiVersion, payloadFiles, payloadSource, signWindows } from "./windows-msi.mjs";

assertNode();
const zipOnly = process.argv.includes("--zip");
const release = isRelease();
if (zipOnly && release) throw new Error("Windows ZIP builds are development-only. Production distribution requires the signed WiX MSI.");
const run = (command, args) => execFileSync(command,args,{stdio:"inherit",shell:false});
const signer = process.env.PRENTICE_WIN_SIGNER || (process.env.PRENTICE_WIN_CERT_SHA1 ? process.execPath : undefined);
const signRun = (command,args) => run(command,command===process.execPath && !process.env.PRENTICE_WIN_SIGNER ? [join(root,"scripts/sign-windows.mjs"),...args] : args);
const wix = process.env.PRENTICE_WIX_EXE || "wix";
if (!zipOnly) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The WiX MSI build requires an x64 Windows build host with Visual C and WiX 7.0.0. No MSI was produced.");
  if (release && !signer) throw new Error("Release MSI requires PRENTICE_WIN_CERT_SHA1 or PRENTICE_WIN_SIGNER. No signing identity is hardcoded.");
  msiVersion(APP_VERSION);
  const version=execFileSync(wix,["--version"],{encoding:"utf8"}).trim();
  if(!version.startsWith(`${WIX_VERSION}+`) && version!==WIX_VERSION) throw new Error(`Install WiX ${WIX_VERSION}; found ${version}.`);
}
const { cloudUrl, websiteUrl, channel } = publicConfig();
const stage = join(root, "dist", "windows-stage");
const app = join(stage, "Prentice");
rmSync(stage, { recursive: true, force: true });
mkdirSync(app, { recursive: true });

if (!zipOnly) {
  run(process.execPath,[join(root,"scripts/build-process-guard.mjs"),join(app,"process-guard.exe")]);
  execFileSync("cl",["/nologo","/O2","/MT","/D_UNICODE","/DUNICODE",join(root,"apps/connector/native/windows-launcher.c"),`/Fo${join(stage,"windows-launcher.obj")}`,`/Fe${join(app,"Prentice.exe")}`,"/link","/SUBSYSTEM:WINDOWS","user32.lib"],{cwd:stage,stdio:"inherit"});
}
const guard = zipOnly ? process.env.PRENTICE_WIN_GUARD_EXE : join(app,"process-guard.exe");
if (!guard || !existsSync(guard)) throw new Error("Build process-guard.exe on Windows with scripts/build-process-guard.mjs and set PRENTICE_WIN_GUARD_EXE. An uncontained Windows package will not be produced.");
if (zipOnly) cpSync(guard, join(app, "process-guard.exe"));
assertWindowsBinary(join(app,"process-guard.exe"));
windowsNodeBinary(join(app, "node.exe"));

bundleConnector(join(app, "connector.mjs"));
copyRuntimeModules(join(app, "node_modules"));
// Ship only the Windows x64 N-API binaries. Other platform prebuilds are not payload.
for (const name of ["tree-sitter","tree-sitter-javascript","tree-sitter-typescript"]) {
  const prebuilds=join(app,"node_modules",name,"prebuilds");
  for(const arch of readdirSync(prebuilds)) if(arch!=="win32-x64") rmSync(join(prebuilds,arch),{recursive:true,force:true});
  rmSync(join(app,"node_modules",name,"build"),{recursive:true,force:true});
}
writeFileSync(join(app, "prentice.config.json"), JSON.stringify({ cloudUrl, websiteUrl }, null, 2));
if (!zipOnly) {
  const binaries=payloadFiles(app).filter(file=>/\.(exe|dll|node)$/i.test(file));
  binaries.forEach(assertWindowsBinary);
  const signed=signWindows(binaries,{signer,run:signRun,release});
  const payload=join(stage,"Payload.wxs");writeFileSync(payload,payloadSource(app));
  const msi=join(stage,"Prentice-Windows.msi");
  run(wix,["build",join(root,"scripts/windows/Prentice.wxs"),payload,"-arch","x64","-d",`AppVersion=${APP_VERSION}`,"-intermediateFolder",join(stage,"wix"),"-o",msi]);
  // Sign the finished MSI only after the already-signed binaries have been embedded.
  signWindows([msi],{signer,run:signRun,release});
  const file=release ? "Prentice-Windows.msi" : "Prentice-Windows-unsigned.msi";
  const target=join(root,"dist",file);rmSync(target,{force:true});renameSync(msi,target);
  writeManifest([{platform:release?"windows":"windows-candidate",file,channel,cloudUrl,signed:signed?"signed":"unsigned",format:"msi",releaseReady:false}]);
  console.log(`Built ${target} (${channel}, ${signed?"signed":"unsigned"}; Windows lifecycle validation still required before hosting)`);
  process.exit(0);
}
writeFileSync(join(app, "Prentice.cmd"), windowsLauncher(), { mode: 0o755 });
chmodSync(join(app, "Prentice.cmd"), 0o755);

const zip = join(root, "dist", "Prentice-Windows.zip");
rmSync(zip, { force: true });
// Plain zip without macOS metadata (ditto adds ._ AppleDouble files that are junk on Windows).
if (process.platform === "win32") run("tar", ["-a", "-cf", zip, "-C", stage, "Prentice"]);
else execFileSync("zip", ["-qrX", zip, "Prentice"], { cwd: stage, stdio: "inherit" });
// This legacy launcher archive is never the production download.
writeManifest([{ platform: "windows-development", file: "Prentice-Windows.zip", channel, cloudUrl, signed: "unsigned" }]);
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
