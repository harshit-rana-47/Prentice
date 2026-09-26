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
    return [{ type: "command.finished", command: record.command, exitCode }];
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

/**
 * Cursor stream envelopes. Tool args are intentionally ignored:
 * the public docs say those payloads are not a stable contract.
 */
export function normalizeCursorMessage(message: unknown): NormalizedEvent[] {
  if (!message || typeof message !== "object") return [];
  const record = message as Record<string, unknown>;
  if (record.type === "assistant") {
    const text = cursorAssistantText(record.message);
    return text ? [{ type: "assistant", text }] : [];
  }
  if (record.type === "tool_call" && typeof record.name === "string") {
    const status = record.status === "completed" ? "completed" : "running";
    const title = cursorToolTitle(record.name);
    if (status === "running") {
      return [{ type: "tool.started", name: record.name, title }];
    }
    return [{ type: "tool.finished", name: record.name, title, ok: record.status !== "error" }];
  }
  if (record.type === "status" && typeof record.message === "string") {
    return [{ type: "status", title: record.message }];
  }
  return [];
}

function cursorAssistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as Record<string, unknown>).content;
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const item = block as Record<string, unknown>;
      return item.type === "text" && typeof item.text === "string" ? item.text : "";
    })
    .filter(Boolean);
  return parts.join("") || undefined;
}

function cursorToolTitle(name: string): string {
  if (name === "shell") return "Running a command";
  if (name === "edit" || name === "write") return "Editing files";
  if (name === "read" || name === "grep" || name === "glob") return "Reading the repository";
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
