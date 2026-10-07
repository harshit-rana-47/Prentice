import { boundFailureOutput } from "./output.js";
import type { NormalizedEvent } from "./types.js";

/** Representative Claude Agent SDK messages. The adapter maps these; tests do not call the API. */
export function normalizeClaudeMessage(message: unknown): NormalizedEvent[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  if (record.type === "system" && record.subtype === "init") {
    return [{ type: "session.started", providerSessionId: stringField(record, "session_id") }];
  }
  if (record.type === "assistant") {
    return contentBlocks(record.message);
  }
  if (record.type === "result") {
    if (record.is_error === true) {
      return [
        {
          type: "session.failed",
          code: "PROVIDER_ERROR",
          message: stringField(record, "result") ?? "Claude Code reported an error.",
          retryable: false,
        },
      ];
    }
    const usage = record.usage;
    const events: NormalizedEvent[] = [];
    if (usage && typeof usage === "object") {
      const tokens = usage as Record<string, unknown>;
      events.push({
        type: "usage",
        inputTokens: numberField(tokens, "input_tokens"),
        outputTokens: numberField(tokens, "output_tokens"),
      });
    }
    events.push({ type: "session.completed", summary: stringField(record, "result") });
    return events;
  }
  return [];
}

function contentBlocks(message: unknown): NormalizedEvent[] {
  if (!message || typeof message !== "object") return [];
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return [];
  const events: NormalizedEvent[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const item = block as Record<string, unknown>;
    if (item.type === "thinking" || item.type === "redacted_thinking") continue;
    if (item.type === "text" && typeof item.text === "string") {
      events.push({ type: "assistant", text: item.text });
    }
    if (item.type === "tool_use" && typeof item.name === "string") {
      const input = item.input as Record<string, unknown> | undefined;
      const command = typeof input?.command === "string" ? input.command : undefined;
      const path = typeof input?.file_path === "string" ? input.file_path : typeof input?.path === "string" ? input.path : undefined;
      if (command) events.push({ type: "command.started", command });
      events.push({
        type: "tool.started",
        name: item.name,
        title: toolTitle(item.name, path, command),
        path,
        command,
      });
    }
  }
  return events;
}

/** Representative Codex SDK thread events. */
export function normalizeCodexEvent(event: unknown): NormalizedEvent[] {
  if (!event || typeof event !== "object") return [];
  const record = event as Record<string, unknown>;
  if (record.type === "thread.started") {
    return [{ type: "session.started", providerSessionId: stringField(record, "thread_id") }];
  }
  if (record.type === "turn.failed") {
    const error = record.error as Record<string, unknown> | undefined;
    return [
      {
        type: "session.failed",
        code: "PROVIDER_ERROR",
        message: typeof error?.message === "string" ? error.message : "Codex turn failed.",
        retryable: false,
      },
    ];
  }
  if (record.type === "turn.completed") {
    const usage = record.usage as Record<string, unknown> | undefined;
    const events: NormalizedEvent[] = [];
    if (usage) {
      events.push({
        type: "usage",
        inputTokens: numberField(usage, "input_tokens"),
        outputTokens: numberField(usage, "output_tokens"),
      });
    }
    events.push({ type: "session.completed" });
    return events;
  }
  if (record.type === "item.completed" || record.type === "item.started") {
    return codexItem(record.item, record.type === "item.completed");
  }
  return [];
}

function codexItem(item: unknown, finished: boolean): NormalizedEvent[] {
  if (!item || typeof item !== "object") return [];
  const record = item as Record<string, unknown>;
  if (record.type === "reasoning") return [];
  if (record.type === "agent_message" && typeof record.text === "string") {
    if (!finished || record.text.trim().length === 0) return [];
    return [{ type: "assistant", text: record.text }];
  }
  if (record.type === "command_execution" && typeof record.command === "string") {
    if (!finished) return [{ type: "command.started", command: record.command }];
    const exitCode = typeof record.exit_code === "number" ? record.exit_code : null;
    const output = exitCode !== 0 ? boundFailureOutput(record.aggregated_output) : undefined;
    return [{ type: "command.finished", command: record.command, exitCode, ...(output ? { output } : {}) }];
  }
  if (record.type === "file_change") {
    if (!finished) return [];
    if (Array.isArray(record.changes)) {
      return record.changes.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const change = entry as Record<string, unknown>;
        if (typeof change.path !== "string") return [];
        return [fileChanged(change.path, change.kind)];
      });
    }
    if (typeof record.path === "string") return [fileChanged(record.path, record.change)];
  }
  return [];
}

function fileChanged(path: string, kind: unknown): NormalizedEvent {
  const change = kind === "delete" ? "deleted" : kind === "add" ? "added" : "modified";
  return { type: "file.changed", path, change, source: "agent" };
}

/** Claude Code reports a missing sign-in as a synthetic assistant reply. That is setup, not agent work. */
export const CLAUDE_SIGNED_OUT = /not logged in|please run \/login|invalid api key|oauth token has expired|authentication_failed|login required/i;

/**
 * Stateful normalizer for `claude -p --output-format stream-json --verbose`.
 * It pairs a Bash tool_use with its tool_result so a failed command keeps a bounded slice of its output.
 */
export function createClaudeStreamNormalizer(): (message: unknown) => NormalizedEvent[] {
  const commands = new Map<string, string>();
  let signedOut = false;
  return (message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.type === "assistant") {
      const inner = record.message as Record<string, unknown> | undefined;
      const text = assistantText(inner);
      if (inner?.model === "<synthetic>" && text && CLAUDE_SIGNED_OUT.test(text)) {
        if (signedOut) return [];
        signedOut = true;
        return [signedOutFailure()];
      }
      for (const block of blocks(inner)) {
        if (block.type === "tool_use" && typeof block.id === "string") {
          const input = block.input as Record<string, unknown> | undefined;
          if (typeof input?.command === "string") commands.set(block.id, input.command);
        }
      }
      return normalizeClaudeMessage(record);
    }
    if (record.type === "user") {
      const events: NormalizedEvent[] = [];
      for (const block of blocks(record.message as Record<string, unknown> | undefined)) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const command = commands.get(block.tool_use_id);
        if (!command) continue;
        commands.delete(block.tool_use_id);
        const text = toolResultText(block.content);
        const exit = /^\s*(?:Error: )?Exit code (\d+)/m.exec(text);
        if (block.is_error === true && !exit) {
          events.push({ type: "tool.finished", name: "Bash", title: "Command not run", command, ok: false, detail: firstLine(text) });
          continue;
        }
        const exitCode = exit ? Number(exit[1]) : 0;
        const output = exitCode !== 0 ? boundFailureOutput(text) : undefined;
        events.push({ type: "command.finished", command, exitCode, ...(output ? { output } : {}) });
      }
      return events;
    }
    if (record.type === "result" && record.is_error === true) {
      const text = typeof record.result === "string" ? record.result : "";
      if (CLAUDE_SIGNED_OUT.test(text)) {
        if (signedOut) return [];
        signedOut = true;
        return [signedOutFailure()];
      }
    }
    return normalizeClaudeMessage(record);
  };
}

function signedOutFailure(): NormalizedEvent {
  return {
    type: "session.failed",
    code: "AGENT_SIGNED_OUT",
    message: "Claude Code is installed but not signed in on this computer. Sign in to Claude Code, then send the task again.",
    retryable: false,
  };
}

function blocks(message: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const content = message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object");
}

function assistantText(message: Record<string, unknown> | undefined): string {
  return blocks(message)
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .join("\n");
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.slice(0, 300) ?? "";
}

/** Cursor CLI reports a missing sign-in on stderr before any stream event. */
export const CURSOR_SIGNED_OUT = /authentication required|not logged in|please run '?agent login'?|invalid (user )?api key|unauthori[sz]ed/i;

/**
 * Stateful normalizer for the official Cursor CLI: `agent -p --output-format stream-json`.
 * Tool payloads are read only for the shell command, its exit code, and a failure's bounded output.
 */
export function createCursorStreamNormalizer(): (message: unknown) => NormalizedEvent[] {
  const started = new Map<string, string>();
  return (message) => {
    if (!message || typeof message !== "object") return [];
    const record = message as Record<string, unknown>;
    if (record.type === "system" && record.subtype === "init") {
      return [{ type: "session.started", providerSessionId: stringField(record, "session_id") }];
    }
    if (record.type === "assistant") {
      const text = assistantText(record.message as Record<string, unknown> | undefined);
      return text.trim() ? [{ type: "assistant", text }] : [];
    }
    if (record.type === "tool_call") {
      const call = cursorToolCall(record.tool_call);
      if (!call) return [];
      const id = typeof record.call_id === "string" ? record.call_id : "";
      if (record.subtype === "started") {
        if (call.command) {
          if (id) started.set(id, call.command);
          return [{ type: "command.started", command: call.command }];
        }
        return [{ type: "tool.started", name: call.name, title: cursorToolTitle(call.name, call.path), path: call.path }];
      }
      if (record.subtype === "completed") {
        const command = call.command ?? (id ? started.get(id) : undefined);
        if (id) started.delete(id);
        if (command) {
          const exitCode = call.exitCode ?? (call.failed ? null : 0);
          const failed = exitCode !== 0;
          const output = failed ? boundFailureOutput(call.output) : undefined;
          return [{ type: "command.finished", command, exitCode, ...(output ? { output } : {}) }];
        }
        return [
          { type: "tool.finished", name: call.name, title: cursorToolTitle(call.name, call.path), path: call.path, ok: !call.failed },
        ];
      }
      return [];
    }
    if (record.type === "result") {
      if (record.is_error === true) {
        const text = typeof record.result === "string" ? record.result : "Cursor reported an error.";
        if (CURSOR_SIGNED_OUT.test(text)) {
          return [{ type: "session.failed", code: "AGENT_SIGNED_OUT", message: cursorSignedOutMessage(), retryable: false }];
        }
        return [{ type: "session.failed", code: "PROVIDER_ERROR", message: text, retryable: false }];
      }
      const usage = record.usage as Record<string, unknown> | undefined;
      const events: NormalizedEvent[] = [];
      if (usage) {
        events.push({ type: "usage", inputTokens: numberField(usage, "inputTokens") ?? numberField(usage, "input_tokens"), outputTokens: numberField(usage, "outputTokens") ?? numberField(usage, "output_tokens") });
      }
      events.push({ type: "session.completed" });
      return events;
    }
    return [];
  };
}

export function cursorSignedOutMessage(): string {
  return "Cursor is installed but not signed in on this computer. Connect Cursor, then send the task again.";
}

interface CursorCall {
  name: string;
  command?: string;
  path?: string;
  exitCode?: number | null;
  failed: boolean;
  output?: string;
}

function cursorToolCall(value: unknown): CursorCall | null {
  if (!value || typeof value !== "object") return null;
  const entries = Object.entries(value as Record<string, unknown>);
  const found = entries.find(([key]) => key.endsWith("ToolCall")) ?? entries[0];
  if (!found) return null;
  const [key, body] = found;
  const name = key.replace(/ToolCall$/, "") || "tool";
  const call = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const args = (call.args && typeof call.args === "object" ? call.args : {}) as Record<string, unknown>;
  const command = typeof args.command === "string" ? args.command : undefined;
  const path = typeof args.path === "string" ? args.path : typeof args.filePath === "string" ? args.filePath : undefined;
  const result = (call.result && typeof call.result === "object" ? call.result : {}) as Record<string, unknown>;
  const outcomeKey = Object.keys(result)[0];
  const outcome = (outcomeKey ? result[outcomeKey] : undefined) as Record<string, unknown> | undefined;
  const failed = outcomeKey !== undefined && outcomeKey !== "success";
  const exitCode = typeof outcome?.exitCode === "number" ? outcome.exitCode : undefined;
  const pieces = [outcome?.stdout, outcome?.stderr, outcome?.error, outcome?.message].filter((piece): piece is string => typeof piece === "string" && piece.trim().length > 0);
  return { name, command, path, exitCode, failed: failed || (exitCode !== undefined && exitCode !== 0), output: pieces.join("\n") || undefined };
}

function cursorToolTitle(name: string, path?: string): string {
  if (/shell|terminal|command/i.test(name)) return "Running a command";
  if (/edit|write|delete/i.test(name)) return path ? `Editing ${path}` : "Editing files";
  if (/read|grep|glob|ls|search/i.test(name)) return "Reading the repository";
  return `Tool: ${name}`;
}

function toolTitle(name: string, path?: string, command?: string): string {
  if (command) return "Running a command";
  if (path && /edit|write|notebook/i.test(name)) return `Editing ${path}`;
  if (/read|grep|glob|ls/i.test(name)) return "Reading the repository";
  return `Tool: ${name}`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  return typeof record[key] === "number" ? record[key] : undefined;
}

export function fixtureEvents(input: { path: string; symbol: string }): NormalizedEvent[] {
  return [
    { type: "session.started", providerSessionId: "fixture" },
    { type: "status", title: "Reading the repository", detail: "Local file names and git status only." },
    {
      type: "status",
      title: `Writing ${input.path}`,
      detail: "The fixture provider is Prentice, not a coding agent. Git will record the file change.",
    },
    {
      type: "status",
      title: "Sample symbol written",
      detail: `Wrote ${input.symbol} in ${input.path}. This note is from Prentice, not from a coding agent.`,
    },
    { type: "session.completed", summary: "Fixture session finished." },
  ];
}
