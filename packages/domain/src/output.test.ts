import { describe, expect, it } from "vitest";
import { FAILURE_OUTPUT_MAX_CHARS, FAILURE_OUTPUT_MAX_LINES, boundFailureOutput, parseTestSummary } from "./output.js";
import { debugIssuesFromEvents } from "./debug.js";

describe("failure output", () => {
  it("keeps only a bounded tail and marks truncation", () => {
    const raw = Array.from({ length: 500 }, (_, index) => `line ${index} ${"x".repeat(60)}`).join("\n");
    const bounded = boundFailureOutput(raw)!;
    expect(bounded.text.length).toBeLessThanOrEqual(FAILURE_OUTPUT_MAX_CHARS);
    expect(bounded.text.split("\n").length).toBeLessThanOrEqual(FAILURE_OUTPUT_MAX_LINES);
    expect(bounded.text).toContain("line 499");
    expect(bounded.text).not.toContain("line 0 ");
    expect(bounded.truncated).toBe(true);
    expect(bounded.source).toBe("command-output");
  });

  it("strips terminal colour codes and redacts secrets", () => {
    const bounded = boundFailureOutput("\u001b[31mFAIL\u001b[0m token=abc123 sk-abcdefghijklmnop")!;
    expect(bounded.text).toBe("FAIL [redacted] [redacted]");
  });

  it("returns nothing for empty output", () => {
    expect(boundFailureOutput("  \n ")).toBeUndefined();
    expect(boundFailureOutput(undefined)).toBeUndefined();
  });

  it("reads explicit test runner summaries and nothing else", () => {
    expect(parseTestSummary("ok 1 - add\nnot ok 2 - subtract\n# tests 2\n# pass 1\n# fail 1")).toEqual({ passed: 1, failed: 1 });
    expect(parseTestSummary(" Tests  2 failed | 5 passed (7)")).toEqual({ passed: 5, failed: 2 });
    expect(parseTestSummary("Tests:       1 failed, 3 passed, 4 total")).toEqual({ passed: 3, failed: 1 });
    expect(parseTestSummary("=========== 1 failed, 2 passed in 0.12s ===========")).toEqual({ passed: 2, failed: 1 });
    expect(parseTestSummary("Everything is broken")).toBeNull();
  });
});

describe("debug issues", () => {
  it("carries the failed command's output and skips setup failures", () => {
    const issues = debugIssuesFromEvents([
      { type: "command.finished", command: "npm test", exitCode: 1, output: { source: "command-output", text: "8 !== 2", truncated: false } },
      { type: "session.failed", code: "AGENT_SIGNED_OUT", message: "Claude Code is not signed in.", retryable: false },
      { type: "session.failed", code: "SESSION_ENDED", message: "Prentice stopped.", retryable: false },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ symptom: "Command failed", evidence: "npm test", output: { text: "8 !== 2" } });
  });

  it("does not invent output when none was recorded", () => {
    const issues = debugIssuesFromEvents([{ type: "command.finished", command: "make", exitCode: 2 }]);
    expect(issues[0]?.output).toBeUndefined();
  });
});
