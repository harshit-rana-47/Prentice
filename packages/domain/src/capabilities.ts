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
  sessionContinuation: false,
  usageInfo: true,
  readOnlyCompletion: true,
  effortMapping: "native-effort",
  notes: [
    localRepo,
    "Runs the Claude Code CLI installed on this computer in headless mode (`claude -p --output-format stream-json`). Prentice does not ship Claude Code and does not sign in for you.",
    "Effort levels are low, medium, high, xhigh, and max. Prentice maps Maximum to xhigh unless you explicitly request the provider maximum.",
    "File edits are taken from git. Tool events are activity, not the change record.",
    "Continuing a Claude Code session is not available. A live resume has not been verified, so Prentice will not start a new session and call it continuation.",
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
    "With no model selected in Prentice, the session uses the models Codex lists for that login, highest catalog priority first. The model in the local Codex config is not tried on its own. The timeline names only the model that ran.",
    "Interrupt aborts the running turn through the SDK AbortSignal. A verified local session stopped after that abort.",
    "Codex requires a git repository, which Prentice already requires.",
    "The app-server JSON-RPC API is not used. OpenAI marks it as unstable.",
    "Continue resumes the Codex thread on this computer. If that thread is gone, Prentice says so and does not start a different conversation.",
  ],
};

export const CURSOR_CAPABILITIES: ProviderCapabilities = {
  providerId: "cursor",
  displayName: "Cursor",
  inference: "vendor-hosted",
  repositoryExecution: "local",
  modelSelection: false,
  effortControl: false,
  streaming: true,
  toolActivity: true,
  fileChangeEvents: false,
  commandEvents: true,
  interruption: true,
  sessionContinuation: false,
  usageInfo: true,
  readOnlyCompletion: true,
  effortMapping: "model-params",
  notes: [
    localRepo,
    "Runs the official Cursor CLI installed on this computer (`agent -p --output-format stream-json`). Cursor cloud clones the repository onto a hosted machine and is not used.",
    "There is no shared effort scale. Prentice does not pick a Cursor model; Cursor chooses depth.",
    "Tool-call payloads are read only for the shell command, its exit code, and a failure's bounded output. File changes come from git.",
    "Continuing a Cursor session is not available. Live resume has not been verified, so Prentice will not start a new agent and call it continuation.",
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
