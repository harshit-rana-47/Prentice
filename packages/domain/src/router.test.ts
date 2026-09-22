import { describe, expect, it } from "vitest";
import {
  CAPABILITIES_BY_ID,
  classifyTask,
  labelIntensity,
  routeTask,
  type ConnectedProvider,
  type ProjectContext,
} from "./index.js";

const project: ProjectContext = {
  name: "acme",
  topLevelDirs: ["src", "prisma"],
  dependencyNames: ["next", "prisma"],
  languages: ["typescript"],
  hasTests: true,
  hasDatabase: true,
  hasAuth: false,
  filePaths: ["src/app/page.tsx", "src/auth/middleware.ts", "prisma/schema.prisma"],
};

function connected(...ids: Array<ConnectedProvider["providerId"]>): ConnectedProvider[] {
  return ids.map((providerId, connectionOrder) => ({
    providerId,
    capabilities: CAPABILITIES_BY_ID[providerId],
    connectionOrder,
  }));
}

describe("classifyTask", () => {
  it("treats a css tweak as low complexity even when the prompt is padded", () => {
    const padding = Array.from({ length: 400 }, () => "thanks").join(" ");
    const result = classifyTask(`Change the button color to blue in src/Button.tsx. ${padding}`, project);
    expect(result.complexity).toBe("low");
    expect(result.intensity).toBe("fast");
    expect(result.reasons.some((reason) => reason.includes("Length was not treated as complexity"))).toBe(true);
  });

  it("raises auth plus database work without using prompt length", () => {
    const result = classifyTask("Add Google OAuth and a user migration with integration tests", project);
    expect(result.signals.touchesAuth).toBe(true);
    expect(result.signals.touchesDatabase).toBe(true);
    expect(result.complexity).toBe("high");
    expect(result.intensity).toBe("deep");
  });

  it("keeps a vague prompt on the small profile", () => {
    const result = classifyTask("update the thing", project);
    expect(result.ambiguous).toBe(true);
    expect(result.complexity).toBe("low");
    expect(result.intensity).toBe("fast");
  });
});

describe("routeTask", () => {
  it("uses the only connected provider", () => {
    const decision = routeTask({
      prompt: "Add Google OAuth and a user migration",
      project,
      connected: connected("cursor"),
    });
    expect(decision.providerId).toBe("cursor");
    expect(decision.profile.summary).toContain("Cursor");
    expect(decision.telemetry.applied).toBe(false);
  });

  it("prefers an effort-capable provider for a high-complexity task and still allows an override", () => {
    const prompt = "Add Google OAuth and a user migration with integration tests";
    const recommended = routeTask({
      prompt,
      project,
      connected: connected("cursor", "claude-code"),
    });
    expect(recommended.providerId).toBe("claude-code");
    expect(labelIntensity(recommended.intensity)).toBe("Deep");

    const overridden = routeTask({
      prompt,
      project,
      connected: connected("cursor", "claude-code"),
      override: { providerId: "cursor", intensity: "fast" },
    });
    expect(overridden.providerId).toBe("cursor");
    expect(overridden.intensity).toBe("fast");
    expect(overridden.overridden).toBe(true);
  });

  it("honors a pin and does not let a large telemetry history change the choice", () => {
    const decision = routeTask({
      prompt: "Add Google OAuth and a user migration",
      project,
      connected: connected("claude-code", "codex"),
      preferences: { pinnedProviderId: "codex" },
      telemetry: {
        samples: 40,
        byProvider: { "claude-code": { runs: 40, failures: 0 } },
      },
    });
    expect(decision.providerId).toBe("codex");
    expect(decision.telemetry.recordedSamples).toBe(40);
    expect(decision.telemetry.applied).toBe(false);
  });

  it("does not auto-select the fixture when a real provider is connected", () => {
    const decision = routeTask({
      prompt: "Change the button color",
      project,
      connected: connected("fixture", "codex"),
    });
    expect(decision.providerId).toBe("codex");
  });

  it("maps a recommended maximum to xhigh rather than provider max", () => {
    const decision = routeTask({
      prompt: "Deep review the auth architecture and database migration as thorough as possible",
      project,
      connected: connected("claude-code"),
    });
    expect(decision.intensity).toBe("maximum");
    expect(decision.profile.useProviderMax).toBe(false);
    expect(decision.profile.summary).toContain("xhigh");
  });
});
