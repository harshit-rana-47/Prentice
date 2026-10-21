import type { EvidencePacket } from "@prentice/domain";
import { assembleUnderstand } from "@prentice/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discussLearning, evidenceSummary, explainEvidence, explanationSections, judgeLearningAnswer, phraseQuestion, LEARNING_LIMITS, setLearningEndpoint } from "./learning.js";

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
  it("bounds inline command and session diagnostics without truncating canonical facts", async () => {
    const p = packet(true);
    p.activity[0]!.command = "node -e " + "x".repeat(20_000) + "PRIVATE_COMMAND_TAIL";
    p.activity.push({ evidenceId: "failure", title: "Failure", kind: "session.failed", detail: "y".repeat(20_000), source: "agent" });
    const summary = evidenceSummary(p);
    expect(summary.observed.commands[0]!.command).toBeUndefined();
    expect(summary.observed.sessionFailures[0]!.length).toBe(LEARNING_LIMITS.failureOutputChars);
    expect(summary.facts!.every((fact) => fact.text.length <= LEARNING_LIMITS.factChars)).toBe(true);
    expect(summary.facts!.map((fact) => fact.id)).toEqual(["fact:0"]);
    expect(JSON.stringify(summary)).not.toContain("PRIVATE_COMMAND_TAIL");
    const sent = groqReturns({ question: "What failed?", understood: true });
    const question = { id: "large", prompt: "What failed?", concept: "command", expectedPoints: [p.activity[0]!.command!], grounding: "observed" as const, citations: [{ evidenceId: "c1" }] };
    expect(await phraseQuestion(p, question)).toBeNull();
    expect(await judgeLearningAnswer(p, question, "It failed.")).toMatchObject({ ok: false });
    expect(sent).toHaveLength(0);
  });
  it("never promotes an unquoted fabricated claim and only returns canonical referenced discussion facts", async () => {
    const p = packet(false);
    groqReturns({observed:["The change prevents SQL injection."],agentStated:[],notRecorded:[]});
    const artifact = await explainEvidence(p,assembleUnderstand(p));
    const explanation = artifact.learning!.explanation!;
    expect(explanation.split("\n\nInterpretation")[0]).not.toContain("prevents SQL injection");
    groqReturns({kind:"observed",factId:"fact:0",text:"The change prevents SQL injection."});
    expect(await discussLearning(p,"What changed?")).toEqual({kind:"observed",text:"Modified math.js (+4 / -0)."});
  });
  it("tells Learning AI interrupted work is partial and file attribution can be unavailable", () => {
    const p = packet(false); p.outcome="interrupted"; p.attribution="unavailable"; p.files=[]; p.symbols=[];
    const summary=evidenceSummary(p);
    const sections=explanationSections({observed:["Task completed successfully."]},summary)!;
    expect(summary.outcome).toBe("interrupted");
    expect(sections.notRecorded.join(" ")).toContain("interrupted");
    expect(sections.observed.join(" ")).not.toContain("completed successfully");
  });
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

  it("uses deterministic observations and preserves original agent statements separately", async () => {
    groqReturns({
      observed: ["math.js gained the function multiply.", "The subtract test reported `8 !== 2`."],
      agentStated: ["The agent said it ran npm test once."],
      notRecorded: ["Why multiply was added was not recorded."],
    });
    const p = packet(false);
    const artifact = await explainEvidence(p, assembleUnderstand(p));
    const explanation = artifact.learning?.explanation ?? "";
    const [observed, agent] = explanation.split("\n\nAgent stated\n");
    expect(observed).toContain("math.js");
    expect(observed).not.toContain("Added function multiply");
    expect(observed).not.toContain("8 !== 2");
    expect(agent?.split("\n\nInterpretation")[0]).toContain("8 !== 2");
    expect(explanation).toContain("Interpretation (Learning AI)");
  });

  it("keeps model prose as interpretation even when the output contains similar tokens", () => {
    const summary = evidenceSummary(packet(true));

    const sections = explanationSections({ observed: ["It reported `8 !== 2`."] }, summary);
    expect(sections?.inferences).toEqual(["It reported `8 !== 2`."]);
  });

  it("relabels a discussion answer that presents an agent claim as observed", async () => {
    groqReturns({ kind: "observed", text: "The test failed because subtract returned `8 !== 2`." });
    const reply = await discussLearning(packet(false), "Why did the test fail?");
    expect(reply).toMatchObject({ kind: "inference" });
  });

  it("does not let an old free-text explanation carry an agent claim as observed", () => {
    const summary = evidenceSummary(packet(false));
    const sections = explanationSections({ explanation: "Observed: the subtract test reported 8 !== 2." }, summary);
    expect(sections?.observed).not.toContain("Observed: the subtract test reported 8 !== 2.");
    expect(sections?.inferences).toEqual(["Observed: the subtract test reported 8 !== 2."]);
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
