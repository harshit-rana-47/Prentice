import { describe, expect, it } from "vitest";
import { debugIssuesFromEvents, debugIssuesFromObservations, debugIssuesFromTimeline } from "./debug.js";
import { normalizeCodexEvent, toConversationTimeline, toTimeline } from "./index.js";

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

it("requires positive command/tool failure evidence and excludes every provider/setup/crash failure", () => {
  for (const code of ["AGENT_NOT_INSTALLED","AGENT_SIGNED_OUT","PROVIDER_ERROR","PROVIDER_UNAVAILABLE","AUTHENTICATION_FAILED","RUNTIME_DISCONNECTED","UNKNOWN"]) {
    expect(debugIssuesFromEvents([{ type:"session.failed", code, message:"failed", retryable:false }])).toEqual([]);
  }
  expect(debugIssuesFromEvents([{type:"command.finished",command:"npm test",exitCode:null}])).toEqual([]);
  expect(debugIssuesFromEvents([{type:"tool.finished",name:"test",title:"Test tool",ok:false,detail:"assertion failed"}])).toHaveLength(1);
});

it("shows a recorded runner failure even when a pipeline masks its shell exit status", () => {
  const event = { id: "piped", type: "command.finished" as const, command: "node --test example.test.js | grep fail", exitCode: 0, tests: { passed: 0, failed: 1 } };
  const issues = debugIssuesFromEvents([event]);
  expect(issues).toHaveLength(1);
  expect(issues[0]).toMatchObject({ id: "piped", symptom: "Tests failed" });
  expect(issues[0]!.evidence).toContain("Tests reported 0 passed and 1 failed.");
  expect(issues[0]!.evidence).toContain("Shell command exited 0.");
  expect(toConversationTimeline([event])[0]).toMatchObject({ tone: "fail", code: "TESTS_FAILED" });
  expect(event.exitCode).toBe(0);
});
