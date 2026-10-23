import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") throw new Error("The Mac folder picker must be built on macOS.");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const app = process.argv[2] || join(root, "dist/native/Prentice Folder Picker.app");
const contents = join(app, "Contents");
const macos = join(contents, "MacOS");
mkdirSync(macos, { recursive: true });
execFileSync("cc", ["-O2", "-fobjc-arc", "-mmacosx-version-min=13.5", "-arch", "arm64", "-arch", "x86_64",
  join(root, "apps/connector/native/folder-picker.m"), "-framework", "Cocoa", "-o", join(macos, "folder-picker")], { stdio: "inherit" });
writeFileSync(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleName</key><string>Prentice Folder Picker</string>
<key>CFBundleIdentifier</key><string>com.prentice.folder-picker</string>
<key>CFBundleExecutable</key><string>folder-picker</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>13.5</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>\n`);
