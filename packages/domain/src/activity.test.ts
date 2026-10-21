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

describe("public conversation", () => {
  it("keeps progress and final words in order, suppresses operational noise, and retains failures", async () => {
    const { toConversationTimeline } = await import("./activity.js");
    const final = "Done. Vendor control and sandboxing are part of the design.";
    const events: NormalizedEvent[] = [
      { type: "session.started" }, { type: "status", title: "Agent started" },
      { type: "assistant", text: "I’m separating session state from the login form." },
      { type: "tool.started", name: "Bash", title: "Running a command", command: "npm test" },
      { type: "command.started", command: "npm test" },
      { type: "command.finished", command: "npm test", exitCode: 0 },
      { type: "tool.finished", name: "Write", title: "Edited auth.js", ok: true },
      { type: "file.changed", path: "auth.js", change: "added", source: "agent" },
      { type: "command.finished", command: "npm run lint", exitCode: 1, output: { source: "command-output", text: "lint failed", truncated: false } },
      { type: "assistant", text: final }, { type: "session.completed", summary: final },
      { type: "file.changed", path: "auth.js", change: "added", source: "git" },
    ];
    const timeline = toConversationTimeline(events);
    expect(timeline.map(item => item.title)).toEqual(["Agent", "Command failed", "Agent", "Added auth.js"]);
    expect(timeline[2]?.detail).toBe(final);
    expect(timeline[1]?.output?.text).toBe("lint failed");
    expect(events).toHaveLength(12); // diagnostics are preserved independently
  });
});
