import type { ProviderCapabilities, ProviderId } from "./types.js";

const localRepo = "Coding tools run in the local repository. Model inference is hosted by the vendor." as const;

export const CLAUDE_CODE_CAPABILITIES: ProviderCapabilities = {
  providerId: "claude-code",
  displayName: "Claude Code",
  inference: "vendor-hosted",
  repositoryExecution: "local",
  modelSelection: true,
  effortControl: true,
  streaming: true,
  toolActivity: true,
  fileChangeEvents: false,
  commandEvents: true,
  interruption: true,
  sessionContinuation: true,
  usageInfo: true,
  readOnlyCompletion: true,
  effortMapping: "native-effort",
  notes: [
    localRepo,
    "Effort levels are low, medium, high, xhigh, and max. Prentice maps Maximum to xhigh unless you explicitly request the provider maximum.",
    "File edits are taken from git. Tool events are activity, not the change record.",
  ],
};

export const CODEX_CAPABILITIES: ProviderCapabilities = {
  providerId: "codex",
  displayName: "Codex",
  inference: "vendor-hosted",
  repositoryExecution: "local",
  modelSelection: true,
  effortControl: true,
  streaming: true,
  toolActivity: true,
  fileChangeEvents: true,
  commandEvents: true,
  interruption: true,
  sessionContinuation: true,
  usageInfo: true,
  readOnlyCompletion: true,
  effortMapping: "native-effort",
  notes: [
    localRepo,
    "Reasoning effort is set with modelReasoningEffort on the local Codex SDK.",
    "Codex requires a git repository, which Prentice already requires.",
    "The app-server JSON-RPC API is not used. OpenAI marks it as unstable.",
  ],
};

export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  providerId: "cursor",
  displayName: "Cursor",
  inference: "vendor-hosted",
  repositoryExecution: "local",
  modelSelection: true,
  effortControl: false,
  streaming: true,
  toolActivity: true,
  fileChangeEvents: false,
  commandEvents: true,
  interruption: true,
  sessionContinuation: true,
  usageInfo: true,
  readOnlyCompletion: true,
  effortMapping: "model-params",
  notes: [
    localRepo,
    "Local agents only. Cursor cloud clones the repository onto a hosted machine and is not used.",
    "There is no shared effort scale. Depth is a model id and params such as fast, discovered from the account catalog.",
    "Tool-call payloads are unstable. File changes come from git.",
    "Requires Node.js 22.13 or newer.",
  ],
};

export const FIXTURE_CAPABILITIES: ProviderCapabilities = {
  providerId: "fixture",
  displayName: "Fixture",
  inference: "none",
  repositoryExecution: "local",
  modelSelection: false,
  effortControl: false,
  streaming: true,
  toolActivity: true,
  fileChangeEvents: false,
  commandEvents: false,
  interruption: true,
  sessionContinuation: false,
  usageInfo: false,
  readOnlyCompletion: false,
  effortMapping: "delegated",
  notes: [
    "No vendor call. Prentice writes one sample file in the open repo so the rest of the loop can run.",
    "Activity in a fixture run is produced by Prentice, not by a coding agent.",
  ],
};

export const CAPABILITIES_BY_ID: Record<ProviderId, ProviderCapabilities> = {
  "claude-code": CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  cursor: CURSOR_CAPABILITIES,
  fixture: FIXTURE_CAPABILITIES,
};

export function isRealProvider(id: ProviderId): boolean {
  return id !== "fixture";
}
