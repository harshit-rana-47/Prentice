import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CodexCatalogModel {
  slug: string;
  visibility: string;
  priority: number;
}

export interface CodexModelPlan {
  selection: "automatic" | "explicit";
  models: string[];
}

/**
 * Automatic selection uses models Codex lists for this login, highest catalog priority first.
 * It does not read ~/.codex/config.toml. An explicit Prentice choice is used alone.
 * Hidden catalog entries are not candidates.
 */
export function codexModelPlan(catalog: CodexCatalogModel[], explicitModel?: string): CodexModelPlan {
  const explicit = explicitModel?.trim();
  if (explicit) return { selection: "explicit", models: [explicit] };
  const seen = new Set<string>();
  const models = catalog
    .filter((model) => model.visibility === "list" && model.slug.length > 0)
    .sort((left, right) => left.priority - right.priority)
    .map((model) => model.slug)
    .filter((slug) => {
      if (seen.has(slug)) return false;
      seen.add(slug);
      return true;
    });
  return { selection: "automatic", models };
}

/**
 * Returns the rejected model slug, or "" when the text is a model-availability failure
 * but no slug could be read. Returns null for every other failure.
 */
export function codexUnavailableSlug(text: string): string | null {
  if (!/does not exist or you do not have access|is not supported when using Codex/i.test(text)) return null;
  const named = text.match(/model [`']([^`']+)[`']/i) ?? text.match(/The '([^']+)' model/i);
  return named?.[1] ?? "";
}

export function codexUnavailableFromEvent(event: unknown): string | null {
  if (!event || typeof event !== "object") return null;
  const record = event as Record<string, unknown>;
  if (record.type === "error" && typeof record.message === "string") return codexUnavailableSlug(record.message);
  if (record.type === "turn.failed") {
    const error = record.error as Record<string, unknown> | undefined;
    if (typeof error?.message === "string") return codexUnavailableSlug(error.message);
  }
  return null;
}

export function codexEventIsWork(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as { type?: string; item?: { type?: string } };
  if (record.type === "turn.completed") return true;
  if (record.type !== "item.started" && record.type !== "item.completed") return false;
  return record.item?.type === "agent_message" || record.item?.type === "command_execution" || record.item?.type === "file_change";
}

export function readConfiguredCodexModel(repoPath: string): string | undefined {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return readModelAssignment(join(repoPath, ".codex", "config.toml")) ?? readModelAssignment(join(home, "config.toml"));
}

export async function readCodexCatalog(executable: string): Promise<CodexCatalogModel[]> {
  const stdout = await commandOutput(executable, ["debug", "models"]);
  if (!stdout) return [];
  try {
    const parsed = JSON.parse(stdout) as { models?: Array<{ slug?: unknown; visibility?: unknown; priority?: unknown }> };
    return (parsed.models ?? []).flatMap((model) => {
      if (typeof model.slug !== "string" || typeof model.visibility !== "string") return [];
      return [
        {
          slug: model.slug,
          visibility: model.visibility,
          priority: typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER,
        },
      ];
    });
  } catch {
    return [];
  }
}

function readModelAssignment(path: string): string | undefined {
  try {
    const match = readFileSync(path, "utf8").match(/^\s*model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function commandOutput(command: string, args: string[]): Promise<string | null> {
  const program = command.endsWith(".js") ? process.execPath : command;
  const programArgs = command.endsWith(".js") ? [command, ...args] : args;
  return new Promise((resolve) => {
    const child = spawn(program, programArgs, { stdio: ["ignore", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 15000);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? Buffer.concat(chunks).toString("utf8") : null);
    });
  });
}
