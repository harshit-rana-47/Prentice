import { spawn } from "node:child_process";
import type { ProviderId } from "@prentice/domain";
import { agentLabel, loginShellPath, resolveAgent, type AgentId, type DiscoveryOptions, type ResolvedAgent } from "./agents.js";
import { runQuick } from "./agent-process.js";
import { log } from "./log.js";
import type { SecretStore } from "./secrets.js";

/**
 * - not-installed: Prentice found no executable for this agent on this computer.
 * - signed-out: the agent is installed, and its own status command says it is not signed in.
 * - ready: installed and signed in. Tasks may be routed to it.
 * - error: installed, but Prentice could not start it or read its status.
 */
export type AgentState = "not-installed" | "signed-out" | "ready" | "error";

export interface AccountState {
  installed: boolean;
  connected: boolean;
  state: AgentState;
  /** Plain explanation of the state for the person, empty when ready. */
  message: string;
}

export interface LoginJob {
  phase: "pending" | "failed";
  message: string;
}

export interface AccountSnapshot {
  accounts: Record<AgentId, AccountState>;
  jobs: Partial<Record<AgentId, LoginJob>>;
}

export interface Accounts {
  list(): Promise<AccountSnapshot>;
  connect(id: ProviderId): Promise<void>;
  disconnect(id: ProviderId): Promise<void>;
  /** Forget the cached state, for example after a run reported that the agent is signed out. */
  invalidate?(): void;
  /** The executable a task will run. Detection and execution share this. */
  resolve?(id: AgentId): Promise<ResolvedAgent | null>;
}

const AGENTS: AgentId[] = ["claude-code", "codex", "cursor"];

export function codingAgentRequiredMessage(accounts: AccountSnapshot["accounts"]): string {
  const states = Object.values(accounts);
  if (states.some((account) => account.state === "signed-out")) {
    return "A coding agent is installed but not signed in. Sign in to Codex, Claude Code, or Cursor on this computer before starting a task.";
  }
  if (states.some((account) => account.installed)) {
    return "No coding agent on this computer is ready. Open Agents to see what each one needs.";
  }
  return "Install Codex, Claude Code, or Cursor on this computer, then sign in to it before starting a task.";
}

export function agentIdleMessage(id: AgentId, account: AccountState): string {
  return account.message;
}

/** What the person has to do for a signed-out agent. Claude Code sign-in stays in Anthropic's own flow. */
export function signInInstruction(id: AgentId): string {
  if (id === "claude-code") {
    return "Claude Code is installed but not signed in. Open Terminal on this computer, run claude, and sign in with /login. Prentice does not sign in to Claude for you.";
  }
  if (id === "codex") return "Codex is installed but not signed in. Connect Codex to sign in with its official login.";
  return "Cursor is installed but not signed in. Connect Cursor to sign in with its official login.";
}

export function notInstalledMessage(id: AgentId): string {
  if (id === "claude-code") return "Claude Code is not installed on this computer. Install it from Anthropic, sign in, then come back.";
  if (id === "codex") return "Codex is not installed on this computer. Install the Codex CLI, sign in, then come back.";
  return "The Cursor CLI is not installed on this computer. The Cursor editor alone is not enough. Install the Cursor CLI, then connect it here.";
}

export class AccountService implements Accounts {
  private jobs: AccountSnapshot["jobs"] = {};
  private cache: { at: number; accounts: AccountSnapshot["accounts"] } | null = null;
  private inflight: Promise<AccountSnapshot["accounts"]> | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: { cacheMs?: number } = {},
  ) {}

  async list(): Promise<AccountSnapshot> {
    const accounts = await this.probe();
    return { accounts, jobs: { ...this.jobs } };
  }

  invalidate(): void {
    this.cache = null;
  }

  async resolve(id: AgentId): Promise<ResolvedAgent | null> {
    const resolved = resolveAgent(id, { loginShellPath: await loginShellPath() });
    return resolved && "command" in resolved ? resolved : null;
  }

  async connect(id: ProviderId): Promise<void> {
    if (id === "fixture") return;
    if (id === "claude-code") {
      this.jobs[id] = { phase: "failed", message: signInInstruction("claude-code") };
      return;
    }
    if (this.jobs[id]?.phase === "pending") return;
    this.jobs[id] = { phase: "pending", message: "Opening the official sign-in page on this computer." };
    void this.finishConnect(id);
  }

  async disconnect(id: ProviderId): Promise<void> {
    if (id === "fixture" || id === "claude-code") return;
    delete this.jobs[id];
    this.cache = null;
    await this.secrets.clear(id);
    const agent = await this.resolve(id);
    if (!agent) return;
    await runQuick(agent.command, [...agent.prefixArgs, "logout"], agent.env, 15_000);
  }

  private async finishConnect(id: "codex" | "cursor"): Promise<void> {
    try {
      const current = await this.probe(true);
      if (current[id].state === "not-installed" || current[id].state === "error") {
        this.jobs[id] = { phase: "failed", message: current[id].message };
        return;
      }
      const agent = await this.resolve(id);
      if (!agent) {
        this.jobs[id] = { phase: "failed", message: notInstalledMessage(id) };
        return;
      }
      await this.streamLogin(agent, id);
      const accounts = await this.probe(true);
      if (accounts[id].connected) delete this.jobs[id];
      else if (this.jobs[id]?.phase === "pending") {
        this.jobs[id] = { phase: "failed", message: "The official sign-in ended without a saved session. Connect again to retry." };
      }
    } catch (error) {
      this.jobs[id] = { phase: "failed", message: publicError(error) };
    }
  }

  private streamLogin(agent: ResolvedAgent, id: "codex" | "cursor"): Promise<void> {
    return new Promise((resolve) => {
      const child = spawn(agent.command, [...agent.prefixArgs, "login"], {
        env: agent.env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const onText = (chunk: Buffer) => {
        const url = publicError(String(chunk)).match(/https:\/\/\S+/)?.[0];
        this.jobs[id] = { phase: "pending", message: url ? `Continue sign-in: ${url}` : "Waiting for the browser sign-in to finish." };
      };
      child.stdout?.on("data", onText);
      child.stderr?.on("data", onText);
      const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
      child.once("error", (error) => {
        clearTimeout(timer);
        this.jobs[id] = { phase: "failed", message: `${agentLabel(id)} could not be started: ${publicError(error)}` };
        resolve();
      });
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async probe(fresh = false): Promise<AccountSnapshot["accounts"]> {
    const ttl = this.options.cacheMs ?? 15_000;
    if (!fresh && this.cache && Date.now() - this.cache.at < ttl) return this.cache.accounts;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const shellPath = await loginShellPath();
      const entries = await Promise.all(AGENTS.map(async (id) => [id, await probeAgent(id, shellPath)] as const));
      const accounts = Object.fromEntries(entries) as AccountSnapshot["accounts"];
      this.cache = { at: Date.now(), accounts };
      return accounts;
    })();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }
}

/** Reads one agent's state with its own status command, run from the executable a task would use. */
export async function probeAgent(id: AgentId, shellPath: string | null = null, discovery: DiscoveryOptions = {}): Promise<AccountState> {
  const resolved = resolveAgent(id, { ...discovery, loginShellPath: shellPath });
  if (!resolved) return { installed: false, connected: false, state: "not-installed", message: notInstalledMessage(id) };
  if ("error" in resolved) return { installed: true, connected: false, state: "error", message: resolved.error };
  const args = id === "codex" ? ["login", "status"] : id === "claude-code" ? ["auth", "status"] : ["status", "--format", "json"];
  const result = await runQuick(resolved.command, [...resolved.prefixArgs, ...args], resolved.env, 12_000);
  if (result.error && result.code === null) {
    log("warn", "Coding agent status check failed", { agent: id, error: publicError(result.error) });
    return {
      installed: true,
      connected: false,
      state: "error",
      message: result.timedOut
        ? `${agentLabel(id)} did not answer its status check. Try again in a moment.`
        : `${agentLabel(id)} is installed, but Prentice could not start it.`,
    };
  }
  const signedIn = readSignedIn(id, result);
  if (signedIn === true) return { installed: true, connected: true, state: "ready", message: "" };
  if (signedIn === false) return { installed: true, connected: false, state: "signed-out", message: signInInstruction(id) };
  log("warn", "Coding agent status was not readable", { agent: id, code: result.code });
  return { installed: true, connected: false, state: "error", message: `${agentLabel(id)} is installed, but its sign-in status could not be read.` };
}

export function readSignedIn(id: AgentId, result: { code: number | null; stdout: string; stderr: string }): boolean | null {
  const text = `${result.stdout}\n${result.stderr}`;
  if (id === "claude-code") {
    const parsed = jsonObject(result.stdout);
    if (parsed && typeof parsed.loggedIn === "boolean") return parsed.loggedIn;
    if (/not logged in|loggedIn"?\s*:\s*false/i.test(text)) return false;
    return result.code === 0 ? true : null;
  }
  if (id === "cursor") {
    const parsed = jsonObject(result.stdout);
    if (parsed && typeof parsed.isAuthenticated === "boolean") return parsed.isAuthenticated;
    if (/not logged in|unauthenticated/i.test(text)) return false;
    if (/logged in as|authenticated/i.test(text)) return true;
    return null;
  }
  if (result.code === 0 && !/not logged in/i.test(text)) return true;
  if (/not logged in|login required|please (run )?(codex )?login/i.test(text) || result.code === 1) return false;
  return null;
}

function jsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const DISCONNECTED: AccountSnapshot["accounts"] = {
  "claude-code": { installed: false, connected: false, state: "not-installed", message: notInstalledMessage("claude-code") },
  codex: { installed: false, connected: false, state: "not-installed", message: notInstalledMessage("codex") },
  cursor: { installed: false, connected: false, state: "not-installed", message: notInstalledMessage("cursor") },
};

export function disconnectedAccounts(): Accounts {
  return {
    async list() {
      return { accounts: DISCONNECTED, jobs: {} };
    },
    async connect() {},
    async disconnect() {},
  };
}

export function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]")
    .trim()
    .slice(0, 500);
}
