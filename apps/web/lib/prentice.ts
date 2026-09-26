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
}

export interface ProviderView {
  id: string;
  connected: boolean;
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

export interface TimelineItem {
  id: string;
  title: string;
  detail?: string;
  tone: "neutral" | "change" | "fail" | "ok";
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
  learning?: { available: boolean; message: string; explanation: string | null } | null;
}

export interface ExplainView {
  phase: "asking" | "taught" | "done" | "skipped" | "unavailable";
  questionNumber?: number;
  policy: { depth: string; offerSkip: boolean };
  current: { id: string; prompt: string; grounding: "observed" | "agent-stated"; citations?: Array<{ file?: string; symbol?: string }> } | null;
  feedback: { understood: string[]; unclear: string[] };
  hint?: string | null;
  teaching?: string | null;
  coach?: string | null;
  learningMessage?: string | null;
  discussion?: Array<{ question: string; kind: "observed" | "general" | "unrecorded"; text: string }>;
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
  issues: Array<{ id: string; symptom: string; evidence: string }>;
}

export async function loadSession(): Promise<LocalSession> {
  const relay = currentRelaySession();
  if (relay) return relay;
  const response = await fetch("/api/local-session", { cache: "no-store" });
  const body = (await response.json()) as { token?: string; runtimeUrl?: string; error?: { message: string } };
  if (!response.ok || !body.token || !body.runtimeUrl) {
    throw new Error(body.error?.message ?? "The local runtime session is unavailable.");
  }
  return { token: body.token, runtimeUrl: body.runtimeUrl };
}

export async function runtimeFetch<T>(session: LocalSession, path: string, init?: RequestInit): Promise<T> {
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
