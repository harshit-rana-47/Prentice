import { describe, expect, it } from "vitest";
import { fixtureEvents, normalizeClaudeMessage, normalizeCodexEvent, normalizeCursorMessage } from "./index.js";

describe("provider normalizers", () => {
  it("maps a Claude tool use without treating it as the git record", () => {
    const events = normalizeClaudeMessage({
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "npm test" },
          },
        ],
      },
    });
    expect(events[0]).toMatchObject({ type: "command.started", command: "npm test" });
  });

  it("keeps a finished Codex reply and drops reasoning", () => {
    const started = normalizeCodexEvent({
      type: "item.started",
      item: { type: "agent_message", text: "Partial" },
    });
    expect(started).toEqual([]);
    const reasoning = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "reasoning", text: "hidden chain of thought" },
    });
    expect(reasoning).toEqual([]);
    expect(JSON.stringify(reasoning)).not.toContain("hidden chain of thought");
    const events = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "A git commit records a snapshot.\n\nIt does not upload the files." },
    });
    expect(events).toEqual([
      { type: "assistant", text: "A git commit records a snapshot.\n\nIt does not upload the files." },
    ]);
  });

  it("drops Claude thinking blocks and keeps the user-facing text", () => {
    const events = normalizeClaudeMessage({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "private scratchpad" },
          { type: "text", text: "Compare the two options in the repository." },
        ],
      },
    });
    expect(events).toEqual([{ type: "assistant", text: "Compare the two options in the repository." }]);
    expect(JSON.stringify(events)).not.toContain("private scratchpad");
  });

  it("maps Codex file and command items", () => {
    const events = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "file_change", path: "src/auth/middleware.ts", change: "add" },
    });
    expect(events[0]).toMatchObject({
      type: "file.changed",
      path: "src/auth/middleware.ts",
      source: "agent",
    });
  });

  it("maps a Codex file_change patch from a live session", () => {
    const started = normalizeCodexEvent({
      type: "item.started",
      item: { type: "file_change", status: "in_progress", changes: [{ path: "hello.txt", kind: "add" }] },
    });
    expect(started).toEqual([]);
    const events = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "file_change", status: "completed", changes: [{ path: "hello.txt", kind: "add" }] },
    });
    expect(events).toEqual([
      { type: "file.changed", path: "hello.txt", change: "added", source: "agent" },
    ]);
  });

  it("maps Cursor tool envelopes without reading unstable payloads", () => {
    const events = normalizeCursorMessage({
      type: "tool_call",
      name: "edit",
      status: "completed",
      args: { path: "src/secret.ts" },
    });
    expect(events[0]).toMatchObject({ type: "tool.finished", name: "edit" });
    expect(JSON.stringify(events)).not.toContain("secret.ts");
  });

  it("builds a fixture script that does not invent a git diff", () => {
    const events = fixtureEvents({ path: "prentice-fixture/session-note.ts", symbol: "attachSessionNote" });
    expect(events.some((event) => event.type === "file.changed")).toBe(false);
    expect(events.at(-1)?.type).toBe("session.completed");
  });
});
