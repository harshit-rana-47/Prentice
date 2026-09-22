import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectContext } from "@prentice/domain";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".rb": "ruby",
  ".java": "java",
};

const SKIP = new Set(["node_modules", ".git", "dist", ".next", "coverage", "build", ".prentice"]);

export async function readProjectContext(repoPath: string, name: string): Promise<ProjectContext> {
  const topLevel = await readdir(repoPath, { withFileTypes: true }).catch(() => []);
  const topLevelDirs = topLevel.filter((entry) => entry.isDirectory() && !SKIP.has(entry.name)).map((entry) => entry.name);
  const dependencyNames = await readDependencyNames(repoPath);
  const filePaths: string[] = [];
  const languages = new Set<string>();
  await walk(repoPath, "", filePaths, languages);
  const joined = `${dependencyNames.join(" ")} ${filePaths.slice(0, 400).join(" ")}`.toLowerCase();
  return {
    name,
    topLevelDirs,
    dependencyNames,
    languages: [...languages],
    hasTests: filePaths.some((path) => /\.(test|spec)\./.test(path) || path.includes("__tests__")),
    hasDatabase: /prisma|drizzle|sqlite|postgres|knex|typeorm/.test(joined),
    hasAuth: /auth|next-auth|passport|lucia|clerk/.test(joined),
    filePaths: filePaths.slice(0, 2000),
  };
}

async function readDependencyNames(repoPath: string): Promise<string[]> {
  try {
    const raw = JSON.parse(await readFile(join(repoPath, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return [...Object.keys(raw.dependencies ?? {}), ...Object.keys(raw.devDependencies ?? {})];
  } catch {
    return [];
  }
}

async function walk(root: string, relative: string, files: string[], languages: Set<string>): Promise<void> {
  if (files.length >= 2000) return;
  const directory = join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walk(root, path, files, languages);
      continue;
    }
    if (!entry.isFile()) continue;
    files.push(path);
    const extension = entry.name.includes(".") ? entry.name.slice(entry.name.lastIndexOf(".")) : "";
    const language = LANGUAGE_BY_EXT[extension];
    if (language) languages.add(language);
  }
}
