import { describe, expect, it } from "vitest";
import { commandAllowed, toTimeline, type NormalizedEvent } from "./index.js";

describe("toTimeline", () => {
  it("keeps the git file record and drops the duplicate agent event", () => {
    const events: NormalizedEvent[] = [
      { type: "file.changed", path: "src/auth/middleware.ts", change: "modified", source: "agent" },
      { type: "file.changed", path: "src/auth/middleware.ts", change: "modified", source: "git" },
      {
        type: "assistant",
        text: "x".repeat(400),
      },
    ];
    const timeline = toTimeline(events);
    expect(timeline.filter((item) => item.title.includes("middleware.ts"))).toHaveLength(1);
    expect(timeline.some((item) => item.title === "Agent sent a long update")).toBe(false);
    expect(timeline.find((item) => item.title === "Agent")?.detail).toBe("x".repeat(400));
  });

  it("keeps the agent's reply, including a plan and a code sample", () => {
    const reply = "Use one file.\n\n```txt\nhello\n```";
    const timeline = toTimeline([
      { type: "assistant", text: reply },
      { type: "command.started", command: "rg hello" },
      { type: "session.completed", summary: reply },
      { type: "session.completed" },
    ]);
    expect(timeline.filter((item) => item.title === "Agent")).toEqual([
      expect.objectContaining({ detail: reply }),
    ]);
    expect(timeline.some((item) => item.title === "Session completed")).toBe(false);
    expect(timeline.some((item) => item.title === "Running command")).toBe(true);
  });
});

describe("commandAllowed", () => {
  it("blocks destructive commands and allows ordinary test commands", () => {
    expect(commandAllowed("git push origin main").allowed).toBe(false);
    expect(commandAllowed("rm -rf ./dist").allowed).toBe(false);
    expect(commandAllowed("npm test").allowed).toBe(true);
  });
});
