import type { EvidencePacket } from "@prentice/domain";
import { assembleUnderstand } from "@prentice/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discussLearning, evidenceSummary, explainEvidence, explanationSections, LEARNING_LIMITS, reliesOnAgentOnly, setLearningEndpoint } from "./learning.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setLearningEndpoint(null);
  vi.restoreAllMocks();
});

/** The audit case: git saw multiply added, npm test exited 1, and only the agent said "8 !== 2". */
function packet(withOutput: boolean): EvidencePacket {
  return {
    taskId: "t1",
    prompt: "SECRET ORIGINAL PROMPT: add multiply",
    files: [{ evidenceId: "f1", path: "math.js", change: "modified", additions: 4, deletions: 0 }],
    symbols: [{ evidenceId: "s1", path: "math.js", name: "multiply", kind: "function", change: "added" }],
    activity: [
      {
        evidenceId: "c1",
        title: "npm test",
        kind: "command.finished",
        command: "npm test",
        exitCode: 1,
        source: "agent",
        ...(withOutput ? { output: { source: "command-output" as const, text: "# pass 1\n# fail 1\nexpected 2, actual 8", truncated: false } } : {}),
      },
      { evidenceId: "a1", title: "Agent note", kind: "assistant", detail: "Ran npm test: 1 passed, 1 failed. The subtract test failed (`8 !== 2`).", source: "agent" },
      { evidenceId: "a2", title: "Agent note", kind: "assistant", detail: "x".repeat(5_000), source: "agent" },
    ],
    tests: null,
    projectName: "calc",
    unparsedLanguages: [],
    unparsedFiles: [],
  };
}

function groqReturns(result: unknown) {
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ result });
  }) as typeof fetch;
  setLearningEndpoint({ cloudUrl: "http://127.0.0.1:4740", token: "device" });
  return sent;
}

describe("Learning AI evidence boundary", () => {
  it("sends a bounded summary with agent material labelled Agent stated and no original prompt", () => {
    const summary = evidenceSummary(packet(true));
    const text = JSON.stringify(summary);
    expect(text).not.toContain("SECRET ORIGINAL PROMPT");
    expect(summary.agentStated.every((item) => item.label === "Agent stated")).toBe(true);
    expect(summary.agentStated.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(LEARNING_LIMITS.agentTotalChars + LEARNING_LIMITS.agentStatements);
    expect(summary.agentStated[1]?.truncated).toBe(true);
    expect(JSON.stringify(summary.observed)).not.toContain("8 !== 2");
    expect(summary.observed.commands[0]?.failureOutput?.source).toBe("command-output");
  });

  it("moves an 'observed' sentence that relies on the agent's words into Agent stated", async () => {
    groqReturns({
      observed: ["math.js gained the function multiply.", "The subtract test reported `8 !== 2`."],
      agentStated: ["The agent said it ran npm test once."],
      notRecorded: ["Why multiply was added was not recorded."],
    });
    const p = packet(false);
    const artifact = await explainEvidence(p, assembleUnderstand(p));
    const explanation = artifact.learning?.explanation ?? "";
    const [observed, agent] = explanation.split("\n\nAgent stated\n");
    expect(observed).toContain("multiply");
    expect(observed).not.toContain("8 !== 2");
    expect(agent).toContain("8 !== 2");
  });

  it("keeps the same sentence observed when Prentice recorded the failure output itself", () => {
    const summary = evidenceSummary(packet(true));
    expect(reliesOnAgentOnly("The test output said expected 2, actual 8.", summary)).toBe(false);
    expect(reliesOnAgentOnly("1 passed and 1 failed.", summary)).toBe(false);
    const sections = explanationSections({ observed: ["It reported `8 !== 2`."] }, summary);
    expect(sections?.agentStated).toEqual(["It reported `8 !== 2`."]);
  });

  it("relabels a discussion answer that presents an agent claim as observed", async () => {
    groqReturns({ kind: "observed", text: "The test failed because subtract returned `8 !== 2`." });
    const reply = await discussLearning(packet(false), "Why did the test fail?");
    expect(reply).toMatchObject({ kind: "agent-stated" });
  });

  it("does not let an old free-text explanation carry an agent claim as observed", () => {
    const summary = evidenceSummary(packet(false));
    const sections = explanationSections({ explanation: "Observed: the subtract test reported 8 !== 2." }, summary);
    expect(sections).toEqual({ observed: [], agentStated: ["Observed: the subtract test reported 8 !== 2."], notRecorded: [] });
  });
});

describe("Learning AI grounding by path", () => {
  it("keeps a sentence naming a path from the recorded failure output and drops one naming an unrecorded path", async () => {
    const p = packet(true);
    p.activity[0] = { ...p.activity[0]!, output: { source: "command-output", text: "at /repo/math.test.js:6:1\nexpected 2, actual 8", truncated: false } };
    groqReturns({
      observed: ["The failure was reported at /repo/math.test.js line 6.", "It also touched src/secret/config.ts."],
      agentStated: [],
      notRecorded: [],
    });
    const artifact = await explainEvidence(p, assembleUnderstand(p));
    expect(artifact.learning?.available).toBe(true);
    expect(artifact.learning?.explanation).toContain("/repo/math.test.js");
    expect(artifact.learning?.explanation).not.toContain("src/secret/config.ts");
  });
});
