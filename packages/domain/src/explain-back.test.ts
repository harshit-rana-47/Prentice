import { describe, expect, it } from "vitest";
import {
  discussConcept,
  explainBackPolicy,
  resetQuestionIds,
  skipExplainSession,
  startExplainSession,
  submitExplainAnswer,
  type EvidencePacket,
} from "./index.js";

const packet: EvidencePacket = {
  taskId: "task-1",
  prompt: "Add a note.",
  projectName: "acme",
  files: [{ evidenceId: "file-1", path: "src/note.ts", change: "added", additions: 4, deletions: 0 }],
  symbols: [
    { evidenceId: "sym-1", path: "src/note.ts", name: "attachSessionNote", kind: "function", change: "added" },
  ],
  activity: [],
  tests: null,
  unparsedLanguages: [],
  unparsedFiles: [],
};

describe("explainBackPolicy", () => {
  it("uses a short optional check for a tiny change and a deeper ceiling for architecture", () => {
    expect(
      explainBackPolicy({ complexity: "low", changedFiles: 1, changedSymbols: 1 }).maxInitialQuestions,
    ).toBe(1);
    expect(explainBackPolicy({ complexity: "high", changedFiles: 2, changedSymbols: 2 }).depth).toBe("deep");
    expect(explainBackPolicy({ complexity: "moderate", changedFiles: 3, changedSymbols: 2 }).maxFollowUps).toBe(2);
  });
});

describe("explain session", () => {
  it("hints without naming the answer, then teaches the recorded fact", () => {
    resetQuestionIds();
    const started = startExplainSession(packet, "low");
    expect(started.current?.prompt).toContain("src/note.ts");
    const missed = submitExplainAnswer(started, "I am not sure");
    expect(missed.phase).toBe("asking");
    expect(missed.hint).toBeTruthy();
    expect(missed.hint).not.toContain("attachSessionNote");
    const taught = submitExplainAnswer(missed, "still not sure");
    expect(taught.phase).toBe("taught");
    expect(taught.teaching).toContain("attachSessionNote");
    const recovered = submitExplainAnswer(taught, "The function is attachSessionNote and it was added");
    expect(recovered.phase).toBe("done");
    expect(recovered.feedback.understood).toContain("attachSessionNote");
  });

  it("accepts an ordinary word for a git modification and skips a fact already demonstrated", () => {
    resetQuestionIds();
    const filePacket = { ...packet, symbols: [] };
    const started = startExplainSession(filePacket, "low");
    const accepted = submitExplainAnswer(started, "note.ts was created");
    expect(accepted.phase).toBe("done");
    expect(accepted.feedback.understood).toContain("src/note.ts");
    resetQuestionIds();
    const again = startExplainSession(packet, "moderate", ["attachSessionNote"]);
    expect(again.current?.concept).toBe("src/note.ts");
  });

  it("does not continue into a quiz after a correct answer on a small change", () => {
    resetQuestionIds();
    const started = startExplainSession(packet, "low");
    const done = submitExplainAnswer(started, "added attachSessionNote");
    expect(done.phase).toBe("done");
    expect(done.asked).toHaveLength(1);
  });

  it("separates a general explanation from a fact that was not recorded", () => {
    const general = discussConcept(packet, "What is a function?");
    expect(general.kind).toBe("general");
    expect(general.text).toMatch(/general teaching/i);
    const missing = discussConcept(packet, "Why did the agent choose this approach?");
    expect(missing.kind).toBe("unrecorded");
    const observed = discussConcept(packet, "What happened to attachSessionNote?");
    expect(observed.kind).toBe("observed");
    expect(observed.text).toContain("attachSessionNote");
  });

  it("can be skipped", () => {
    resetQuestionIds();
    const skipped = skipExplainSession(startExplainSession(packet, "moderate"));
    expect(skipped.phase).toBe("skipped");
    expect(skipped.current).toBeNull();
  });
});
