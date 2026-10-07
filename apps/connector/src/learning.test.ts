import type { EvidencePacket, ExplainQuestion, UnderstandArtifact } from "@prentice/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discussLearning, explainEvidence, phraseQuestion, setLearningEndpoint } from "./learning.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  setLearningEndpoint(null);
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("Learning AI", () => {
  it("shows recorded evidence when this computer is not paired and does not call Prentice", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await explainEvidence(packet(), artifact());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.observed[0]?.text).toContain("src/note.ts");
    expect(result.learning?.available).toBe(false);
    expect(result.learning?.message).toMatch(/unavailable/);
    expect(result.learning?.message).not.toMatch(/GROQ_API_KEY/);
    expect(result.learning?.explanation).toBeNull();
  });

  it("keeps a question that would reveal the recorded answer", async () => {
    setLearningEndpoint({ cloudUrl: "http://127.0.0.1:4740", token: "device" });
    globalThis.fetch = mockResult({ question: "Git added src/note.ts. What happened?" }) as unknown as typeof fetch;
    const question = draft();
    const phrased = await phraseQuestion(packet(), question);
    expect(phrased).toBe(question.prompt);
  });

  it("rejects a follow-up that names a file the task did not record", async () => {
    setLearningEndpoint({ cloudUrl: "http://127.0.0.1:4740", token: "device" });
    globalThis.fetch = mockResult({ kind: "observed", text: "Look at secret/other.ts for the reason." }) as unknown as typeof fetch;
    const reply = await discussLearning(packet(), "Why was the other file changed?");
    expect(reply).toEqual({
      kind: "unrecorded",
      text: "That was not recorded for this task. Prentice will not guess about the repository.",
    });
  });
});

function mockResult(payload: unknown) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("http://127.0.0.1:4740/v1/learning");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer device");
    expect(String(init?.body)).not.toMatch(/GROQ|apiKey/);
    return { ok: true, json: async () => ({ result: payload }) };
  });
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
