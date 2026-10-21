import type {TeachingSupport, PracticeAssessment} from "@prentice/domain";
export interface PrenticeError {
  code: string;
  message: string;
  retryable: boolean;
}

export interface LocalSession {
  token: string;
  runtimeUrl: string;
  mode?: "local" | "relay";
  call?: (path: string, init?: RequestInit) => Promise<unknown>;
  watch?: (taskId: string, onTask: (task: TaskPayload) => void, signal: AbortSignal) => Promise<void>;
  onReconnect?: (listener: () => void) => () => void;
  /** Stops a task stream the page no longer shows. */
  unwatch?: (taskId: string) => void;
}

export type AgentState = "not-installed" | "signed-out" | "ready" | "error";

export interface ProviderView {
  id: string;
  installed?: boolean;
  connected: boolean;
  /** not-installed, signed-out (installed but not signed in), ready, or error (could not start or read status). */
  state?: AgentState;
  /** "prentice": Prentice can open the agent's official sign-in. "self": the person signs in inside the agent. */
  signIn?: "prentice" | "self" | "none";
  login: "idle" | "pending" | "failed";
  message: string;
  capabilities: {
    displayName: string;
    inference: "vendor-hosted" | "none";
    repositoryExecution: "local";
    effortControl: boolean;
    notes: string[];
  };
}

export interface DecisionView {
  providerId: string;
  complexity: "low" | "moderate" | "high";
  intensity: "fast" | "balanced" | "deep" | "maximum";
  why: string[];
  ambiguous: boolean;
  overridden: boolean;
  profile: { summary: string; delegated: boolean; useProviderMax: boolean };
  telemetry: { applied: false; reason: string; recordedSamples: number };
  recommendedProviderId: string;
}

export interface CommandOutputView {
  source: "command-output";
  text: string;
  truncated: boolean;
}

export interface TimelineItem {
  id: string;
  title: string;
  detail?: string;
  tone: "neutral" | "change" | "fail" | "ok";
  code?: string;
  output?: CommandOutputView;
}

export interface ClaimView {
  kind: string;
  text: string;
  citations: Array<{ file?: string; symbol?: string }>;
}

export interface UnderstandView {
  observed: ClaimView[];
  agentStated: ClaimView[];
  inferences: ClaimView[];
  changeMap: string | null;
  insufficientEvidence: string[];
  learning?: { pending?: boolean; available: boolean; message: string; explanation: string | null; concepts?: Array<{
    title: string; explanation: string; mechanism: string; tradeoff: string; transfer: string;
    support?: TeachingSupport; grounding: "inference"; basis: Array<{ id: string; kind: "observed" | "agent-stated"; text: string }>;
  }> } | null;
}

type PublicAssessment = Exclude<PracticeAssessment, {status:"assessed"}> | Omit<Extract<PracticeAssessment, {status:"assessed"}>, "evidence" | "proof">;

export type LearningAction = "next" | "practice" | "revisit" | "finish" | "skip";
export interface ExplainView {
  phase: "asking" | "taught" | "done" | "skipped" | "unavailable";
  questionNumber?: number;
  policy: { depth: string; offerSkip: boolean };
  current: { id: string; concept?: string; prompt: string; grounding: "observed" | "agent-stated" | "inference"; assessmentEligible?: boolean; citations?: Array<{ file?: string; symbol?: string }> } | null;
  topics?: Array<{id: string; title: string; understood: boolean}>;
  unpractised?: string[];
  practisedProvisionally?: string[];
  hasNext?: boolean;
  feedback: { understood: string[]; unclear: string[] };
  hint?: string | null;
  teaching?: string | null;
  coach?: string | null;
  learningMessage?: string | null;
  turns?: Array<{ id: string; questionId: string | null; prompt: string | null; message: string; status: "pending" | "replied" | "failed"; response: string | null; kind: "inference" | "general" | "unrecorded"; assessed?: boolean; understood?: boolean; support?: TeachingSupport; assessment?: PublicAssessment; hint?: string | null; teaching?: string | null; action?: LearningAction; requestedQuestionId?: string }>;
  discussion?: Array<{ question: string; kind: "observed" | "agent-stated" | "general" | "unrecorded" | "inference"; text: string }>;
}

export interface TaskPayload {
  id: string;
  prompt: string;
  status: string;
  providerId: string | null;
  error: PrenticeError | null;
  decision: DecisionView | null;
  labels: { complexity: string; intensity: string } | null;
  timeline: TimelineItem[];
  understand: UnderstandView | null;
  explain: ExplainView | null;
  continuation?: { available: boolean; message: string };
  /** Present when the run was stopped or Prentice closed mid-run. The prompt can be sent again as a new conversation. */
  recovery?: { kind: "send-again"; prompt: string; message: string } | null;
  issues: DebugIssueView[];
}

export interface DebugIssueView {
  id: string;
  symptom: string;
  evidence: string;
  /** Bounded stdout/stderr from the failed command. Absent when none was recorded. */
  output?: CommandOutputView;
}

export async function loadSession(accessToken?: string): Promise<LocalSession> {
  const relay = accessToken ? null : currentRelaySession();
  if (relay) return relay;
  const response = await fetch("/api/local-session", { cache: "no-store", headers: accessToken ? { authorization: `Bearer ${accessToken}` } : undefined });
  const body = (await response.json()) as { token?: string; runtimeUrl?: string; error?: { message: string } };
  if (!response.ok || !body.token || !body.runtimeUrl) {
    throw new Error(body.error?.message ?? "The local runtime session is unavailable.");
  }
  return { token: body.token, runtimeUrl: body.runtimeUrl };
}

// Only coalesce simultaneous reads, never retain completed data. A mutation starts a new read generation.
// Weak session keys keep different accounts/computers isolated and avoid retaining closed sessions.
const pendingReads = new WeakMap<LocalSession, Map<string, Promise<unknown>>>();

export function runtimeFetch<T>(session: LocalSession, path: string, init?: RequestInit): Promise<T> {
  if ((init?.method ?? "GET").toUpperCase() !== "GET") {
    pendingReads.delete(session);
    return performRuntimeFetch<T>(session, path, init).finally(() => pendingReads.delete(session));
  }
  // Requests with caller-specific headers, cancellation or options must retain their own semantics.
  if (init && Object.keys(init).some(key => key !== "method")) return performRuntimeFetch<T>(session, path, init);
  let reads = pendingReads.get(session);
  if (!reads) { reads = new Map(); pendingReads.set(session, reads); }
  const existing = reads.get(path);
  if (existing) return existing as Promise<T>;
  const read = performRuntimeFetch<T>(session, path, init);
  reads.set(path, read);
  const clear = () => { if (reads.get(path) === read) reads.delete(path); };
  void read.then(clear, clear);
  return read;
}

async function performRuntimeFetch<T>(session: LocalSession, path: string, init?: RequestInit): Promise<T> {
  if (session.call) return session.call(path, init) as Promise<T>;
  const response = await fetch(`${session.runtimeUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  const body = (await response.json()) as T & { error?: PrenticeError };
  if (!response.ok) {
    throw new Error(body.error?.message ?? "The runtime request failed.");
  }
  return body;
}

export async function readTaskStream(
  session: LocalSession,
  taskId: string,
  onTask: (task: TaskPayload) => void,
  signal: AbortSignal,
): Promise<void> {
  if (session.watch) return session.watch(taskId, onTask, signal);
  try {
    const response = await fetch(`${session.runtimeUrl}/v1/tasks/${taskId}/events`, {
      headers: { authorization: `Bearer ${session.token}` },
      signal,
      cache: "no-store",
    });
    if (!response.ok || !response.body) return;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((entry) => entry.startsWith("data:"));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data || data === "{}") continue;
        onTask(JSON.parse(data) as TaskPayload);
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return;
    throw error;
  }
}

let heldRelay: LocalSession | null = null;

export function holdRelaySession(session: LocalSession | null): void {
  heldRelay = session;
}

export function currentRelaySession(): LocalSession | null {
  return heldRelay;
}
