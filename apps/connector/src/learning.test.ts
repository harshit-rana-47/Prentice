import type { EvidencePacket, ExplainQuestion, UnderstandArtifact } from "@prentice/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discussLearning, explainEvidence, phraseQuestion } from "./learning.js";

const originalKey = process.env.GROQ_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  if (originalKey === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = originalKey;
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Learning AI", () => {
  it("shows recorded evidence when Groq is not configured and does not call a model", async () => {
    delete process.env.GROQ_API_KEY;
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await explainEvidence(packet(), artifact());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.observed[0]?.text).toContain("src/note.ts");
    expect(result.learning?.available).toBe(false);
    expect(result.learning?.message).toMatch(/GROQ_API_KEY/);
    expect(result.learning?.explanation).toBeNull();
  });

  it("keeps a question that would reveal the recorded answer", async () => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = mockJson({ question: "Git added src/note.ts. What happened?" }) as unknown as typeof fetch;
    const question = draft();
    const phrased = await phraseQuestion(packet(), question);
    expect(phrased).toBe(question.prompt);
  });

  it("rejects a follow-up that names a file the task did not record", async () => {
    process.env.GROQ_API_KEY = "test-key";
    globalThis.fetch = mockJson({ kind: "observed", text: "Look at secret/other.ts for the reason." }) as unknown as typeof fetch;
    const reply = await discussLearning(packet(), "Why was the other file changed?");
    expect(reply).toEqual({
      kind: "unrecorded",
      text: "That was not recorded for this task. Prentice will not guess about the repository.",
    });
  });
});

function mockJson(payload: unknown) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
  }));
}

function artifact(): UnderstandArtifact {
  return {
    observed: [{ kind: "observed", text: "src/note.ts was added.", citations: [{ evidenceId: "file", file: "src/note.ts" }] }],
    agentStated: [],
    inferences: [],
    changeMap: null,
    insufficientEvidence: [],
    rejectedClaims: [],
    learning: null,
  };
}

function draft(): ExplainQuestion {
  return {
    id: "file",
    prompt: "What kind of change did git record for src/note.ts?",
    concept: "src/note.ts",
    expectedPoints: ["src/note.ts", "added"],
    grounding: "observed",
    citations: [{ evidenceId: "file", file: "src/note.ts" }],
  };
}

function packet(): EvidencePacket {
  return {
    taskId: "task",
    prompt: "Add a note",
    files: [{ evidenceId: "file", path: "src/note.ts", change: "added", additions: 1, deletions: 0 }],
    symbols: [],
    activity: [],
    tests: null,
    projectName: "fixture",
    unparsedLanguages: [],
    unparsedFiles: [],
  };
}
