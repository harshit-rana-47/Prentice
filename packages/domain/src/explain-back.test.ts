import { describe, expect, it } from "vitest";
import {
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
  it("asks a follow-up only when the answer misses the evidence, then stops after a short task", () => {
    resetQuestionIds();
    const started = startExplainSession(packet, "low");
    expect(started.current?.prompt).toContain("src/note.ts");
    const missed = submitExplainAnswer(started, "I am not sure");
    expect(missed.phase).toBe("asking");
    expect(missed.current?.prompt).toContain("attachSessionNote");
    const recovered = submitExplainAnswer(missed, "The function is attachSessionNote");
    expect(recovered.phase).toBe("done");
    expect(recovered.feedback.understood).toContain("attachSessionNote");
    expect(recovered.feedback.unclear).not.toContain("attachSessionNote");
  });

  it("does not continue into a quiz after a correct answer on a small change", () => {
    resetQuestionIds();
    const started = startExplainSession(packet, "low");
    const done = submitExplainAnswer(started, "added attachSessionNote");
    expect(done.phase).toBe("done");
    expect(done.asked).toHaveLength(1);
  });

  it("can be skipped", () => {
    resetQuestionIds();
    const skipped = skipExplainSession(startExplainSession(packet, "moderate"));
    expect(skipped.phase).toBe("skipped");
    expect(skipped.current).toBeNull();
  });
});
