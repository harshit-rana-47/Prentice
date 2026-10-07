import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The Node runtime shipped inside the desktop app. Pinned to an LTS release and downloaded from nodejs.org with
 * its published SHA-256, so the app never depends on the Node that happens to run this script.
 * The connector uses node:sqlite and N-API addons only. Coding agents run as their own programs.
 */
export const NODE_VERSION = "24.21.0";
export const APP_VERSION = JSON.parse(readFileSync(join(root, "apps", "connector", "package.json"), "utf8")).version;

export function assertNode() {
  const nodeVersion = process.versions.node.split(".").map(Number);
  if (nodeVersion[0] < 22 || (nodeVersion[0] === 22 && nodeVersion[1] < 13)) {
    throw new Error("Packaging Prentice needs Node.js 22.13 or newer to run the build tools.");
  }
}

export function isRelease() {
  return process.argv.includes("--release") || process.env.PRENTICE_RELEASE === "1";
}

/**
 * Public addresses baked into the app. A release build must point at the hosted relay and website over https.
 * Secrets are never copied.
 */
export function publicConfig() {
  const env = readEnv(join(root, ".env"));
  const cloudUrl = process.env.PRENTICE_CLOUD_URL || env.PRENTICE_CLOUD_URL || "";
  const websiteUrl = process.env.PRENTICE_WEBSITE_URL || env.PRENTICE_WEBSITE_URL || "http://127.0.0.1:3000";
  if (!cloudUrl) throw new Error("Set PRENTICE_CLOUD_URL before packaging Prentice.");
  if (isRelease()) {
    for (const [name, value] of [
      ["PRENTICE_CLOUD_URL", cloudUrl],
      ["PRENTICE_WEBSITE_URL", websiteUrl],
    ]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
        throw new Error(`A release build needs a public https ${name}. Got ${value}.`);
      }
    }
  } else if (/127\.0\.0\.1|localhost/.test(cloudUrl)) {
    console.warn(`Packaging a development build that talks to ${cloudUrl}. Use --release with public https addresses for users.`);
  }
  return { cloudUrl, websiteUrl, channel: isRelease() ? "release" : "development" };
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
      "--target=node24",
      `--outfile=${outfile}`,
      // createRequire lets bundled CommonJS dependencies load Node built-ins from an ES module.
      "--banner:js=import { createRequire as __prenticeRequire } from 'node:module'; const require = __prenticeRequire(import.meta.url);",
      "--external:tree-sitter",
      "--external:tree-sitter-javascript",
      "--external:tree-sitter-typescript",
    ],
    { stdio: "inherit" },
  );
}

/** Native parser addons only. They ship N-API prebuilds for every platform the app supports. */
export function copyRuntimeModules(nodeModules) {
  mkdirSync(nodeModules, { recursive: true });
  const seen = new Set();
  for (const name of ["tree-sitter", "tree-sitter-javascript", "tree-sitter-typescript"]) {
    copyPackage(name, nodeModules, seen);
  }
}

/** Downloads (once) and verifies an official Node archive. Returns the local archive path. */
export function nodeArchive(file) {
  const cache = join(root, "dist", "node-cache", NODE_VERSION);
  mkdirSync(cache, { recursive: true });
  const sums = join(cache, "SHASUMS256.txt");
  if (!existsSync(sums)) download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sums);
  const expected = readFileSync(sums, "utf8")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === file)?.[0];
  if (!expected) throw new Error(`nodejs.org does not list ${file} for v${NODE_VERSION}.`);
  const target = join(cache, file);
  if (!existsSync(target) || sha256(target) !== expected) download(`https://nodejs.org/dist/v${NODE_VERSION}/${file}`, target);
  const actual = sha256(target);
  if (actual !== expected) {
    rmSync(target, { force: true });
    throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}.`);
  }
  return target;
}

/** A universal (arm64 + x86_64) macOS node binary built from the two official archives. */
export function macNodeBinary(destination) {
  const work = join(root, "dist", "node-cache", NODE_VERSION, "mac");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const slices = [];
  for (const arch of ["arm64", "x64"]) {
    const name = `node-v${NODE_VERSION}-darwin-${arch}`;
    execFileSync("tar", ["-xzf", nodeArchive(`${name}.tar.gz`), "-C", work, `${name}/bin/node`]);
    slices.push(join(work, name, "bin", "node"));
  }
  execFileSync("lipo", ["-create", ...slices, "-output", destination]);
  chmodSync(destination, 0o755);
}

export function windowsNodeBinary(destination) {
  const name = `node-v${NODE_VERSION}-win-x64`;
  const work = join(root, "dist", "node-cache", NODE_VERSION, "win");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  execFileSync("unzip", ["-q", "-o", nodeArchive(`${name}.zip`), `${name}/node.exe`, "-d", work]);
  cpSync(join(work, name, "node.exe"), destination);
}

/** Records what was built so the hosted download page and the release process can verify artifacts. */
export function writeManifest(entries) {
  const file = join(root, "dist", "release-manifest.json");
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { artifacts: {} };
  const next = {
    appVersion: APP_VERSION,
    nodeVersion: NODE_VERSION,
    builtAt: new Date().toISOString(),
    artifacts: { ...existing.artifacts },
  };
  for (const entry of entries) {
    next.artifacts[entry.platform] = {
      file: entry.file,
      sha256: sha256(join(root, "dist", entry.file)),
      channel: entry.channel,
      cloudUrl: entry.cloudUrl,
      signed: entry.signed,
    };
  }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return file;
}

export function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function download(url, target) {
  execFileSync("curl", ["-fsSL", "--retry", "3", "-o", target, url], { stdio: "inherit" });
}

function copyPackage(name, destRoot, seen) {
  if (seen.has(name)) return;
  const manifest = packageManifest(name);
  if (!manifest) throw new Error(`Packaging needs ${name}. Run npm install first.`);
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
