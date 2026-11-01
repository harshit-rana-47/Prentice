import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin" || !process.argv[2]) throw new Error("Build the Mac service helper on macOS with an output path.");
execFileSync("cc", ["-O2", "-fobjc-arc", "-mmacosx-version-min=13.5", "-arch", "arm64", "-arch", "x86_64",
  join(root, "apps/connector/native/mac-service.m"), "-framework", "Cocoa", "-framework", "ServiceManagement", "-o", process.argv[2]], { stdio: "inherit" });
