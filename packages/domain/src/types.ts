export const PROVIDER_IDS = ["claude-code", "codex", "cursor", "fixture"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export const INTENSITIES = ["fast", "balanced", "deep", "maximum"] as const;

export type Intensity = (typeof INTENSITIES)[number];

export type Complexity = "low" | "moderate" | "high";

export type InferenceHost = "vendor-hosted" | "none";

export type EffortMapping = "native-effort" | "model-params" | "delegated";

export interface ProviderCapabilities {
  providerId: ProviderId;
  displayName: string;
  inference: InferenceHost;
  /** Coding tools always run against the repo on this machine. */
  repositoryExecution: "local";
  modelSelection: boolean;
  effortControl: boolean;
  streaming: boolean;
  toolActivity: boolean;
  /** True only when the provider emits stable file-change events. Git remains the record either way. */
  fileChangeEvents: boolean;
  commandEvents: boolean;
  interruption: boolean;
  sessionContinuation: boolean;
  usageInfo: boolean;
  /** A no-tools read that can draft prose without editing the repo. */
  readOnlyCompletion: boolean;
  effortMapping: EffortMapping;
  notes: string[];
}

export interface ProjectContext {
  name: string;
  topLevelDirs: string[];
  dependencyNames: string[];
  languages: string[];
  hasTests: boolean;
  hasDatabase: boolean;
  hasAuth: boolean;
  /** Relative paths. Used locally for routing. Not uploaded. */
  filePaths: string[];
}

export interface TelemetryPrior {
  samples: number;
  byProvider: Partial<
    Record<
      ProviderId,
      {
        runs: number;
        failures: number;
      }
    >
  >;
}

export interface ConnectedProvider {
  providerId: ProviderId;
  capabilities: ProviderCapabilities;
  /** Lower numbers were connected earlier and win capability ties. */
  connectionOrder: number;
}

export interface RoutingPreferences {
  pinnedProviderId?: ProviderId;
}

export interface RoutingOverride {
  providerId?: ProviderId;
  intensity?: Intensity;
  /** Maps to a provider's highest effort value. Router recommendations never set this. */
  useProviderMax?: boolean;
}

export type TaskIntent = "create" | "modify" | "fix" | "refactor" | "test" | "explain" | "unknown";

export type TaskCategory =
  | "authentication"
  | "database"
  | "architecture"
  | "testing"
  | "ui"
  | "integration"
  | "general";

export interface TaskSignals {
  intent: TaskIntent;
  categories: TaskCategory[];
  technologies: string[];
  namedPaths: string[];
  touchesArchitecture: boolean;
  touchesDatabase: boolean;
  touchesAuth: boolean;
  touchesTesting: boolean;
  likelyFileScope: "one" | "few" | "many" | "unknown";
  /** Minor signal. Never sufficient on its own to raise complexity. */
  promptWords: number;
}

export interface TaskClassification {
  complexity: Complexity;
  intensity: Intensity;
  signals: TaskSignals;
  ambiguous: boolean;
  reasons: string[];
}

export interface ResolvedProfile {
  intensity: Intensity;
  delegated: boolean;
  summary: string;
  /** Present only when the user explicitly asked for the provider's maximum effort. */
  useProviderMax: boolean;
}

export interface RoutingDecision {
  providerId: ProviderId;
  complexity: Complexity;
  intensity: Intensity;
  profile: ResolvedProfile;
  why: string[];
  ambiguous: boolean;
  signals: TaskSignals;
  recommendedProviderId: ProviderId;
  overridden: boolean;
  telemetry: {
    recordedSamples: number;
    applied: false;
    reason: string;
  };
}

export type ClaimKind = "observed" | "agent-stated" | "inference";

export interface Citation {
  evidenceId: string;
  file?: string;
  symbol?: string;
}

export interface GroundedClaim {
  kind: ClaimKind;
  text: string;
  citations: Citation[];
}

export type FileChangeKind = "added" | "modified" | "deleted";

export interface DiffFile {
  evidenceId: string;
  path: string;
  change: FileChangeKind;
  additions: number;
  deletions: number;
}

export interface SymbolChange {
  evidenceId: string;
  path: string;
  name: string;
  kind: "function" | "class" | "method" | "other";
  change: FileChangeKind | "updated";
}

export interface ActivityRecord {
  evidenceId: string;
  title: string;
  detail?: string;
  kind: string;
  path?: string;
  command?: string;
  exitCode?: number | null;
  source: "agent" | "git" | "runtime";
}

export interface EvidencePacket {
  taskId: string;
  prompt: string;
  files: DiffFile[];
  symbols: SymbolChange[];
  activity: ActivityRecord[];
  tests: {
    evidenceId: string;
    passed: number;
    failed: number;
  } | null;
  projectName: string;
  unparsedLanguages: string[];
  /** Files we could not parse. Explanations must not invent their structure. */
  unparsedFiles: string[];
}

export interface UnderstandArtifact {
  observed: GroundedClaim[];
  agentStated: GroundedClaim[];
  inferences: GroundedClaim[];
  /** Omitted when a map would not reflect real structure. */
  changeMap: string | null;
  insufficientEvidence: string[];
  rejectedClaims: Array<{ text: string; reason: string }>;
  /** Learning AI prose. Null when that model is unavailable. The lists above stay evidence-backed. */
  learning: { available: boolean; message: string; explanation: string | null } | null;
}

export interface NormalizedEventBase {
  /** Stable id assigned by the runtime when persisting. Optional in pure normalizers. */
  id?: string;
}

export type NormalizedEvent =
  | (NormalizedEventBase & { type: "session.started"; providerSessionId?: string })
  | (NormalizedEventBase & { type: "status"; title: string; detail?: string })
  | (NormalizedEventBase & { type: "assistant"; text: string })
  | (NormalizedEventBase & {
      type: "tool.started";
      name: string;
      title: string;
      path?: string;
      command?: string;
    })
  | (NormalizedEventBase & {
      type: "tool.finished";
      name: string;
      title: string;
      path?: string;
      command?: string;
      ok: boolean;
      detail?: string;
    })
  | (NormalizedEventBase & {
      type: "file.changed";
      path: string;
      change: FileChangeKind;
      source: "agent" | "git";
    })
  | (NormalizedEventBase & { type: "command.started"; command: string })
  | (NormalizedEventBase & {
      type: "command.finished";
      command: string;
      exitCode: number | null;
    })
  | (NormalizedEventBase & {
      type: "usage";
      inputTokens?: number;
      outputTokens?: number;
    })
  | (NormalizedEventBase & { type: "session.completed"; summary?: string })
  | (NormalizedEventBase & {
      type: "session.failed";
      code: string;
      message: string;
      retryable: boolean;
    })
  | (NormalizedEventBase & { type: "session.interrupted" });

export interface TimelineItem {
  id: string;
  title: string;
  detail?: string;
  tone: "neutral" | "change" | "fail" | "ok";
}

export interface ExplainQuestion {
  id: string;
  prompt: string;
  concept: string;
  expectedPoints: string[];
  grounding: "observed" | "agent-stated";
  citations: Citation[];
  followUpOf?: string;
}

export interface ExplainBackPolicy {
  offerSkip: boolean;
  maxInitialQuestions: number;
  maxFollowUps: number;
  depth: "optional" | "short" | "moderate" | "deep";
}

export interface ExplainFeedback {
  understood: string[];
  unclear: string[];
}

export type ExplainPhase = "asking" | "taught" | "done" | "skipped" | "unavailable";

export interface ExplainDiscussion {
  question: string;
  kind: "observed" | "general" | "unrecorded";
  text: string;
}

export interface ExplainSessionState {
  phase: ExplainPhase;
  policy: ExplainBackPolicy;
  candidates: ExplainQuestion[];
  asked: ExplainQuestion[];
  current: ExplainQuestion | null;
  feedback: ExplainFeedback;
  followUpsAsked: number;
  initialAsked: number;
  attempts: number;
  hint: string | null;
  teaching: string | null;
  coach: string | null;
  learningMessage: string | null;
  discussion: ExplainDiscussion[];
}

export interface PrenticeErrorBody {
  code: string;
  message: string;
  retryable: boolean;
}
