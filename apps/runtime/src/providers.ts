import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
          try {
            const sdk = await importSdk("@anthropic-ai/claude-agent-sdk");
            const query = sdk.query as (args: Record<string, unknown>) => AsyncIterable<unknown> & {
              interrupt?: () => Promise<void>;
            };
            const handle = query({
              prompt: input.prompt,
              options: {
                cwd: input.repoPath,
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
      return {
        events: (async function* () {
          try {
            const sdk = await importSdk("@openai/codex-sdk");
            const Codex = sdk.Codex as new (options?: { apiKey?: string }) => {
              startThread(options: Record<string, unknown>): {
                runStreamed(prompt: string): Promise<{ events: AsyncIterable<unknown> }>;
              };
            };
            const codex = new Codex();
            const thread = codex.startThread({
              workingDirectory: input.repoPath,
              skipGitRepoCheck: false,
              modelReasoningEffort: codexEffort(input.profile.intensity, input.profile.useProviderMax),
              sandboxMode: "workspace-write",
            });
            yield {
              type: "status" as const,
              title: "Codex is running in this repository",
              detail: `${input.profile.summary} Destructive commands are not auto-retried. Codex sandboxing is the vendor control Prentice can set here.`,
            };
            const { events } = await thread.runStreamed(input.prompt);
            for await (const event of events) {
              if (input.signal.aborted) {
                yield { type: "session.interrupted" as const };
                return;
              }
              const command = codexCommand(event);
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
              yield* normalizeCodexEvent(event);
            }
          } catch (error) {
            yield describeProviderFailure("Codex", error, input.signal.aborted);
          }
        })(),
        async interrupt() {},
        async disconnect() {},
      };
    },
  };
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
