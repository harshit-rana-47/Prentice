import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { APP_VERSION, assertNode, bundleConnector, copyRuntimeModules, isRelease, macNodeBinary, publicConfig, root, writeManifest } from "./package-common.mjs";

assertNode();
if (isRelease() && (!process.env.PRENTICE_MAC_SIGN_IDENTITY || !process.env.PRENTICE_MAC_NOTARY_PROFILE)) throw new Error("Mac release requires a Developer ID signing identity and notarization profile. Use a development build for unsigned validation.");
const { cloudUrl, websiteUrl, channel } = publicConfig();
// Build outside synced folders: iCloud can reattach Finder metadata during signing.
const staging = mkdtempSync(join(tmpdir(), "prentice-mac-package-"));
const app = join(staging, "Prentice.app");
const resources = join(app, "Contents", "Resources");
const macos = join(app, "Contents", "MacOS");
const folderPicker = join(app, "Contents", "Helpers", "Prentice Folder Picker.app");

rmSync(join(root, "dist", "Prentice.app"), { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(macos, { recursive: true });

bundleConnector(join(resources, "connector.mjs"));
execFileSync(process.execPath, [join(root, "scripts/build-process-guard.mjs"), join(resources, "process-guard")], { stdio: "inherit" });

execFileSync(process.execPath, [join(root, "scripts/build-folder-picker.mjs"), folderPicker], { stdio: "inherit" });

macNodeBinary(join(resources, "node"));
copyRuntimeModules(join(resources, "node_modules"), "darwin");

writeFileSync(join(resources, "prentice.config.json"), JSON.stringify({ cloudUrl, websiteUrl }, null, 2), { mode: 0o644 });
writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(), { mode: 0o644 });
const executable = join(macos, "Prentice");
writeFileSync(executable, launcher(), { mode: 0o755 });
chmodSync(executable, 0o755);

const signed = signIfConfigured();
const zip = join(root, "dist", "Prentice-Mac.zip");
rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
if (signed && process.env.PRENTICE_MAC_NOTARY_PROFILE) {
  // Apple notarizes the zip, then the ticket is stapled to the app and the zip is rebuilt with it.
  execFileSync("xcrun", ["notarytool", "submit", zip, "--keychain-profile", process.env.PRENTICE_MAC_NOTARY_PROFILE, "--wait"], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "staple", app], { stdio: "inherit" });
  execFileSync("xcrun", ["stapler", "validate", app], { stdio: "inherit" });
  execFileSync("spctl", ["--assess", "--type", "execute", "--verbose", app], { stdio: "inherit" });
  rmSync(zip, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
}
writeManifest([{ platform: "mac", file: "Prentice-Mac.zip", channel, cloudUrl, signed: signed ? (process.env.PRENTICE_MAC_NOTARY_PROFILE ? "notarized" : "signed") : "unsigned" }]);
rmSync(staging, { recursive: true, force: true });
console.log(`Packaged ${zip} (${channel}, ${signed ? "signed" : "unsigned"})`);

/**
 * Sign nested code before the bundle. Beta builds use an ad-hoc integrity seal, which
 * does not identify a trusted developer or remove the need for Gatekeeper approval.
 */
function signIfConfigured() {
  const identity = process.env.PRENTICE_MAC_SIGN_IDENTITY;
  if (!identity && channel !== "beta") return false;
  const entitlements = join(root, "dist", "prentice-node.entitlements");
  writeFileSync(entitlements, nodeEntitlements());
  const sign = (target, extra = []) =>
    execFileSync("codesign", ["--force", ...(identity ? ["--timestamp", "--options", "runtime"] : []), "--sign", identity || "-", ...extra, target], { stdio: "inherit" });
  for (const file of walk(join(resources, "node_modules")).filter((path) => path.endsWith(".node"))) sign(file);
  sign(folderPicker);
  sign(join(resources, "process-guard"));
  sign(join(resources, "node"), ["--entitlements", entitlements]);
  sign(executable);
  sign(app);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  return Boolean(identity);
}

function walk(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function nodeEntitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
</dict>
</plist>
`;
}

function launcher() {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    'MACOS="$(cd "$(dirname "$0")" && pwd)"',
    'APP="$(cd "$MACOS/../.." && pwd)"',
    'RESOURCES="$MACOS/../Resources"',
    'TARGET="${HOME}/Applications/Prentice.app"',
    'if [ "$APP" != "$TARGET" ]; then',
    '  mkdir -p "${HOME}/Applications"',
    '  rm -rf "$TARGET"',
    '  cp -R "$APP" "$TARGET"',
    '  chmod -R u+rwX "$TARGET"',
    '  open "$TARGET"',
    "  exit 0",
    "fi",
    "export PRENTICE_PACKAGED=1",
    'export PRENTICE_APP_PATH="$APP"',
    'export PRENTICE_CONFIG="$RESOURCES/prentice.config.json"',
    'export NODE_OPTIONS="--experimental-sqlite"',
    'exec "$RESOURCES/node" "$RESOURCES/connector.mjs"',
    "",
  ].join("\n");
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Prentice</string>
  <key>CFBundleDisplayName</key>
  <string>Prentice</string>
  <key>CFBundleIdentifier</key>
  <string>com.prentice.connector</string>
  <key>CFBundleVersion</key>
  <string>${APP_VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${APP_VERSION}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>Prentice</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.5</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}
