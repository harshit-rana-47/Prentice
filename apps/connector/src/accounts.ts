import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, join } from "node:path";
import type { ProviderId } from "@prentice/domain";
import { log } from "./log.js";
import type { SecretStore } from "./secrets.js";

export interface AccountState {
  connected: boolean;
}

export interface LoginJob {
  phase: "pending" | "failed";
  message: string;
}

export interface AccountSnapshot {
  accounts: Record<"claude-code" | "codex" | "cursor", AccountState>;
  jobs: Partial<Record<"claude-code" | "codex" | "cursor", LoginJob>>;
}

export interface Accounts {
  list(): Promise<AccountSnapshot>;
  connect(id: ProviderId): Promise<void>;
  disconnect(id: ProviderId): Promise<void>;
}

const DISCONNECTED: AccountSnapshot["accounts"] = {
  "claude-code": { connected: false },
  codex: { connected: false },
  cursor: { connected: false },
};

export class AccountService implements Accounts {
  private jobs: AccountSnapshot["jobs"] = {};
  private cache: { at: number; accounts: AccountSnapshot["accounts"] } | null = null;

  constructor(private readonly secrets: SecretStore) {}

  async list(): Promise<AccountSnapshot> {
    const accounts = await this.probe();
    return { accounts, jobs: { ...this.jobs } };
  }

  async connect(id: ProviderId): Promise<void> {
    if (id === "fixture") return;
    if (this.jobs[id]?.phase === "pending") return;
    this.jobs[id] = { phase: "pending", message: "Opening the official sign-in page." };
    void this.finishConnect(id);
  }

  async disconnect(id: ProviderId): Promise<void> {
    if (id === "fixture") return;
    delete this.jobs[id];
    this.cache = null;
    await this.secrets.clear(id);
    if (id === "claude-code") await runCommand("claude", ["auth", "logout"]);
    if (id === "codex") await runCommand(codexExecutable(), ["logout"]);
    if (id === "cursor") await cursorLogout();
  }

  private async finishConnect(id: "claude-code" | "codex" | "cursor"): Promise<void> {
    try {
      if (id === "cursor") await this.cursorLogin();
      if (id === "claude-code") await this.cliLogin("claude", ["auth", "login"], id);
      if (id === "codex") await this.cliLogin(codexExecutable(), ["login"], id);
      this.cache = null;
      const accounts = await this.probe();
      if (accounts[id].connected) delete this.jobs[id];
      else if (this.jobs[id]?.phase === "pending") {
        this.jobs[id] = {
          phase: "failed",
          message: "The official sign-in ended without a saved session. Connect again to retry.",
        };
      }
    } catch (error) {
      this.jobs[id] = { phase: "failed", message: publicError(error) };
    }
  }

  private async cliLogin(command: string, args: string[], id: "claude-code" | "codex"): Promise<void> {
    const code = await streamCommand(command, args, (text) => {
      const url = text.match(/https:\/\/\S+/)?.[0];
      this.jobs[id] = {
        phase: "pending",
        message: url ? `Continue sign-in: ${url}` : "Waiting for the browser sign-in to finish.",
      };
    });
    if (code === null) {
      this.jobs[id] = {
        phase: "failed",
        message: `${command} is not installed. Install the official CLI, then connect your account.`,
      };
    }
  }

  private async cursorLogin(): Promise<void> {
    const sdk = (await importSdk()) as {
      Cursor?: {
        auth: {
          login(options: { onLoginUrl?: (url: string) => void }): Promise<unknown>;
        };
      };
    };
    if (!sdk.Cursor?.auth?.login) {
      throw new Error("The Cursor SDK is not installed in this runtime.");
    }
    await sdk.Cursor.auth.login({
      onLoginUrl: (url) => {
        this.jobs.cursor = { phase: "pending", message: `Continue sign-in: ${url}` };
      },
    });
  }

  private async probe(): Promise<AccountSnapshot["accounts"]> {
    if (this.cache && Date.now() - this.cache.at < 4000) return this.cache.accounts;
    const [claude, codex, cursor] = await Promise.all([
      commandOk("claude", ["auth", "status"]),
      commandOk(codexExecutable(), ["login", "status"]),
      cursorLoggedIn(),
    ]);
    const accounts = {
      "claude-code": { connected: claude },
      codex: { connected: codex },
      cursor: { connected: cursor },
    };
    this.cache = { at: Date.now(), accounts };
    return accounts;
  }
}

export function disconnectedAccounts(): Accounts {
  return {
    async list() {
      return { accounts: DISCONNECTED, jobs: {} };
    },
    async connect() {},
    async disconnect() {},
  };
}

async function cursorLoggedIn(): Promise<boolean> {
  try {
    const status = await Promise.race([
      (async () => {
        const sdk = (await importSdk()) as {
          Cursor?: { auth: { status(): Promise<{ status?: string }> } };
        };
        return sdk.Cursor?.auth.status() ?? null;
      })(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000)),
    ]);
    return status?.status === "logged-in";
  } catch (error) {
    const message = publicError(error);
    if (!message.includes("Cannot find package")) {
      log("warn", "Cursor auth status unavailable", { error: message });
    }
    return false;
  }
}

async function cursorLogout(): Promise<void> {
  try {
    const sdk = (await importSdk()) as { Cursor?: { auth: { logout(): Promise<void> } } };
    await sdk.Cursor?.auth.logout();
  } catch (error) {
    log("warn", "Cursor logout failed", { error: publicError(error) });
  }
}

/** Official `codex` CLI. A PATH install wins. Otherwise use the CLI shipped with `@openai/codex`. */
export function codexExecutable(): string {
  const fromPath = executableOnPath("codex");
  if (fromPath) return fromPath;
  try {
    const require = createRequire(import.meta.url);
    return require.resolve("@openai/codex/bin/codex.js");
  } catch {
    return "codex";
  }
}

function executableOnPath(command: string): string | null {
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const directory of directories) {
    const candidate = join(directory, command);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function commandOk(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 8000);
    child.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
}

function streamCommand(command: string, args: string[], onText: (text: string) => void): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", () => resolve(null));
    child.stdout.on("data", (chunk: Buffer) => onText(publicError(String(chunk))));
    child.stderr.on("data", (chunk: Buffer) => onText(publicError(String(chunk))));
    child.on("close", (code) => resolve(code));
  });
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .trim()
    .slice(0, 500);
}

async function importSdk(): Promise<Record<string, unknown>> {
  const specifier = "@cursor/sdk";
  return (await import(specifier)) as Record<string, unknown>;
}
