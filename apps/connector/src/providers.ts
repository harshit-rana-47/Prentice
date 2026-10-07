import { readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { Codex as CodexSdk } from "@openai/codex-sdk";
import type { ResolvedAgent } from "./agents.js";
import { runJsonLines } from "./agent-process.js";
import { repositorySessionNote } from "./paths.js";
import { log } from "./log.js";
import {
  codexEventIsWork,
  codexUnavailableFromEvent,
  codexUnavailableSlug,
  readCodexCatalog,
  readConfiguredCodexModel,
  codexModelPlan,
} from "./codex-model.js";
import {
  CAPABILITIES_BY_ID,
  CLAUDE_CODE_CAPABILITIES,
  CODEX_CAPABILITIES,
  CURSOR_CAPABILITIES,
  commandAllowed,
  codexEffort,
  fixtureEvents,
  nativeEffort,
  normalizeCodexEvent,
  CLAUDE_SIGNED_OUT,
  CURSOR_SIGNED_OUT,
  boundFailureOutput,
  createClaudeStreamNormalizer,
  createCursorStreamNormalizer,
  cursorSignedOutMessage,
  type NormalizedEvent,
  type ProviderCapabilities,
  type ProviderId,
  type ResolvedProfile,
} from "@prentice/domain";

export const FIXTURE_FILE = "prentice-fixture/session-note.ts";
export const FIXTURE_SYMBOL = "attachSessionNote";

export interface SessionStart {
  prompt: string;
  repoPath: string;
  profile: ResolvedProfile;
  signal: AbortSignal;
  /** Set only when the user chose a model in Prentice. Automatic sessions leave this unset. */
  model?: string;
  /** Set only when Continue resumes a recorded provider conversation. */
  resumeThreadId?: string;
  /** The installed agent resolved by discovery. Required for Codex, Claude Code, and Cursor. */
  agent?: ResolvedAgent;
}

export interface AgentSession {
  events: AsyncIterable<NormalizedEvent>;
  interrupt(): Promise<void>;
  disconnect(): Promise<void>;
}

export interface CodingAgentProvider {
  id: ProviderId;
  getCapabilities(): ProviderCapabilities;
  authenticate(apiKey?: string): Promise<{ ok: boolean; verified: boolean; message: string }>;
  startSession(input: SessionStart & { apiKey?: string }): Promise<AgentSession>;
}

export function commandFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.command === "string") return record.command;
  if (typeof record.cmd === "string") return record.cmd;
  return undefined;
}

export function describeProviderFailure(provider: string, error: unknown, aborted: boolean): NormalizedEvent {
  if (aborted) return { type: "session.interrupted" };
  const message = error instanceof Error ? error.message : "The provider failed.";
  const lower = message.toLowerCase();
  if (lower.includes("cannot find module") || lower.includes("cannot find package")) {
    return {
      type: "session.failed",
      code: "PROVIDER_UNAVAILABLE",
      message: `${provider} could not be loaded by Prentice on this computer.`,
      retryable: false,
    };
  }
  if (
    lower.includes("401") ||
    lower.includes("unauthorized") ||
    lower.includes("authentication") ||
    lower.includes("api key") ||
    lower.includes("login")
  ) {
    return {
      type: "session.failed",
      code: "AGENT_SIGNED_OUT",
      message: `${provider} is not signed in on this computer, or its sign-in expired. Sign in to ${provider}, then send the task again.`,
      retryable: false,
    };
  }
  if (lower.includes("econnrefused") || lower.includes("network") || lower.includes("fetch failed") || lower.includes("timed out")) {
    return {
      type: "session.failed",
      code: "PROVIDER_UNAVAILABLE",
      message: `${provider} could not be reached. You can start a new task when it is back.`,
      retryable: true,
    };
  }
  return { type: "session.failed", code: "PROVIDER_ERROR", message, retryable: false };
}

function missingAgent(provider: string): NormalizedEvent {
  return {
    type: "session.failed",
    code: "AGENT_NOT_INSTALLED",
    message: `${provider} was not found on this computer. Install it, sign in, then send the task again.`,
    retryable: false,
  };
}

export function createFixtureProvider(): CodingAgentProvider {
  return {
    id: "fixture",
    getCapabilities: () => CAPABILITIES_BY_ID.fixture,
    async authenticate() {
      return {
        ok: true,
        verified: true,
        message: "Fixture is local. It writes one sample file and does not call a model.",
      };
    },
    async startSession(input) {
      const aborted = () => input.signal.aborted;
      return {
        events: (async function* () {
          if (aborted()) {
            yield { type: "session.interrupted" as const };
            return;
          }
          const full = join(input.repoPath, FIXTURE_FILE);
          await mkdir(join(input.repoPath, "prentice-fixture"), { recursive: true });
          await writeFile(
            full,
            `export function ${FIXTURE_SYMBOL}(note: string): string {\n  return note.trim();\n}\n`,
            "utf8",
          );
          for (const event of fixtureEvents({ path: FIXTURE_FILE, symbol: FIXTURE_SYMBOL })) {
            if (aborted()) {
              yield { type: "session.interrupted" as const };
              return;
            }
            yield event;
          }
        })(),
        async interrupt() {
          // The fixture checks the abort signal between events.
        },
        async disconnect() {},
      };
    },
  };
}

/** Destructive shell prefixes denied through Claude Code's own permission rules. Prentice also stops the turn if one is reported. */
export const CLAUDE_DENIED_COMMANDS = [
  "Bash(git push *)",
  "Bash(git reset --hard *)",
  "Bash(rm -rf *)",
  "Bash(sudo *)",
  "Bash(mkfs *)",
  "Bash(shutdown *)",
  "Bash(reboot *)",
];
const CLAUDE_ALLOWED_TOOLS = ["Bash", "Read", "Edit", "Write", "MultiEdit", "Glob", "Grep", "LS", "NotebookEdit", "TodoWrite"];

export function claudeArgs(input: SessionStart): string[] {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    CLAUDE_DENIED_COMMANDS.join(","),
    "--append-system-prompt",
    repositorySessionNote(input.repoPath),
    "--effort",
    nativeEffort(input.profile.intensity, input.profile.useProviderMax),
  ];
}

/**
 * Claude Code through the CLI the person installed and signed in to: `claude -p --output-format stream-json`.
 * Prentice does not ship Claude Code, does not modify it, and never handles its credentials.
 */
export function createClaudeProvider(): CodingAgentProvider {
  return {
    id: "claude-code",
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async authenticate() {
      return {
        ok: true,
        verified: false,
        message: "Claude Code uses its own sign-in on this computer. Prentice does not store a key.",
      };
    },
    async startSession(input) {
      return cliSession({
        provider: "Claude Code",
        input,
        args: input.agent ? [...input.agent.prefixArgs, ...claudeArgs(input)] : [],
        stdin: input.prompt,
        normalizer: createClaudeStreamNormalizer(),
        signedOut: CLAUDE_SIGNED_OUT,
        signedOutMessage:
          "Claude Code is installed but not signed in on this computer. Sign in to Claude Code, then send the task again.",
        continuationMessage:
          "Continuation is not available for Claude Code. A live resume has not been verified, so Prentice will not start a new session and call it continuation.",
      });
    },
  };
}

/** Runs a headless coding-agent CLI and normalizes its JSON lines. Shared by Claude Code and Cursor. */
function cliSession(options: {
  provider: string;
  input: SessionStart;
  args: string[];
  stdin?: string;
  normalizer: (message: unknown) => NormalizedEvent[];
  signedOut: RegExp;
  signedOutMessage: string;
  continuationMessage: string;
}): AgentSession {
  const { input } = options;
  let run: ReturnType<typeof runJsonLines> | null = null;
  let stoppedByPrentice = false;
  return {
    events: (async function* () {
      if (input.resumeThreadId) {
        yield { type: "session.failed" as const, code: "CONTINUATION_UNAVAILABLE", message: options.continuationMessage, retryable: false };
        return;
      }
      if (!input.agent) {
        yield missingAgent(options.provider);
        return;
      }
      if (input.signal.aborted) {
        yield { type: "session.interrupted" as const };
        return;
      }
      run = runJsonLines({ command: input.agent.command, args: options.args, cwd: input.repoPath, env: input.agent.env, stdin: options.stdin });
      const current = run;
      const onAbort = () => void current.interrupt();
      input.signal.addEventListener("abort", onAbort, { once: true });
      let terminal = false;
      try {
        yield { type: "status" as const, title: `${options.provider} is running on this computer`, detail: input.profile.summary };
        for await (const line of current.lines) {
          if (input.signal.aborted) break;
          for (const event of options.normalizer(line).map((item) => repoRelative(item, input.repoPath))) {
            if (event.type === "command.started" && !commandAllowed(event.command).allowed) {
              stoppedByPrentice = true;
              yield event;
              yield {
                type: "session.failed" as const,
                code: "COMMAND_BLOCKED",
                message: `${options.provider} started a destructive command. Prentice stopped this turn and will not retry it.`,
                retryable: false,
              };
              terminal = true;
              await current.interrupt();
              return;
            }
            if (event.type === "session.completed" || event.type === "session.failed") terminal = true;
            yield event;
          }
        }
        const exit = await current.exited;
        if (input.signal.aborted) {
          yield { type: "session.interrupted" as const };
          return;
        }
        if (terminal) return;
        if (exit.spawnError) {
          yield {
            type: "session.failed" as const,
            code: "AGENT_UNAVAILABLE",
            message: `${options.provider} could not be started on this computer.`,
            retryable: true,
          };
          return;
        }
        if (options.signedOut.test(exit.stderr)) {
          yield { type: "session.failed" as const, code: "AGENT_SIGNED_OUT", message: options.signedOutMessage, retryable: false };
          return;
        }
        if (exit.code === 0) {
          yield { type: "session.completed" as const };
          return;
        }
        const detail = boundFailureOutput(exit.stderr)?.text;
        yield {
          type: "session.failed" as const,
          code: "PROVIDER_ERROR",
          message: detail
            ? `${options.provider} exited with code ${exit.code ?? "unknown"}: ${detail.split("\n").slice(-3).join(" ").slice(0, 400)}`
            : `${options.provider} exited with code ${exit.code ?? "unknown"} without a result.`,
          retryable: false,
        };
      } finally {
        input.signal.removeEventListener("abort", onAbort);
        if (!stoppedByPrentice && current.child.exitCode === null && current.child.signalCode === null) await current.interrupt();
      }
    })(),
    async interrupt() {
      await run?.interrupt();
    },
    async disconnect() {
      await run?.interrupt();
    },
  };
}

export function createCodexProvider(): CodingAgentProvider {
  return {
    id: "codex",
    getCapabilities: () => CODEX_CAPABILITIES,
    async authenticate() {
      return {
        ok: true,
        verified: false,
        message: "Codex uses the official CLI account login. Prentice does not store a pasted key.",
      };
    },
    async startSession(input) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
      return {
        events: (async function* () {
          try {
            if (!input.agent) {
              yield missingAgent("Codex");
              return;
            }
            const agent = input.agent;
            const Codex = CodexSdk as unknown as new (options?: {
              config?: Record<string, string>;
              codexPathOverride?: string;
              env?: Record<string, string>;
            }) => {
              startThread(options: Record<string, unknown>): CodexThread;
              resumeThread(id: string, options?: Record<string, unknown>): CodexThread;
            };
            const codex = new Codex({
              config: { developer_instructions: codexDeveloperInstructions(input.repoPath) },
              codexPathOverride: agent.command,
              env: definedEnv(agent.env),
            });
            if (input.resumeThreadId) {
              const catalog = await readCodexCatalog(agent.command, agent.env);
              const plan = codexModelPlan(catalog, input.model);
              if (plan.models.length === 0) {
                yield {
                  type: "session.failed" as const,
                  code: "PROVIDER_ERROR",
                  message: "Codex did not list a model for this account. Prentice did not start a new conversation.",
                  retryable: false,
                };
                return;
              }
              let modelFailure = "";
              for (const candidate of plan.models) {
                const thread = codex.resumeThread(input.resumeThreadId, {
                  workingDirectory: input.repoPath,
                  skipGitRepoCheck: false,
                  modelReasoningEffort: codexEffort(input.profile.intensity, input.profile.useProviderMax),
                  sandboxMode: "workspace-write",
                  model: candidate,
                });
                let sawWork = false;
                try {
                  const { events } = await thread.runStreamed(input.prompt, { signal: controller.signal });
                  let announced = false;
                  for await (const event of events) {
                    if (controller.signal.aborted) {
                      yield { type: "session.interrupted" as const };
                      return;
                    }
                    const normalizedInput = relativizeCodexEvent(event, input.repoPath);
                    const command = codexCommand(normalizedInput);
                    if (command && !commandAllowed(command).allowed) {
                      yield {
                        type: "session.failed" as const,
                        code: "COMMAND_BLOCKED",
                        message:
                          "Codex reported a destructive command. Prentice stopped this turn and will not retry it. The Codex sandbox is the control that can prevent the command.",
                        retryable: false,
                      };
                      return;
                    }
                    const rejectedSlug = codexUnavailableFromEvent(normalizedInput);
                    if (rejectedSlug !== null && rejectedSlug !== candidate) continue;
                    if (rejectedSlug !== null && !sawWork) {
                      modelFailure = rejectedSlug || candidate || modelFailure;
                      break;
                    }
                    if (codexEventIsWork(normalizedInput)) sawWork = true;
                    if (sawWork && !announced) {
                      announced = true;
                      yield codexModelStatus(candidate, input.profile.summary);
                    }
                    yield* normalizeCodexEvent(normalizedInput);
                  }
                  if (sawWork || modelFailure === "") return;
                } catch (error) {
                  if (controller.signal.aborted) {
                    yield { type: "session.interrupted" as const };
                    return;
                  }
                  const message = error instanceof Error ? error.message : "unknown";
                  const thrown = codexUnavailableSlug(message);
                  if (!sawWork && thrown !== null && (thrown === "" || thrown === candidate)) {
                    modelFailure = thrown || candidate || modelFailure;
                    continue;
                  }
                  if (!sawWork && thrown !== null) continue;
                  log("error", "Codex thread resume failed", { error: message });
                  yield {
                    type: "session.failed" as const,
                    code: "THREAD_GONE",
                    message: "Codex could not resume that conversation. Prentice did not start a new one.",
                    retryable: false,
                  };
                  return;
                }
              }
              yield {
                type: "session.failed" as const,
                code: "PROVIDER_ERROR",
                message: `Codex could not resume that conversation${modelFailure ? ` because ${modelFailure} is unavailable` : ""}. Prentice did not start a new one.`,
                retryable: false,
              };
              return;
            }
            const configured = readConfiguredCodexModel(input.repoPath);
            const catalog = await readCodexCatalog(agent.command, agent.env);
            const plan = codexModelPlan(catalog, input.model);
            log("info", "Codex model selection", {
              selection: plan.selection,
              configured: configured ?? null,
              models: plan.models,
            });
            const rejected = new Set<string>();
            let started = false;
            for (const candidate of plan.models) {
              if (candidate && rejected.has(candidate)) continue;
              const thread = codex.startThread({
                workingDirectory: input.repoPath,
                skipGitRepoCheck: false,
                modelReasoningEffort: codexEffort(input.profile.intensity, input.profile.useProviderMax),
                sandboxMode: "workspace-write",
                model: candidate,
              });
              const pending: NormalizedEvent[] = [];
              let sawWork = false;
              let unavailable: string | null = null;
              const attemptAbort = new AbortController();
              const stopAttempt = () => attemptAbort.abort();
              controller.signal.addEventListener("abort", stopAttempt, { once: true });
              const { events } = await thread.runStreamed(input.prompt, { signal: attemptAbort.signal });
              try {
                for await (const event of events) {
                  const normalizedInput = relativizeCodexEvent(event, input.repoPath);
                  if (controller.signal.aborted) {
                    yield { type: "session.interrupted" as const };
                    return;
                  }
                  const command = codexCommand(normalizedInput);
                  if (command && !commandAllowed(command).allowed) {
                    yield {
                      type: "session.failed" as const,
                      code: "COMMAND_BLOCKED",
                      message:
                        "Codex reported a destructive command. Prentice stopped this turn and will not retry it. The Codex sandbox is the control that can prevent the command.",
                      retryable: false,
                    };
                    return;
                  }
                  const rejectedSlug = codexUnavailableFromEvent(normalizedInput);
                  if (rejectedSlug !== null && !sawWork) {
                    unavailable = rejectedSlug || candidate || unavailable || "";
                    attemptAbort.abort();
                    continue;
                  }
                  if (codexEventIsWork(normalizedInput)) sawWork = true;
                  const normalized = normalizeCodexEvent(normalizedInput);
                  if (!started) pending.push(...normalized);
                  else yield* normalized;
                  if (sawWork && !started) {
                    started = true;
                    yield codexModelStatus(candidate, input.profile.summary);
                    yield* pending;
                    pending.length = 0;
                  }
                }
              } catch (error) {
                if (controller.signal.aborted) {
                  yield { type: "session.interrupted" as const };
                  return;
                }
                const thrown = codexUnavailableSlug(error instanceof Error ? error.message : "");
                if (!sawWork && (unavailable !== null || thrown !== null)) {
                  const slug = (thrown || unavailable || candidate || "").trim();
                  if (slug) rejected.add(slug);
                  if (candidate) rejected.add(candidate);
                  noteRejectedCodexModel(slug || candidate || "unknown", configured, plan.selection);
                  continue;
                }
                throw error;
              } finally {
                controller.signal.removeEventListener("abort", stopAttempt);
              }
              if (!sawWork && unavailable !== null) {
                const slug = (unavailable || candidate || "").trim();
                if (slug) rejected.add(slug);
                if (candidate) rejected.add(candidate);
                noteRejectedCodexModel(slug || candidate || "unknown", configured, plan.selection);
                continue;
              }
              if (!started) {
                started = true;
                yield codexModelStatus(candidate, input.profile.summary);
                yield* pending;
              }
              return;
            }
            log("info", "Codex could not run a model for this account", {
              configured: configured ?? null,
              rejected: [...rejected],
              selection: plan.selection,
            });
            yield {
              type: "session.failed" as const,
              code: "PROVIDER_ERROR",
              message:
                plan.selection === "explicit"
                  ? `Codex could not run ${plan.models[0] ?? "the selected model"}. That model was selected in Prentice.`
                  : "Codex could not run a model this account can use. Prentice tried each model Codex lists for this login once.",
              retryable: false,
            };
          } catch (error) {
            yield describeProviderFailure("Codex", error, controller.signal.aborted);
          } finally {
            input.signal.removeEventListener("abort", onAbort);
          }
        })(),
        async interrupt() {
          controller.abort();
        },
        async disconnect() {
          controller.abort();
        },
      };
    },
  };
}

function codexDeveloperInstructions(repoPath: string): string {
  const note = repositorySessionNote(repoPath);
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  let existing = "";
  try {
    const raw = readFileSync(join(home, "config.toml"), "utf8");
    const block = raw.match(/^\s*developer_instructions\s*=\s*"""([\s\S]*?)"""/m);
    const line = raw.match(/^\s*developer_instructions\s*=\s*"((?:\\.|[^"\\])*)"/m);
    existing = (block?.[1] ?? line?.[1] ?? "").replace(/\\n/g, "\n").trim();
  } catch {
    existing = "";
  }
  const kept = existing.replace(/\n*You are working in the git repository at [\s\S]*$/, "").trim();
  return kept ? `${kept}\n\n${note}` : note;
}

function noteRejectedCodexModel(slug: string, configured: string | undefined, selection: "automatic" | "explicit"): void {
  log("info", "Codex model is not available for this account", {
    slug,
    configured: configured ?? null,
    selection,
  });
}

function codexModelStatus(used: string | undefined, summary: string): NormalizedEvent {
  const model = used ?? "the Codex default for this login";
  return {
    type: "status",
    title: `Codex is using ${model}`,
    detail: `${summary} Destructive commands are not auto-retried. Codex sandboxing is the vendor control Prentice can set here.`,
  };
}

function relativizeCodexEvent(event: unknown, repoPath: string): unknown {
  if (!event || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  const item = record.item;
  if (!item || typeof item !== "object" || !Array.isArray((item as { changes?: unknown }).changes)) return event;
  const entry = item as Record<string, unknown>;
  return {
    ...record,
    item: {
      ...entry,
      changes: (entry.changes as unknown[]).map((change) => {
        if (!change || typeof change !== "object") return change;
        const file = change as Record<string, unknown>;
        if (typeof file.path !== "string" || !isAbsolute(file.path)) return change;
        const rel = relative(repoPath, file.path);
        if (!rel || rel.startsWith("..")) return change;
        return { ...file, path: rel };
      }),
    },
  };
}

interface CodexThread {
  runStreamed(prompt: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<unknown> }>;
}

function codexCommand(event: unknown): string | undefined {
  if (!event || typeof event !== "object") return undefined;
  const item = (event as { item?: { command?: unknown } }).item;
  return typeof item?.command === "string" ? item.command : undefined;
}

export function cursorArgs(input: SessionStart): string[] {
  return ["-p", "--output-format", "stream-json", "--force", "--trust", "--workspace", input.repoPath, input.prompt];
}

/**
 * Cursor through the official Cursor CLI the person installed (`agent -p --output-format stream-json`).
 * It runs its own bundled runtime, so Prentice never loads Cursor native code into the connector process.
 */
export function createCursorProvider(): CodingAgentProvider {
  return {
    id: "cursor",
    getCapabilities: () => CURSOR_CAPABILITIES,
    async authenticate() {
      return {
        ok: true,
        verified: false,
        message: "Cursor uses its own CLI sign-in on this computer. Prentice does not store a key.",
      };
    },
    async startSession(input) {
      return cliSession({
        provider: "Cursor",
        input,
        args: input.agent ? [...input.agent.prefixArgs, ...cursorArgs(input)] : [],
        normalizer: createCursorStreamNormalizer(),
        signedOut: CURSOR_SIGNED_OUT,
        signedOutMessage: cursorSignedOutMessage(),
        continuationMessage:
          "Continuation is not available for Cursor. A live resume has not been verified, so Prentice will not start a new agent and call it continuation.",
      });
    },
  };
}

/** Agents may report absolute paths (macOS may add /private). Prentice shows paths relative to the open repository. */
export function repoRelative(event: NormalizedEvent, repoPath: string): NormalizedEvent {
  if (!("path" in event) || typeof event.path !== "string" || !isAbsolute(event.path)) return event;
  const roots = new Set([repoPath]);
  try {
    roots.add(realpathSync(repoPath));
  } catch {
    // The repository path is used as given.
  }
  for (const root of roots) {
    for (const candidate of [event.path, event.path.replace(/^\/private(?=\/)/, "")]) {
      const rel = relative(root, candidate);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        const title = "title" in event && typeof event.title === "string" ? event.title.split(event.path).join(rel) : undefined;
        return { ...event, path: rel, ...(title !== undefined ? { title } : {}) } as NormalizedEvent;
      }
    }
  }
  return event;
}

function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function providerFactory(id: ProviderId): CodingAgentProvider {
  switch (id) {
    case "fixture":
      return createFixtureProvider();
    case "claude-code":
      return createClaudeProvider();
    case "codex":
      return createCodexProvider();
    case "cursor":
      return createCursorProvider();
  }
}
