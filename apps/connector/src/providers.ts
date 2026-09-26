import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { codexExecutable } from "./accounts.js";
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
  cursorDepthPreference,
  fixtureEvents,
  nativeEffort,
  normalizeClaudeMessage,
  normalizeCodexEvent,
  normalizeCursorMessage,
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
      message: `The ${provider} SDK is not installed in this runtime. The fixture provider still runs locally.`,
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
      code: "AUTH_EXPIRED",
      message: `${provider} rejected the saved key. Reconnect it. Prentice does not retry this task on its own.`,
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

async function importSdk(specifier: string): Promise<Record<string, unknown>> {
  return (await import(specifier)) as Record<string, unknown>;
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

export function createClaudeProvider(): CodingAgentProvider {
  return {
    id: "claude-code",
    getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
    async authenticate() {
      return {
        ok: true,
        verified: false,
        message: "Claude Code uses the official CLI account login. Prentice does not store a pasted key.",
      };
    },
    async startSession(input) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      input.signal.addEventListener("abort", onAbort);
      let interruptHandle: (() => Promise<void>) | undefined;
      return {
        events: (async function* () {
          if (input.resumeThreadId) {
            yield {
              type: "session.failed" as const,
              code: "CONTINUATION_UNAVAILABLE",
              message:
                "Continuation is not available for Claude Code. A live resume has not been verified, so Prentice will not start a new session and call it continuation.",
              retryable: false,
            };
            return;
          }
          try {
            const sdk = await importSdk("@anthropic-ai/claude-agent-sdk");
            const query = sdk.query as (args: Record<string, unknown>) => AsyncIterable<unknown> & {
              interrupt?: () => Promise<void>;
            };
            const handle = query({
              prompt: input.prompt,
              options: {
                cwd: input.repoPath,
                systemPrompt: {
                  type: "preset",
                  preset: "claude_code",
                  append: repositorySessionNote(input.repoPath),
                },
                effort: nativeEffort(input.profile.intensity, input.profile.useProviderMax),
                permissionMode: "acceptEdits",
                abortController: controller,
                canUseTool: async (_toolName: string, toolInput: unknown) => {
                  const command = commandFromInput(toolInput);
                  if (command) {
                    const verdict = commandAllowed(command);
                    if (!verdict.allowed) return { behavior: "deny", message: verdict.reason, interrupt: false };
                  }
                  return { behavior: "allow", updatedInput: toolInput };
                },
              },
            });
            interruptHandle = handle.interrupt?.bind(handle);
            yield { type: "status" as const, title: "Claude Code is running locally", detail: input.profile.summary };
            for await (const message of handle) {
              if (input.signal.aborted) {
                yield { type: "session.interrupted" as const };
                return;
              }
              yield* normalizeClaudeMessage(message);
            }
          } catch (error) {
            yield describeProviderFailure("Claude Code", error, input.signal.aborted || controller.signal.aborted);
          } finally {
            input.signal.removeEventListener("abort", onAbort);
          }
        })(),
        async interrupt() {
          controller.abort();
          await interruptHandle?.();
        },
        async disconnect() {
          controller.abort();
        },
      };
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
            const sdk = await importSdk("@openai/codex-sdk");
            const Codex = sdk.Codex as new (options?: { config?: Record<string, string> }) => {
              startThread(options: Record<string, unknown>): CodexThread;
              resumeThread(id: string, options?: Record<string, unknown>): CodexThread;
            };
            const codex = new Codex({ config: { developer_instructions: codexDeveloperInstructions(input.repoPath) } });
            if (input.resumeThreadId) {
              const catalog = await readCodexCatalog(codexExecutable());
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
            const catalog = await readCodexCatalog(codexExecutable());
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

interface CursorModel {
  id: string;
  parameters?: Array<{ id: string; values?: Array<{ value: string }> }>;
}

export function createCursorProvider(): CodingAgentProvider {
  return {
    id: "cursor",
    getCapabilities: () => CURSOR_CAPABILITIES,
    async authenticate() {
      return {
        ok: true,
        verified: false,
        message: "Cursor uses the official SDK browser login. Prentice does not store a pasted key.",
      };
    },
    async startSession(input) {
      let cancel: (() => Promise<void>) | undefined;
      let dispose: (() => Promise<void>) | undefined;
      return {
        events: (async function* () {
          if (input.resumeThreadId) {
            yield {
              type: "session.failed" as const,
              code: "CONTINUATION_UNAVAILABLE",
              message:
                "Continuation is not available for Cursor. A live resume has not been verified, so Prentice will not start a new agent and call it continuation.",
              retryable: false,
            };
            return;
          }
          try {
            const sdk = await importSdk("@cursor/sdk");
            const Agent = sdk.Agent as {
              create(options: Record<string, unknown>): Promise<{
                send(prompt: string): Promise<CursorRun>;
                [Symbol.asyncDispose]?: () => Promise<void>;
              }>;
            };
            const Cursor = sdk.Cursor as { models: { list(options?: { apiKey?: string }): Promise<CursorModel[]> } };
            const model = await selectCursorModel(Cursor, input.profile);
            yield { type: "status" as const, title: "Cursor local agent", detail: model.note };
            const agent = await Agent.create({
              model: model.selection,
              local: { cwd: input.repoPath },
            });
            dispose = agent[Symbol.asyncDispose]?.bind(agent);
            const run = await agent.send(input.prompt);
            cancel = async () => {
              if (run.supports?.("cancel")) await run.cancel();
            };
            for await (const message of run.stream()) {
              if (input.signal.aborted) {
                await cancel();
                yield { type: "session.interrupted" as const };
                return;
              }
              yield* normalizeCursorMessage(message);
            }
            const result = await run.wait();
            if (result.status === "error") {
              yield {
                type: "session.failed" as const,
                code: "PROVIDER_ERROR",
                message: "Cursor finished the run with an error. The repository was not retried.",
                retryable: false,
              };
              return;
            }
            if (result.status === "cancelled") {
              yield { type: "session.interrupted" as const };
              return;
            }
            if (result.usage) {
              yield {
                type: "usage" as const,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
              };
            }
            yield { type: "session.completed" as const };
          } catch (error) {
            yield describeProviderFailure("Cursor", error, input.signal.aborted);
          }
        })(),
        async interrupt() {
          await cancel?.();
        },
        async disconnect() {
          await dispose?.();
        },
      };
    },
  };
}

interface CursorRun {
  stream(): AsyncIterable<unknown>;
  wait(): Promise<{ status: string; usage?: { inputTokens?: number; outputTokens?: number } }>;
  supports?(operation: string): boolean;
  cancel(): Promise<void>;
}

async function selectCursorModel(
  Cursor: { models: { list(options?: { apiKey?: string }): Promise<CursorModel[]> } },
  profile: ResolvedProfile,
): Promise<{ selection: { id: string; params?: Array<{ id: string; value: string }> }; note: string }> {
  const preference = cursorDepthPreference(profile.intensity);
  let models: CursorModel[] = [];
  try {
    models = await Cursor.models.list();
  } catch {
    return {
      selection: { id: "composer-2.5" },
      note: "Cursor's model catalog was unavailable. Prentice used the documented local default model id composer-2.5 and did not invent an effort level.",
    };
  }
  const composer = models.find((model) => model.id === "composer-2.5") ?? models[0];
  if (!composer) {
    return {
      selection: { id: "composer-2.5" },
      note: "The Cursor catalog was empty. Prentice used composer-2.5.",
    };
  }
  if (preference === "fast") {
    const fast = composer.parameters?.find((parameter) => parameter.id === "fast");
    const value = fast?.values?.find((entry) => entry.value === "true")?.value;
    if (value) {
      return {
        selection: { id: composer.id, params: [{ id: "fast", value }] },
        note: `Cursor model ${composer.id} with fast mode.`,
      };
    }
    return {
      selection: { id: composer.id },
      note: `${composer.id} has no fast param in this catalog. Cursor is choosing depth.`,
    };
  }
  if (preference === "stronger") {
    const stronger = models.find((model) => model.id !== composer.id && !model.id.includes("fast"));
    if (stronger) {
      return { selection: { id: stronger.id }, note: `Cursor model ${stronger.id}, chosen as a stronger listed model.` };
    }
    return {
      selection: { id: composer.id },
      note: "The catalog did not list a stronger model. Cursor is choosing depth.",
    };
  }
  return { selection: { id: composer.id }, note: `Cursor model ${composer.id}. Effort is not a Cursor control.` };
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
