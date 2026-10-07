import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

/** Coding agents Prentice drives. Prentice does not ship them; it finds what the user installed. */
export type AgentId = "claude-code" | "codex" | "cursor";

export interface ResolvedAgent {
  id: AgentId;
  /** What Prentice spawns. For Codex this is the native binary; for Cursor on Windows it is the bundled node. */
  command: string;
  /** Arguments placed before Prentice's own arguments (Cursor on Windows: the CLI entry script). */
  prefixArgs: string[];
  /** The file the user installed, for messages and diagnostics. */
  installed: string;
  /** Environment for the child: the user's environment plus the directories this agent needs. */
  env: NodeJS.ProcessEnv;
  /** Extra PATH entries that the vendor ships next to its binary (Codex's bundled ripgrep). */
  pathDirs: string[];
}

export interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** PATH from a login shell, when it can be read. Supplements the fixed locations; never required. */
  loginShellPath?: string | null;
}

const NAMES: Record<AgentId, string[]> = {
  "claude-code": ["claude"],
  codex: ["codex"],
  cursor: ["cursor-agent", "agent"],
};

/**
 * Directories where the official installers, Homebrew, and npm put agent executables.
 * A packaged app started from Finder, a Login Item, or Windows startup does not get the user's shell PATH,
 * so these are searched directly.
 */
export function knownAgentDirectories(options: DiscoveryOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const env = options.env ?? process.env;
  const dirs: string[] = [];
  const add = (dir: string | undefined) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  for (const entry of (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : ":")) add(entry || undefined);
  for (const entry of (options.loginShellPath ?? "").split(platform === "win32" ? ";" : ":")) add(entry || undefined);
  if (platform === "win32") {
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local");
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming");
    add(join(home, ".local", "bin"));
    add(join(local, "cursor-agent"));
    add(join(roaming, "npm"));
    add(join(local, "Programs", "claude"));
    add(join(local, "pnpm"));
    add(join(home, "scoop", "shims"));
    add(join(local, "Microsoft", "WinGet", "Links"));
    add(env.VOLTA_HOME ? join(env.VOLTA_HOME, "bin") : join(local, "Volta", "bin"));
    return dirs;
  }
  add(join(home, ".local", "bin"));
  add(join(home, ".claude", "local"));
  add("/opt/homebrew/bin");
  add("/usr/local/bin");
  add(join(home, ".npm-global", "bin"));
  add(join(home, ".npm", "bin"));
  add(join(home, ".bun", "bin"));
  add(join(home, ".volta", "bin"));
  add(join(home, "Library", "pnpm"));
  add(join(home, ".local", "share", "pnpm"));
  add(join(home, ".yarn", "bin"));
  add(join(home, ".asdf", "shims"));
  add(join(home, ".local", "share", "mise", "shims"));
  for (const dir of nodeVersionBins(join(home, ".nvm", "versions", "node"))) add(dir);
  for (const dir of nodeVersionBins(join(home, ".local", "state", "fnm_multishells"))) add(dir);
  for (const dir of nodeVersionBins(join(home, "Library", "Application Support", "fnm", "node-versions"), "installation/bin")) add(dir);
  add("/usr/bin");
  add("/bin");
  return dirs;
}

/** Newest version first, so a current nvm/fnm default is preferred over an old one. */
function nodeVersionBins(root: string, suffix = "bin"): string[] {
  try {
    return readdirSync(root)
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
      .map((version) => join(root, version, suffix));
  } catch {
    return [];
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function realFile(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Finds the executable the user installed for this agent, or null. */
export function findInstalledExecutable(id: AgentId, options: DiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const suffixes = platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of knownAgentDirectories(options)) {
    for (const name of NAMES[id]) {
      for (const suffix of suffixes) {
        const candidate = join(dir, `${name}${suffix}`);
        if (!isFile(candidate)) continue;
        // "agent" is a generic name. Accept it for Cursor only when it resolves into the Cursor CLI install.
        if (id === "cursor" && name === "agent" && !/cursor-agent/i.test(realFile(candidate))) continue;
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Resolves what Prentice will actually spawn for an installed agent. Detection and execution both use this,
 * so a status check never looks at a different binary than the one a task runs.
 */
export function resolveAgent(id: AgentId, options: DiscoveryOptions = {}): ResolvedAgent | { id: AgentId; error: string; installed: string } | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const installed = findInstalledExecutable(id, options);
  if (!installed) return null;
  let command = installed;
  let prefixArgs: string[] = [];
  let pathDirs: string[] = [];
  if (id === "codex") {
    const native = codexNativeBinary(installed, { platform, arch: options.arch ?? process.arch });
    if (!native) {
      return { id, installed, error: "Codex is installed, but its native program was not found next to it. Reinstall Codex, then try again." };
    }
    command = native.executable;
    pathDirs = native.pathDirs;
  }
  if (platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const direct = id === "cursor" ? cursorWindowsEntry(installed) : null;
    if (!direct) {
      return { id, installed, error: `${agentLabel(id)} is installed as a script Prentice cannot start safely. Reinstall it with the official installer.` };
    }
    command = direct.node;
    prefixArgs = [direct.entry];
  }
  const extraPath = [...pathDirs, dirname(installed), dirname(realFile(installed))];
  return { id, command, prefixArgs, installed, env: withPath(env, extraPath, platform), pathDirs };
}

export function agentLabel(id: AgentId): string {
  if (id === "claude-code") return "Claude Code";
  if (id === "codex") return "Codex";
  return "Cursor";
}

function withPath(env: NodeJS.ProcessEnv, dirs: string[], platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const sep = platform === "win32" ? ";" : delimiter;
  const existing = (env[key] ?? "").split(sep).filter(Boolean);
  const merged = [...dirs.filter((dir) => !existing.includes(dir)), ...existing];
  return { ...env, [key]: merged.join(sep) };
}

const CODEX_TRIPLES: Record<string, string> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-arm64": "aarch64-unknown-linux-musl",
  "linux-x64": "x86_64-unknown-linux-musl",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
};

/**
 * The npm `codex` command is a Node launcher around a native binary in a platform package.
 * A packaged app cannot rely on `node` being on PATH, so Prentice runs that native binary directly.
 * A Homebrew or standalone `codex` is already native and is used as is.
 */
export function codexNativeBinary(
  installed: string,
  options: { platform: NodeJS.Platform; arch: string },
): { executable: string; pathDirs: string[] } | null {
  const real = realFile(installed);
  if (!looksLikeScript(real) && !/\.(cmd|bat|ps1)$/i.test(installed)) return { executable: real, pathDirs: [] };
  const key = `${options.platform}-${options.arch}`;
  const triple = CODEX_TRIPLES[key];
  if (!triple) return null;
  const binary = options.platform === "win32" ? "codex.exe" : "codex";
  const packageRoots = new Set<string>();
  if (basename(dirname(real)) === "bin") packageRoots.add(dirname(dirname(real)));
  packageRoots.add(join(dirname(installed), "node_modules", "@openai", "codex"));
  packageRoots.add(join(dirname(installed), "..", "lib", "node_modules", "@openai", "codex"));
  for (const root of packageRoots) {
    const platformPackages = [
      join(root, "node_modules", "@openai", `codex-${key}`),
      join(dirname(root), `codex-${key}`),
    ];
    for (const platformPackage of platformPackages) {
      const vendor = join(platformPackage, "vendor", triple);
      const current = join(vendor, "bin", binary);
      if (isFile(current)) return { executable: current, pathDirs: [join(vendor, "codex-path")].filter(existsSync) };
      const legacy = join(vendor, "codex", binary);
      if (isFile(legacy)) return { executable: legacy, pathDirs: [join(vendor, "path")].filter(existsSync) };
    }
  }
  return null;
}

function looksLikeScript(path: string): boolean {
  if ([".js", ".mjs", ".cjs"].includes(extname(path))) return true;
  try {
    const head = readFileSync(path, { encoding: "utf8", flag: "r" }).slice(0, 64);
    return head.startsWith("#!") && /node/.test(head.split("\n")[0] ?? "");
  } catch {
    return false;
  }
}

/** Cursor's Windows installer ships a node.exe and index.js next to its .cmd launcher. */
function cursorWindowsEntry(installed: string): { node: string; entry: string } | null {
  const root = dirname(installed);
  const versionsDir = join(root, "versions");
  let versions: string[] = [];
  try {
    versions = readdirSync(versionsDir).sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
  } catch {
    return null;
  }
  for (const version of versions) {
    const node = join(versionsDir, version, "node.exe");
    const entry = join(versionsDir, version, "index.js");
    if (isFile(node) && isFile(entry)) return { node, entry };
  }
  return null;
}

let loginPath: { at: number; value: string | null } | null = null;

/**
 * Reads PATH from the user's login shell once, with a short timeout. It only adds places to look;
 * discovery works without it. Not used on Windows.
 */
export async function loginShellPath(): Promise<string | null> {
  if (process.platform === "win32") return null;
  if (loginPath && Date.now() - loginPath.at < 10 * 60_000) return loginPath.value;
  const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  const value = await new Promise<string | null>((resolve) => {
    execFile(shell, ["-l", "-c", 'printf "__PRENTICE_PATH__%s" "$PATH"'], { timeout: 3_000, env: { HOME: homedir(), USER: process.env.USER ?? "" } }, (error, stdout) => {
      if (error) return resolve(null);
      const marker = stdout.lastIndexOf("__PRENTICE_PATH__");
      resolve(marker >= 0 ? stdout.slice(marker + "__PRENTICE_PATH__".length).trim() || null : null);
    });
  });
  loginPath = { at: Date.now(), value };
  return value;
}
