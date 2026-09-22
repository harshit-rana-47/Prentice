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
