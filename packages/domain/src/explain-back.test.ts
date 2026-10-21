import { describe, expect, it } from "vitest";
import { applyExplainJudgment, continueExplainSession, draftCandidateQuestions, explainBackPolicy, judgeAnswer, skipExplainSession, startExplainSession, type EvidencePacket, type LearningConcept } from "./index.js";

const packet: EvidencePacket = { taskId: "t", prompt: "Add validation", projectName: "sample", files: [{ evidenceId: "f", path: "input.js", change: "modified", additions: 4, deletions: 0 }], symbols: [{ evidenceId: "s", path: "input.js", name: "validate", kind: "function", change: "added" }], activity: [], tests: null, unparsedLanguages: [], unparsedFiles: [] };
const validation: LearningConcept = { title: "Validation at a boundary", explanation: "Reject invalid input before changing state.", mechanism: "Check inputs before writing data; rejection preserves the previous state.", tradeoff: "Client checks improve feedback but cannot protect a server.", transfer: "What if a caller bypasses the form?", grounding: "inference", basis: [{ id: "f", kind: "observed", text: "input.js changed" }], question: "Why should input be validated before changing stored state?", expectedPoints: ["reject invalid input before modifying state", "preserve existing data when validation fails"] };
const judgment = (understood: boolean) => ({ understood, feedback: understood ? "You explained the cause and effect." : "Explain what happens to existing state.", hint: "Think about the order of operations." });

it("does not turn a symbol inventory into a quiz", () => {
  expect(draftCandidateQuestions(packet, explainBackPolicy({ complexity: "low", changedFiles: 1, changedSymbols: 100 }))).toEqual([]);
  expect(startExplainSession(packet, "low").current).toBeNull();
});
it("helper count does not inflate the learning workload", () => {
  expect(explainBackPolicy({ complexity: "low", changedFiles: 1, changedSymbols: 100 }).maxInitialQuestions).toBe(1);
  expect(explainBackPolicy({ complexity: "high", changedFiles: 8, changedSymbols: 1 }).maxInitialQuestions).toBe(4);
});
describe("concept coaching", () => {
  it("keeps specific conceptual hints and updates them after further misses", () => {
    let state=startExplainSession(packet,"low",[],[validation]);
    const first="To preserve existing data when validation fails, which operation must not run?";
    state=applyExplainJudgment(state,{understood:false,feedback:"You need to explain why rejection protects state.",hint:first});
    expect(state.hint).toBe(first);
    const second="Imagine an old value of Ada and an invalid blank replacement. Trace whether the write is reached.";
    state=applyExplainJudgment(state,{understood:false,feedback:"Trace the invalid-input branch.",hint:second});
    expect(state.phase).toBe("taught");
    expect(state.hint).toBe(second);
  });
  it("hints, teaches the mechanism, and remembers only a semantically demonstrated concept", () => {
    const state = startExplainSession(packet, "low", [], [validation]);
    expect(state.current?.prompt).toContain("Why");
    expect(state.current?.prompt).not.toContain("input.js");
    const miss = applyExplainJudgment(state, judgment(false));
    expect(miss.phase).toBe("asking");
    expect(miss.feedback.understood).toEqual([]);
    const teach = applyExplainJudgment(miss, judgment(false));
    expect(teach.phase).toBe("taught");
    expect(teach.teaching).toContain("before writing data");
    const recovered = applyExplainJudgment(teach, judgment(true));
    expect(recovered.phase).toBe("done");
    expect(recovered.feedback).toEqual({ understood: [validation.title], unclear: [] });
    expect(recovered.asked).toHaveLength(1);
  });
  it("never uses keyword matching to mark a conceptual answer understood", () => {
    const state = startExplainSession(packet, "low", [], [validation]);
    expect(judgeAnswer(state.current!, validation.expectedPoints.join(" ")).understood).toEqual([]);
    expect(judgeAnswer(state.current!, "validate was added in input.js").unclear).toContain(validation.title);
  });
  it("avoids repeated mastered topics, allows skipping, and bounds failed coaching", () => {
    expect(startExplainSession(packet, "moderate", [validation.title], [validation]).current).toBeNull();
    let state = startExplainSession(packet, "low", [], [validation]);
    expect(skipExplainSession(state).phase).toBe("skipped");
    state = applyExplainJudgment(state, judgment(false));
    state = applyExplainJudgment(state, judgment(false));
    state = applyExplainJudgment(state, judgment(false));
    expect(state.phase).toBe("taught");
    expect(continueExplainSession(state).phase).toBe("done");
    expect(state.feedback.understood).toEqual([]);
    expect(state.feedback.unclear).toContain(validation.title);
  });
});

it('moving forward without answering leaves the concept unassessed rather than incorrect',()=>{
 const state=startExplainSession(packet,'low',[],[validation]);
 const done=continueExplainSession(state);
 expect(done.phase).toBe('done');expect(done.feedback).toEqual({understood:[],unclear:[]});
});
