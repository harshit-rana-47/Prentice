import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assembleUnderstand,
  CAPABILITIES_BY_ID,
  classifyTask,
  debugIssuesFromObservations,
  debugIssuesFromTimeline,
  routeTask,
  startExplainSession,
  skipExplainSession,
  submitExplainAnswer,
  toTimeline,
  type ActivityRecord,
  type ConnectedProvider,
  type EvidencePacket,
  type NormalizedEvent,
  type ProviderId,
  type RoutingOverride,
} from "@prentice/domain";
import { readProjectContext } from "./context.js";
import { collectDiff, headCommit, showFile } from "./git.js";
import { log } from "./log.js";
import { providerFactory, type AgentSession } from "./providers.js";
import type { AccountSnapshot } from "./accounts.js";
import { Store, type StoredEvent, type TaskRow } from "./store.js";
import { extractSymbolChanges, isParsedLanguage } from "./symbols.js";

export class EventHub {
  private listeners = new Map<string, Set<(event: StoredEvent) => void>>();

  publish(taskId: string, event: StoredEvent): void {
    for (const listener of this.listeners.get(taskId) ?? []) listener(event);
  }

  subscribe(taskId: string, listener: (event: StoredEvent) => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(listener);
    this.listeners.set(taskId, set);
    return () => set.delete(listener);
  }
}

const running = new Map<string, { abort: AbortController; session?: AgentSession }>();

export async function analyzeTask(store: Store, accounts: AccountSnapshot["accounts"], prompt: string) {
  const project = store.latestProject();
  if (!project) {
    return { error: { code: "PROJECT_REQUIRED", message: "Open a local git repository first.", retryable: false } };
  }
  const context = await readProjectContext(project.path, project.name);
  const connected = connectedProviders(store, accounts);
  if (connected.length === 0) {
    return { error: { code: "PROVIDER_REQUIRED", message: "Connect a provider before analyzing a task.", retryable: false } };
  }
  const pinned = store.getSetting("pinnedProvider") as ProviderId | undefined;
  const decision = routeTask({
    prompt,
    project: context,
    connected,
    preferences: pinned ? { pinnedProviderId: pinned } : undefined,
    telemetry: { samples: store.telemetryCount(), byProvider: {} },
  });
  const task = store.insertTask(project.id, prompt);
  store.saveDecision(task.id, decision);
  store.updateTask(task.id, { provider_id: decision.providerId });
  return { task: publicTask(store, task.id), decision };
}

export async function startTask(
  store: Store,
  accounts: AccountSnapshot["accounts"],
  hub: EventHub,
  taskId: string,
  input: { consent: boolean; override?: RoutingOverride },
) {
  const task = store.getTask(taskId);
  if (!task) return { error: { code: "NOT_FOUND", message: "Task not found.", retryable: false } };
  if (task.status !== "analyzed") {
    return { error: { code: "TASK_STATE", message: "This task has already started.", retryable: false } };
  }
  if (!input.consent) {
    return {
      error: {
        code: "CONSENT_REQUIRED",
        message: "Confirm that the agent may edit files and run commands in this repository.",
        retryable: false,
      },
    };
  }
  const project = store.getProject(task.project_id);
  if (!project) return { error: { code: "PROJECT_REQUIRED", message: "The repository is no longer open.", retryable: false } };
  const base = await headCommit(project.path);
  if (!base) {
    return {
      error: {
        code: "GIT_REQUIRED",
        message: "Prentice needs at least one commit so it can diff what the agent changes.",
        retryable: false,
      },
    };
  }
  let decision = store.getDecision(taskId);
  if (!decision) return { error: { code: "NOT_FOUND", message: "Routing decision missing.", retryable: false } };
  if (input.override?.providerId || input.override?.intensity || input.override?.useProviderMax) {
    const context = await readProjectContext(project.path, project.name);
    decision = routeTask({
      prompt: task.prompt,
      project: context,
      connected: connectedProviders(store, accounts),
      override: input.override,
      classification: classifyTask(task.prompt, context),
      telemetry: { samples: store.telemetryCount(), byProvider: {} },
    });
    store.saveDecision(taskId, decision);
  }
  store.updateTask(taskId, { consent: 1, base_commit: base, provider_id: decision.providerId, status: "running" });
  const abort = new AbortController();
  running.set(taskId, { abort });
  void execute(store, hub, task, project.path, decision.providerId, abort).catch((error: unknown) => {
    log("error", "Task execution failed", { taskId, error: error instanceof Error ? error.message : "unknown" });
  });
  return { task: publicTask(store, taskId) };
}

async function execute(
  store: Store,
  hub: EventHub,
  task: TaskRow,
  repoPath: string,
  providerId: ProviderId,
  abort: AbortController,
): Promise<void> {
  const started = Date.now();
  const decision = store.getDecision(task.id);
  const provider = providerFactory(providerId);
  let session: AgentSession | undefined;
  try {
    session = await provider.startSession({
      prompt: task.prompt,
      repoPath,
      profile: decision!.profile,
      signal: abort.signal,
    });
    running.set(task.id, { abort, session });
    let failed: Extract<NormalizedEvent, { type: "session.failed" }> | undefined;
    for await (const event of session.events) {
      publish(store, hub, task.id, event);
      if (event.type === "session.failed") failed = event;
      if (event.type === "session.interrupted") {
        store.updateTask(task.id, {
          status: "interrupted",
          finished_at: new Date().toISOString(),
          error_code: "SESSION_INTERRUPTED",
          error_message: "The session was interrupted.",
        });
        return;
      }
    }
    const base = store.getTask(task.id)?.base_commit;
    if (base) await publishGitChanges(store, hub, task.id, repoPath, base);
    if (base) await writeUnderstand(store, task.id, repoPath, base, task.prompt);
    if (failed) {
      store.updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: failed.code,
        error_message: failed.message,
      });
    } else if (store.getTask(task.id)?.status === "running") {
      store.updateTask(task.id, { status: "completed", finished_at: new Date().toISOString() });
    }
    publish(store, hub, task.id, {
      type: "status",
      title: failed ? "Explanation kept for the failed run" : "Explanation ready",
      detail: "Observed from the git diff and the session record.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The runtime lost the session.";
    publish(store, hub, task.id, {
      type: "session.failed",
      code: "RUNTIME_DISCONNECTED",
      message,
      retryable: true,
    });
    store.updateTask(task.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_code: "RUNTIME_DISCONNECTED",
      error_message: message,
    });
  } finally {
    await session?.disconnect().catch(() => undefined);
    running.delete(task.id);
    const current = store.getTask(task.id);
    store.recordTelemetry(task.id, {
      providerId,
      complexity: decision?.complexity,
      intensity: decision?.intensity,
      durationMs: Date.now() - started,
      status: current?.status,
      errorCode: current?.error_code,
    });
  }
}

export async function interruptTask(taskId: string): Promise<void> {
  const active = running.get(taskId);
  if (!active) return;
  active.abort.abort();
  await active.session?.interrupt();
}

async function publishGitChanges(
  store: Store,
  hub: EventHub,
  taskId: string,
  repoPath: string,
  base: string,
): Promise<void> {
  const files = await collectDiff(repoPath, base);
  const seen = new Set(
    store
      .listEvents(taskId)
      .filter((item) => item.event.type === "file.changed" && item.event.source === "git")
      .map((item) => (item.event.type === "file.changed" ? item.event.path : "")),
  );
  for (const file of files) {
    if (seen.has(file.path)) continue;
    publish(store, hub, taskId, { type: "file.changed", path: file.path, change: file.change, source: "git" });
  }
}

async function writeUnderstand(store: Store, taskId: string, repoPath: string, base: string, prompt: string): Promise<void> {
  const files = await collectDiff(repoPath, base);
  const symbols = [];
  const unparsedFiles: string[] = [];
  for (const file of files) {
    if (!isParsedLanguage(file.path)) {
      unparsedFiles.push(file.path);
      continue;
    }
    const next = file.change === "deleted" ? null : await readFile(join(repoPath, file.path), "utf8").catch(() => null);
    const previous = await showFile(repoPath, base, file.path);
    const extracted = await extractSymbolChanges(file.path, next, previous);
    if (!extracted.parsed) unparsedFiles.push(file.path);
    symbols.push(...extracted.symbols);
  }
  const packet: EvidencePacket = {
    taskId,
    prompt,
    files,
    symbols,
    activity: activityFrom(store.listEvents(taskId)),
    tests: null,
    projectName: store.getProject(store.getTask(taskId)?.project_id ?? "")?.name ?? "project",
    unparsedLanguages: [...new Set(unparsedFiles.map((path) => path.split(".").pop() ?? path))],
    unparsedFiles,
  };
  store.savePacket(taskId, packet);
  store.saveUnderstand(taskId, assembleUnderstand(packet));
}

function activityFrom(events: StoredEvent[]): ActivityRecord[] {
  const records: ActivityRecord[] = [];
  for (const item of events) {
    const event = item.event;
    if (event.type === "assistant") {
      records.push({
        evidenceId: item.id,
        title: "Agent note",
        detail: event.text,
        kind: "assistant",
        source: "agent",
      });
    } else if (event.type === "status") {
      records.push({
        evidenceId: item.id,
        title: event.title,
        detail: event.detail,
        kind: "status",
        source: "runtime",
      });
    } else if (event.type === "command.started" || event.type === "command.finished") {
      records.push({
        evidenceId: item.id,
        title: event.command,
        detail: event.command,
        command: event.command,
        kind: event.type,
        source: "agent",
      });
    }
  }
  return records;
}

function publish(store: Store, hub: EventHub, taskId: string, event: NormalizedEvent): StoredEvent {
  const stored = store.appendEvent(taskId, event);
  hub.publish(taskId, stored);
  return stored;
}

export function connectedProviders(store: Store, accounts: AccountSnapshot["accounts"]): ConnectedProvider[] {
  const providers: ConnectedProvider[] = [];
  (["claude-code", "codex", "cursor"] as const).forEach((providerId) => {
    if (!accounts[providerId].connected) return;
    const saved = store.getSetting(`connectedAt:${providerId}`);
    const order = saved ? Number(saved) : Date.now();
    providers.push({ providerId, capabilities: CAPABILITIES_BY_ID[providerId], connectionOrder: order });
  });
  if (providers.length === 0) {
    providers.push({ providerId: "fixture", capabilities: CAPABILITIES_BY_ID.fixture, connectionOrder: 0 });
  }
  return providers;
}

export function publicTask(store: Store, taskId: string) {
  const task = store.getTask(taskId);
  if (!task) return undefined;
  const events = store.listEvents(taskId);
  const timeline = toTimeline(events.map((item) => ({ ...item.event, id: item.id })));
  const understand = store.getUnderstand(taskId) ?? null;
  return {
    id: task.id,
    prompt: task.prompt,
    status: task.status,
    providerId: task.provider_id,
    error: task.error_code
      ? { code: task.error_code, message: task.error_message, retryable: task.error_code === "PROVIDER_UNAVAILABLE" }
      : null,
    decision: store.getDecision(taskId) ?? null,
    timeline,
    understand,
    explain: explainView(store.getExplain(taskId)),
    issues: [
      ...debugIssuesFromTimeline(timeline),
      ...debugIssuesFromObservations(understand?.observed.map((claim) => claim.text) ?? []),
    ],
  };
}

export function explainView(state: ReturnType<Store["getExplain"]>) {
  if (!state) return null;
  return {
    phase: state.phase,
    policy: state.policy,
    current: state.current
      ? {
          id: state.current.id,
          prompt: state.current.prompt,
          grounding: state.current.grounding,
          citations: state.current.citations,
        }
      : null,
    feedback: state.feedback,
  };
}

export function beginExplain(store: Store, taskId: string) {
  const existing = store.getExplain(taskId);
  if (existing) return explainView(existing);
  const packet = store.getPacket(taskId);
  const decision = store.getDecision(taskId);
  if (!packet || !decision) return null;
  const state = startExplainSession(packet, decision.complexity);
  store.saveExplain(taskId, state);
  return explainView(state);
}

export function answerExplain(store: Store, taskId: string, answer: string) {
  const state = store.getExplain(taskId);
  if (!state) return null;
  const next = submitExplainAnswer(state, answer);
  store.saveExplain(taskId, next);
  return explainView(next);
}

export function skipExplain(store: Store, taskId: string) {
  const state = store.getExplain(taskId);
  if (!state) return null;
  const next = skipExplainSession(state);
  store.saveExplain(taskId, next);
  return explainView(next);
}
