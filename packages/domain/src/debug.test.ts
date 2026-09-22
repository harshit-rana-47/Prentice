import { describe, expect, it } from "vitest";
import { debugIssuesFromEvents, debugIssuesFromObservations, debugIssuesFromTimeline } from "./debug.js";
import { normalizeCodexEvent, toTimeline } from "./index.js";

describe("debug issues", () => {
  it("uses a recorded non-zero command exit and ignores an interrupt", () => {
    const failed = normalizeCodexEvent({
      type: "item.completed",
      item: { type: "command_execution", command: "npm test", exit_code: 1 },
    }).map((event, index) => ({ ...event, id: `cmd-${index}` }));
    expect(debugIssuesFromEvents(failed)).toEqual([
      { id: "cmd-0", symptom: "Command failed", evidence: "npm test" },
    ]);

    const stopped = toTimeline([{ id: "stop", type: "session.interrupted" }]);
    expect(debugIssuesFromTimeline(stopped)).toEqual([]);
  });

  it("treats a recorded test failure as an issue and ignores a clean run", () => {
    expect(debugIssuesFromObservations(["Tests reported 3 passed and 2 failed."])).toEqual([
      {
        id: "tests:Tests reported 3 passed and 2 failed.",
        symptom: "Tests failed",
        evidence: "Tests reported 3 passed and 2 failed.",
      },
    ]);
    expect(debugIssuesFromObservations(["Tests reported 4 passed and 0 failed."])).toEqual([]);
  });
});
