import { cpSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function assertNode() {
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 13)) {
    throw new Error("Packaging Prentice needs Node.js 22.13 or newer, because the connector uses the built-in SQLite module.");
  }
}

export function publicConfig() {
  const env = readEnv(join(root, ".env"));
  const cloudUrl = process.env.PRENTICE_CLOUD_URL || env.PRENTICE_CLOUD_URL || "";
  const websiteUrl = process.env.PRENTICE_WEBSITE_URL || env.PRENTICE_WEBSITE_URL || "http://127.0.0.1:3000";
  if (!cloudUrl) throw new Error("Set PRENTICE_CLOUD_URL before packaging Prentice.");
  return { cloudUrl, websiteUrl };
}

export function bundleConnector(outfile) {
  const esbuild = join(root, "node_modules", "esbuild", "bin", "esbuild");
  execFileSync(
    esbuild,
    [
      join(root, "apps", "connector", "src", "main.ts"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node22",
      `--outfile=${outfile}`,
      "--external:tree-sitter",
      "--external:tree-sitter-javascript",
      "--external:tree-sitter-typescript",
      "--external:@openai/codex-sdk",
      "--external:@anthropic-ai/claude-agent-sdk",
      "--external:@cursor/sdk",
    ],
    { stdio: "inherit" },
  );
}

export function copyRuntimeModules(nodeModules) {
  mkdirSync(nodeModules, { recursive: true });
  const seen = new Set();
  for (const name of ["tree-sitter", "tree-sitter-javascript", "tree-sitter-typescript", "@openai/codex-sdk"]) {
    copyPackage(name, nodeModules, seen);
  }
}

function copyPackage(name, destRoot, seen) {
  if (seen.has(name)) return;
  const manifest = packageManifest(name);
  if (!manifest) return;
  seen.add(name);
  const source = dirname(manifest);
  const destination = join(destRoot, name);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  for (const dependency of Object.keys(pkg.dependencies ?? {})) copyPackage(dependency, destRoot, seen);
}

function packageManifest(name) {
  const starts = [join(root, "apps", "connector"), root];
  for (const start of starts) {
    let directory = start;
    while (directory !== dirname(directory)) {
      const candidate = join(directory, "node_modules", name, "package.json");
      if (existsSync(candidate)) return candidate;
      directory = dirname(directory);
    }
  }
  return "";
}

function readEnv(file) {
  const values = {};
  if (!existsSync(file)) return values;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const key = trimmed.slice(0, trimmed.indexOf("=")).trim();
    let value = trimmed.slice(trimmed.indexOf("=") + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (key && !(key in values)) values[key] = value;
  }
  return values;
}
