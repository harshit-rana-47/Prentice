import { describe, expect, it } from "vitest";
import { assembleUnderstand, validateClaims, type EvidencePacket, type GroundedClaim } from "./index.js";

const packet: EvidencePacket = {
  taskId: "task-1",
  prompt: "Add login.",
  projectName: "acme",
  files: [
    { evidenceId: "file-1", path: "src/auth/middleware.ts", change: "added", additions: 20, deletions: 0 },
    { evidenceId: "file-2", path: "src/app/login/page.tsx", change: "added", additions: 10, deletions: 0 },
  ],
  symbols: [
    {
      evidenceId: "sym-1",
      path: "src/auth/middleware.ts",
      name: "requireSession",
      kind: "function",
      change: "added",
    },
  ],
  activity: [
    {
      evidenceId: "act-1",
      title: "Agent note",
      detail: "Middleware runs before the protected route.",
      kind: "assistant",
      source: "agent",
    },
  ],
  tests: null,
  unparsedLanguages: [],
  unparsedFiles: ["README.md"],
};

describe("validateClaims", () => {
  it("rejects an inference that pretends to quote the agent", () => {
    const claim: GroundedClaim = {
      kind: "inference",
      text: "The agent decided that middleware centralizes authentication in src/auth/middleware.ts.",
      citations: [{ evidenceId: "file-1", file: "src/auth/middleware.ts" }],
    };
    const result = validateClaims([claim], packet);
    expect(result.accepted).toHaveLength(0);
    expect(result.rejected[0]?.reason).toMatch(/inference/i);
  });

  it("accepts an inference that cites a real file and does not speak for the agent", () => {
    const claim: GroundedClaim = {
      kind: "inference",
      text: "Based on the new file src/auth/middleware.ts, this appears to sit on the request path.",
      citations: [{ evidenceId: "file-1", file: "src/auth/middleware.ts" }],
    };
    expect(validateClaims([claim], packet).accepted).toHaveLength(1);
  });
});

describe("assembleUnderstand", () => {
  it("separates observed structure from what the agent stated", () => {
    const artifact = assembleUnderstand(packet);
    expect(artifact.observed.some((claim) => claim.text.includes("requireSession"))).toBe(true);
    expect(artifact.agentStated.some((claim) => claim.text.includes("The agent stated:"))).toBe(true);
    expect(artifact.inferences).toHaveLength(0);
    expect(artifact.changeMap).toContain("src/auth");
    expect(artifact.insufficientEvidence.some((note) => note.includes("README.md"))).toBe(true);
  });

  it("records a failed command as observed and does not explain why it failed", () => {
    const artifact = assembleUnderstand({
      ...packet,
      activity: [
        ...packet.activity,
        {
          evidenceId: "cmd-1",
          title: "npm test",
          command: "npm test",
          kind: "command.finished",
          exitCode: 1,
          source: "agent",
        },
      ],
    });
    expect(artifact.observed.some((claim) => claim.text.includes("Command failed with exit 1: npm test"))).toBe(true);
    expect(artifact.inferences).toHaveLength(0);
  });

  it("does not draw a change map for a single file", () => {
    const artifact = assembleUnderstand({
      ...packet,
      files: packet.files.slice(0, 1),
    });
    expect(artifact.changeMap).toBeNull();
  });
});
