import { describe, expect, it } from "vitest";
import {
  createClaudeStreamNormalizer,
  createCursorStreamNormalizer,
  fixtureEvents,
  normalizeClaudeMessage,
  normalizeCodexEvent,
} from "./index.js";

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

  it("maps Cursor CLI stream-json shell calls, keeping only a failed command's bounded output", () => {
    const next = createCursorStreamNormalizer();
    expect(next({ type: "system", subtype: "init", session_id: "chat-1" })).toEqual([
      { type: "session.started", providerSessionId: "chat-1" },
    ]);
    expect(
      next({ type: "tool_call", subtype: "started", call_id: "c1", tool_call: { shellToolCall: { args: { command: "npm test" } } } }),
    ).toEqual([{ type: "command.started", command: "npm test" }]);
    const finished = next({
      type: "tool_call",
      subtype: "completed",
      call_id: "c1",
      tool_call: {
        shellToolCall: {
          args: { command: "npm test" },
          result: { success: { exitCode: 1, stdout: "# pass 1\n# fail 1", stderr: "AssertionError: 8 !== 2" } },
        },
      },
    });
    expect(finished[0]).toMatchObject({ type: "command.finished", command: "npm test", exitCode: 1 });
    expect(finished[0]?.type === "command.finished" && finished[0].output?.text).toContain("8 !== 2");
    const ok = next({
      type: "tool_call",
      subtype: "completed",
      call_id: "c2",
      tool_call: { shellToolCall: { args: { command: "ls" }, result: { success: { exitCode: 0, stdout: "secret listing" } } } },
    });
    expect(ok[0]).toEqual({ type: "command.finished", command: "ls", exitCode: 0 });
    expect(JSON.stringify(ok)).not.toContain("secret listing");
  });

  it("reads a Cursor edit tool as activity and a sign-in error as a setup failure", () => {
    const next = createCursorStreamNormalizer();
    expect(
      next({ type: "tool_call", subtype: "started", call_id: "e1", tool_call: { editToolCall: { args: { path: "src/a.ts" } } } }),
    ).toEqual([{ type: "tool.started", name: "edit", title: "Editing src/a.ts", path: "src/a.ts" }]);
    expect(next({ type: "result", is_error: true, result: "Authentication required. Please run 'agent login' first." })[0]).toMatchObject({
      type: "session.failed",
      code: "AGENT_SIGNED_OUT",
    });
  });

  it("turns Claude Code's synthetic not-logged-in reply into one sign-in failure, not an agent reply", () => {
    const next = createClaudeStreamNormalizer();
    const events = [
      ...next({ type: "system", subtype: "init", session_id: "s1" }),
      ...next({
        type: "assistant",
        message: { model: "<synthetic>", content: [{ type: "text", text: "Not logged in · Please run /login" }] },
      }),
      ...next({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
    ];
    expect(events.filter((event) => event.type === "assistant")).toEqual([]);
    expect(events.filter((event) => event.type === "session.failed")).toEqual([
      expect.objectContaining({ code: "AGENT_SIGNED_OUT" }),
    ]);
  });

  it("pairs a Claude Code Bash tool_use with its tool_result and keeps output only on failure", () => {
    const next = createClaudeStreamNormalizer();
    next({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }] } });
    next({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] } });
    const failed = next({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "Exit code 1\nnot ok 2 - subtract\n  expected: 2\n  actual: 8" }] },
    });
    expect(failed[0]).toMatchObject({ type: "command.finished", command: "npm test", exitCode: 1 });
    expect(failed[0]?.type === "command.finished" && failed[0].output?.source).toBe("command-output");
    const passed = next({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "README.md" }] } });
    expect(passed).toEqual([{ type: "command.finished", command: "ls", exitCode: 0 }]);
  });

  it("keeps Codex aggregated output only for a failed command", () => {
    const failed = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test", exit_code: 1, aggregated_output: "✖ subtract\n8 !== 2" },
    });
    expect(failed[0]).toMatchObject({ exitCode: 1, output: { source: "command-output", text: "✖ subtract\n8 !== 2", truncated: false } });
    const passed = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "cat .env", exit_code: 0, aggregated_output: "SECRET=1" },
    });
    expect(JSON.stringify(passed)).not.toContain("SECRET");
  });

  it("builds a fixture script that does not invent a git diff", () => {
    const events = fixtureEvents({ path: "prentice-fixture/session-note.ts", symbol: "attachSessionNote" });
    expect(events.some((event) => event.type === "file.changed")).toBe(false);
    expect(events.at(-1)?.type).toBe("session.completed");
  });
});
