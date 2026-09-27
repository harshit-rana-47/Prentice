import { cpSync, mkdirSync, rmSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertNode, bundleConnector, copyRuntimeModules, publicConfig, root } from "./package-common.mjs";

assertNode();
const { cloudUrl, websiteUrl } = publicConfig();
const app = join(root, "dist", "Prentice.app");
const resources = join(app, "Contents", "Resources");
const macos = join(app, "Contents", "MacOS");

rmSync(app, { recursive: true, force: true });
mkdirSync(resources, { recursive: true });
mkdirSync(macos, { recursive: true });

bundleConnector(join(resources, "connector.mjs"));

const nodeDest = join(resources, "node");
cpSync(realpathSync(process.execPath), nodeDest);
chmodSync(nodeDest, 0o755);
copyRuntimeModules(join(resources, "node_modules"));

writeFileSync(join(resources, "prentice.config.json"), JSON.stringify({ cloudUrl, websiteUrl }, null, 2), { mode: 0o644 });
writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(), { mode: 0o644 });
const executable = join(macos, "Prentice");
writeFileSync(executable, launcher(), { mode: 0o755 });
chmodSync(executable, 0o755);

const zip = join(root, "dist", "Prentice-Mac.zip");
rmSync(zip, { force: true });
execFileSync("ditto", ["-c", "-k", "--keepParent", app, zip], { stdio: "inherit" });
console.log(`Packaged ${zip}`);

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
  <string>0.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>0.1.0</string>
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
