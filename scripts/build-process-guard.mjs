import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync, rmSync } from "node:fs";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = process.argv[2] || join(root, "dist/native", process.platform === "win32" ? "process-guard.exe" : "process-guard");
mkdirSync(dirname(target), { recursive: true });
const source = join(root, "apps/connector/native/process-guard.c");
if (process.platform === "win32") {
  const object = join(dirname(target), "process-guard.obj");
  try {
    execFileSync("cl", ["/nologo", "/O2", "/MT", source, `/Fo${object}`, `/Fe${target}`], { cwd: dirname(target), stdio: "inherit" });
  } finally {
    // The object file is a compiler intermediate, never an installer payload.
    rmSync(object, { force: true });
  }
}
else execFileSync("cc", ["-O2", ...(process.platform === "darwin" ? ["-arch", "arm64", "-arch", "x86_64"] : []), source, "-o", target], { stdio: "inherit" });
