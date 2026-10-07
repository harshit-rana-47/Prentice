import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { APP_VERSION, assertNode, bundleConnector, copyRuntimeModules, macNodeBinary, publicConfig, root, writeManifest } from "./package-common.mjs";

assertNode();
const { cloudUrl, websiteUrl, channel } = publicConfig();
const app = join(root, "dist", "Prentice.app");
const resources = join(app, "Contents", "Resources");
const macos = join(app, "Contents", "MacOS");

rmSync(app, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(macos, { recursive: true });

bundleConnector(join(resources, "connector.mjs"));

macNodeBinary(join(resources, "node"));
copyRuntimeModules(join(resources, "node_modules"));

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
  rmSync(zip, { force: true });
  execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
}
writeManifest([{ platform: "mac", file: "Prentice-Mac.zip", channel, cloudUrl, signed: signed ? (process.env.PRENTICE_MAC_NOTARY_PROFILE ? "notarized" : "signed") : "unsigned" }]);
console.log(`Packaged ${zip} (${channel}, ${signed ? "signed" : "unsigned"})`);

/**
 * Developer ID signing with the hardened runtime. Every Mach-O inside the bundle is signed first
 * (the Node runtime and the native parser addons), then the bundle. Runs only when an identity is configured.
 */
function signIfConfigured() {
  const identity = process.env.PRENTICE_MAC_SIGN_IDENTITY;
  if (!identity) return false;
  const entitlements = join(root, "dist", "prentice-node.entitlements");
  writeFileSync(entitlements, nodeEntitlements());
  const sign = (target, extra = []) =>
    execFileSync("codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, ...extra, target], { stdio: "inherit" });
  for (const file of walk(join(resources, "node_modules")).filter((path) => path.endsWith(".node"))) sign(file);
  sign(join(resources, "node"), ["--entitlements", entitlements]);
  sign(executable);
  sign(app);
  execFileSync("codesign", ["--verify", "--deep", "--strict", app], { stdio: "inherit" });
  return true;
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
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
</dict>
</plist>
`;
}
