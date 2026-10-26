import { randomUUID } from "node:crypto";
import { commandWritesRepository } from "./repository-write.js";
export { commandWritesRepository } from "./repository-write.js";
import { awaitWorktreeIdle } from "./process-guard.js";
import {
  assembleUnderstand,
  scrubEvidence,
  CAPABILITIES_BY_ID,
  classifyTask,
  debugIssuesFromObservations,
  debugIssuesFromTimeline,
  parseTestSummary,
  routeTask,
  applyExplainJudgment,
  assessmentSpec,
  knowledgeFor,
  continueExplainSession,
  teachExplainSession,
  practiseExplainSession,
  revisitExplainSession,
  finishExplainSession,
  startExplainSession,
  skipExplainSession,
  toTimeline,
  toConversationTimeline,
  type ActivityRecord,
  type ConnectedProvider,
  type EvidencePacket,
  type NormalizedEvent,
  type ProviderId,
  type RoutingOverride,
  type ExplainAction,
} from "@prentice/domain";
import { readWorkspaceFile } from "./workspace.js";
import { readProjectContext } from "./context.js";
import { captureWorktree, diffWorktrees, headCommit, sameWorktree, type TurnChange, type WorktreeSnapshot } from "./git.js";
import { log } from "./log.js";
import { providerFactory, type AgentSession } from "./providers.js";
import { loginShellPath, resolveAgent, type ResolvedAgent } from "./agents.js";
import { codingAgentRequiredMessage, type AccountSnapshot } from "./accounts.js";
import { conversationTitle, Store, type StoredEvent, type TaskRow } from "./store.js";
import { converseLearning, explainEvidence, learningStatus } from "./learning.js";
import { extractSymbolChanges, extractImplementationSignals, isParsedLanguage } from "./symbols.js";

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
const activeProjects = new Set<string>();
let onAgentSignedOut: (() => void) | null = null;

/** The connector refreshes agent status when a run reports that the agent is not signed in. */
export function setAgentSignedOutListener(listener: (() => void) | null): void {
  onAgentSignedOut = listener;
}

/** The executable a task runs is the one detection found. The fixture needs none. */
async function agentFor(providerId: ProviderId): Promise<ResolvedAgent | undefined> {
  if (providerId === "fixture") return undefined;
  const resolved = resolveAgent(providerId, { loginShellPath: await loginShellPath() });
  return resolved && "command" in resolved ? resolved : undefined;
}

/** One coding agent may modify a project's working tree at a time. */
export function claimProject(projectId: string): boolean {
  if (activeProjects.has(projectId)) return false;
  activeProjects.add(projectId);
  return true;
}

export function releaseProject(projectId: string): void {
  activeProjects.delete(projectId);
}

export function taskIsRunning(taskId: string): boolean {
  return running.has(taskId);
}

/** A finished agent turn is not success when it claimed a repository write that git does not show. */
export function claimedWriteMissed(events: NormalizedEvent[]): boolean {
  return events.some((event) => {
    if (event.type === "file.changed" && event.source === "agent") return true;
    return event.type === "command.finished" && event.exitCode === 0 && commandWritesRepository(event.command);
  });
}

export async function analyzeTask(
  store: Store,
  accounts: AccountSnapshot["accounts"],
  prompt: string,
  allowFixture = true,
) {
  const project = store.latestProject();
  if (!project) {
    return { error: { code: "PROJECT_REQUIRED", message: "Open a local git repository first.", retryable: false } };
  }
  const context = await readProjectContext(project.path, project.name);
  const connected = connectedProviders(store, accounts, allowFixture);
  if (connected.length === 0) {
    return {
      error: {
        code: "PROVIDER_REQUIRED",
        message: codingAgentRequiredMessage(accounts),
        retryable: false,
      },
    };
  }
  const pinned = store.getSetting("pinnedProvider") as ProviderId | undefined;
  const decision = routeTask({
    prompt,
    project: context,
    connected,
    preferences: pinned ? { pinnedProviderId: pinned } : undefined,
    telemetry: { samples: store.telemetryCount(), byProvider: {} },
  });
  // The conversation is created when the task actually starts, so a start that is refused leaves no empty chat.
  const task = store.insertTask(project.id, prompt, null);
  store.saveDecision(task.id, decision);
  store.updateTask(task.id, { provider_id: decision.providerId });
  return { task: publicTask(store, task.id), decision };
}

export async function startTask(
  store: Store,
  accounts: AccountSnapshot["accounts"],
  hub: EventHub,
  taskId: string,
  input: { consent: boolean; override?: RoutingOverride; activeFile?: string },
  allowFixture = true,
) {
  const task = store.getTask(taskId);
  if (!task) return { error: { code: "NOT_FOUND", message: "Task not found.", retryable: false } };
  if (!claimProject(task.project_id)) {
    return {
      error: {
        code: "PROJECT_BUSY",
        message: "An agent is already working in this repository. Wait for it to finish before starting another conversation.",
        retryable: true,
      },
    };
  }
  let launched = false;
  try {
    const ready = await launchTask(store, accounts, task, input, allowFixture);
    if ("error" in ready) return ready;
    launched = true;
    void execute(store, hub, ready.task, ready.repoPath, ready.providerId, ready.abort)
      .catch((error: unknown) => {
        log("error", "Task execution failed", { taskId: task.id, error: error instanceof Error ? error.message : "unknown" });
      })
      .finally(() => {
        releaseProject(task.project_id);
      });
    return { task: publicTask(store, task.id) };
  } finally {
    if (!launched) releaseProject(task.project_id);
  }
}

async function launchTask(
  store: Store,
  accounts: AccountSnapshot["accounts"],
  task: TaskRow,
  input: { consent: boolean; override?: RoutingOverride; activeFile?: string },
  allowFixture = true,
) {
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
  const selectedProvider = input.override?.providerId;
  if (selectedProvider === "fixture" && !allowFixture) {
    return { error: { code: "PROVIDER_REQUIRED", message: "The fixture provider is unavailable in this connector.", retryable: false } };
  }
  if (selectedProvider && selectedProvider !== "fixture" && !accounts[selectedProvider].connected) {
    const account = accounts[selectedProvider];
    return {
      error: {
        code: account.state === "signed-out" ? "AGENT_SIGNED_OUT" : "AGENT_UNAVAILABLE",
        message: account.message || "Reconnect the selected coding agent in Prentice before starting this task.",
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
  let decision = store.getDecision(task.id);
  if (!decision) return { error: { code: "NOT_FOUND", message: "Routing decision missing.", retryable: false } };
  if (input.override?.providerId || input.override?.intensity || input.override?.useProviderMax) {
    const context = await readProjectContext(project.path, project.name);
    decision = routeTask({
      prompt: task.prompt,
      project: context,
      connected: connectedProviders(store, accounts, allowFixture),
      override: input.override,
      classification: classifyTask(task.prompt, context),
      telemetry: { samples: store.telemetryCount(), byProvider: {} },
    });
    store.saveDecision(task.id, decision);
  }
  if (!allowFixture && decision.providerId === "fixture") {
    return {
      error: {
        code: "PROVIDER_REQUIRED",
        message: codingAgentRequiredMessage(accounts),
        retryable: false,
      },
    };
  }
  if (decision.providerId !== "fixture" && !accounts[decision.providerId].connected) {
    return { error: { code: "AGENT_UNAVAILABLE", message: "Reconnect this coding agent in Prentice before starting this task.", retryable: false } };
  }
  if (input.activeFile) {
    try { await readWorkspaceFile(project.path, input.activeFile); }
    catch { return { error: { code: "FILE_CONTEXT_UNAVAILABLE", message: "The open file is no longer available in this repository. Reopen it before sending the task.", retryable: false } }; }
  }
  store.setSetting(`task.activeFile:${task.id}`, input.activeFile ?? "");
  let conversationId = task.conversation_id;
  if (!conversationId) {
    conversationId = store.insertConversation(project.id, conversationTitle(task.prompt)).id;
  }
  store.updateTask(task.id, {
    consent: 1,
    base_commit: base,
    provider_id: decision.providerId,
    status: "running",
    conversation_id: conversationId,
  });
  store.touchConversation(conversationId);
  store.selectConversation(project.id, conversationId);
  const abort = new AbortController();
  running.set(task.id, { abort });
  const current = store.getTask(task.id) ?? task;
  return { task: current, repoPath: project.path, providerId: decision.providerId, abort };
}

export async function continueTask(
  store: Store,
  hub: EventHub,
  taskId: string,
  input: { prompt: string; consent: boolean; activeFile?: string },
) {
  const loaded = store.getTask(taskId);
  if (!loaded) return { error: { code: "NOT_FOUND", message: "Task not found.", retryable: false } };
  store.ensureConversations(loaded.project_id);
  const previous = store.getTask(taskId) ?? loaded;
  const continuation = continuationFor(previous);
  const providerId = previous.provider_id as ProviderId;
  if (!continuation.available) {
    return { error: { code: "CONTINUATION_UNAVAILABLE", message: continuation.message, retryable: false } };
  }
  if (!previous.conversation_id) {
    return { error: { code: "CONVERSATION_REQUIRED", message: "This turn is not part of a conversation.", retryable: false } };
  }
  const head = store.conversationHead(previous.conversation_id);
  if (!head || head.id !== previous.id) {
    return {
      error: {
        code: "CONVERSATION_HEAD",
        message: "Continue the latest turn of this conversation.",
        retryable: false,
      },
    };
  }
  if (!input.consent) {
    return {
      error: {
        code: "CONSENT_REQUIRED",
        message: "Confirm that continuing may edit files and run commands in this repository.",
        retryable: false,
      },
    };
  }
  const project = store.getProject(previous.project_id);
  if (!project) return { error: { code: "PROJECT_REQUIRED", message: "The repository is no longer open.", retryable: false } };
  const decision = store.getDecision(previous.id);
  if (!decision) return { error: { code: "NOT_FOUND", message: "Routing decision missing.", retryable: false } };
  if (!claimProject(project.id)) {
    return {
      error: {
        code: "PROJECT_BUSY",
        message: "An agent is already working in this repository. Wait for it to finish before starting another conversation.",
        retryable: true,
      },
    };
  }
  let launched = false;
  try {
    const base = await headCommit(project.path);
    if (!base) {
      return { error: { code: "GIT_REQUIRED", message: "Prentice needs at least one commit so it can diff what the agent changes.", retryable: false } };
    }
    if (input.activeFile) {
      try { await readWorkspaceFile(project.path, input.activeFile); }
      catch { return { error: { code: "FILE_CONTEXT_UNAVAILABLE", message: "The open file is no longer available in this repository. Reopen it before continuing.", retryable: false } }; }
    }
    const task = store.insertTask(project.id, input.prompt, previous.conversation_id);
    store.setSetting(`task.activeFile:${task.id}`, input.activeFile ?? "");
    store.saveDecision(task.id, { ...decision, providerId });
    store.updateTask(task.id, {
      consent: 1,
      base_commit: base,
      provider_id: providerId,
      status: "running",
      started_at: new Date().toISOString(),
      provider_session_id: previous.provider_session_id,
      continues_task_id: previous.id,
    });
    store.touchConversation(previous.conversation_id);
    store.selectConversation(project.id, previous.conversation_id);
    const abort = new AbortController();
    running.set(task.id, { abort });
    launched = true;
    void execute(store, hub, store.getTask(task.id) ?? task, project.path, providerId, abort)
      .catch((error: unknown) => {
        log("error", "Continued task failed", { taskId: task.id, error: error instanceof Error ? error.message : "unknown" });
      })
      .finally(() => {
        releaseProject(project.id);
      });
    return { task: publicTask(store, task.id) };
  } finally {
    if (!launched) releaseProject(project.id);
  }
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
  let before: WorktreeSnapshot | null = null;
  try {
  await awaitWorktreeIdle(repoPath);
  before = await captureWorktree(repoPath).catch((error: unknown) => {
    log("warn", "Could not snapshot the worktree before the task", {
      taskId: task.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  });
    const current = store.getTask(task.id) ?? task;
    session = await provider.startSession({
      prompt: current.prompt,
      activeFile: store.getSetting(`task.activeFile:${task.id}`) || undefined,
      repoPath,
      profile: decision!.profile,
      signal: abort.signal,
      resumeThreadId: current.continues_task_id ? current.provider_session_id ?? undefined : undefined,
      agent: await agentFor(providerId),
    });
    running.set(task.id, { abort, session });
    let failed: Extract<NormalizedEvent, { type: "session.failed" }> | undefined;
    let interrupted = false;
    for await (const event of session.events) {
      if (event.type === "session.started" && event.providerSessionId) {
        store.updateTask(task.id, { provider_session_id: event.providerSessionId });
      }
      publish(store, hub, task.id, event);
      if (event.type === "session.failed") failed = event;
      if (event.type === "session.failed" && event.code === "AGENT_SIGNED_OUT") onAgentSignedOut?.();
      if (event.type === "session.interrupted") {
        store.updateTask(task.id, {
          status: "interrupted",
          finished_at: new Date().toISOString(),
          error_code: "SESSION_INTERRUPTED",
          error_message: "The session was interrupted.",
        });
        interrupted = true;
      }
    }
    const after = before
      ? await captureWorktree(repoPath).catch((error: unknown) => {
          log("warn", "Could not snapshot the worktree after the task", {
            taskId: task.id,
            error: error instanceof Error ? error.message : "unknown",
          });
          return null;
        })
      : null;
    const events = store.listEvents(task.id).map((item) => item.event);
    interrupted ||= abort.signal.aborted;
    const missedWrite = !interrupted && !failed && before !== null && after !== null && sameWorktree(before, after) && claimedWriteMissed(events);
    const turnChanges = await changesForTurn(repoPath, before, after);
    if (turnChanges) await publishGitChanges(store, hub, task.id, turnChanges);
    if (missedWrite) publish(store, hub, task.id, { type: "session.failed", code: "REPOSITORY_UNCHANGED", message: "The agent reported edits, but Prentice found no repository changes for this task.", retryable: false });
    await writeUnderstand(store, hub, task.id, turnChanges ?? [], task.prompt, interrupted ? "interrupted" : failed || missedWrite ? "failed" : "completed", turnChanges !== null);
    if (interrupted) {
      store.updateTask(task.id, { status: "interrupted", finished_at: new Date().toISOString(), error_code: "SESSION_INTERRUPTED", error_message: "The task was interrupted. Confirmed partial evidence is available." });
    } else if (failed) {
      store.updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: failed.code,
        error_message: failed.message,
      });
    } else if (missedWrite && store.getTask(task.id)?.status === "running") {
      store.updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        error_code: "REPOSITORY_UNCHANGED",
        error_message: "The coding agent finished, but the repository content matches the start of the task.",
      });
    } else if (store.getTask(task.id)?.status === "running") {
      store.updateTask(task.id, { status: "completed", finished_at: new Date().toISOString() });
    }
    publish(store, hub, task.id, {
      type: "status",
      title: interrupted ? "Partial explanation for the interrupted task" : failed || missedWrite ? "Explanation kept for the failed run" : "Explanation ready",
      detail: interrupted ? "The task was interrupted. Completion was not recorded." : turnChanges === null ? "Task-specific file attribution is unavailable. Recorded commands and agent statements are preserved separately." : missedWrite
        ? "The session ended, and git shows the same repository content as when the task started."
        : "Observed from the git diff and the session record.",
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

/** Account switching cannot leave an agent editing the previous account's checkout. */
export async function stopAllTasks(): Promise<void> {
  await Promise.all([...running.keys()].map(id => interruptTask(id)));
  const deadline = Date.now() + 60_000;
  while (running.size && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
  if (running.size) throw new Error("A coding task is still stopping. Try switching accounts again.");
}

async function changesForTurn(
  repoPath: string,
  before: WorktreeSnapshot | null,
  after: WorktreeSnapshot | null,
): Promise<TurnChange[] | null> {
  // HEAD cannot attribute dirty or untracked content to this turn.
  if (before && after) return diffWorktrees(repoPath, before, after);
  return null;
}

async function publishGitChanges(store: Store, hub: EventHub, taskId: string, files: TurnChange[]): Promise<void> {
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

async function writeUnderstand(store: Store, hub: EventHub, taskId: string, files: TurnChange[], prompt: string, outcome: "completed" | "failed" | "interrupted", attributed: boolean): Promise<void> {
  const symbols = [];
  const implementation = [];
  const unparsedFiles: string[] = [];
  for (const file of files) {
    if (!isParsedLanguage(file.path)) {
      unparsedFiles.push(file.path);
      continue;
    }
    const extracted = await extractSymbolChanges(file.path, file.afterText, file.beforeText);
    if (!extracted.parsed) unparsedFiles.push(file.path);
    symbols.push(...extracted.symbols);
    implementation.push(...await extractImplementationSignals(file.path, file.afterText, file.beforeText));
  }
  const packet: EvidencePacket = {
    outcome,
    attribution: attributed ? "available" : "unavailable",
    taskId,
    prompt,
    files,
    symbols,
    implementation,
    activity: activityFrom(store.listEvents(taskId)),
    tests: testsFrom(store.listEvents(taskId)),
    projectName: store.getProject(store.getTask(taskId)?.project_id ?? "")?.name ?? "project",
    unparsedLanguages: [...new Set(unparsedFiles.map((path) => path.split(".").pop() ?? path))],
    unparsedFiles,
  };
  store.savePacket(taskId, packet);
  const baseArtifact = assembleUnderstand(packet);
  if (!learningStatus().ok) {
    store.saveUnderstand(taskId, await explainEvidence(packet, baseArtifact));
    return;
  }
  // Coding completion does not wait on tutoring. Stream the lesson when it becomes ready.
  store.saveUnderstand(taskId, { ...baseArtifact, learning: { pending: true, available: false, message: "Preparing the concept lesson…", explanation: null } });
  void explainEvidence(packet, baseArtifact).then(artifact => {
    store.saveUnderstand(taskId, artifact);
    publish(store, hub, taskId, { type: "status", title: "Explanation ready" });
  }).catch(error => {
    log("warn", "Could not save concept lesson", { taskId, error: error instanceof Error ? error.message : "unknown" });
  });
}

/** Runner tallies come from normalized successful output or retained bounded failure output. */
function testsFrom(events: StoredEvent[]): EvidencePacket["tests"] {
  let found: EvidencePacket["tests"] = null;
  for (const item of events) {
    const event = item.event;
    if (event.type !== "command.finished") continue;
    const summary = event.tests ?? (event.output ? parseTestSummary(event.output.text) : null);
    if (summary) found = { evidenceId: item.id, passed: summary.passed, failed: summary.failed };
  }
  return found;
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
        exitCode: event.type === "command.finished" ? event.exitCode : undefined,
        ...(event.type === "command.finished" && event.output ? { output: event.output } : {}),
        source: "agent",
      });
    } else if (event.type === "session.failed") {
      records.push({
        evidenceId: item.id,
        title: "Session failed",
        detail: event.message,
        kind: "session.failed",
        source: "runtime",
      });
    }
  }
  const final = events.map(item => item.event).filter(event => event.type === "session.completed").at(-1);
  if (!events.some(item => item.event.type === "session.started" && item.event.providerSessionId === "fixture") && final?.summary?.trim() && !records.some(item => item.kind === "assistant" && item.detail?.trim() === final.summary?.trim())) {
    records.push({ evidenceId: events.at(-1)?.id ?? "final", title: "Agent note", detail: final.summary, kind: "assistant", source: "agent" });
  }
  return records;
}

function publish(store: Store, hub: EventHub, taskId: string, event: NormalizedEvent): StoredEvent {
  const stored = store.appendEvent(taskId, event);
  hub.publish(taskId, stored);
  return stored;
}

export function connectedProviders(
  store: Store,
  accounts: AccountSnapshot["accounts"],
  allowFixture = true,
): ConnectedProvider[] {
  const providers: ConnectedProvider[] = [];
  (["claude-code", "codex", "cursor"] as const).forEach((providerId) => {
    if (!accounts[providerId].connected) return;
    const saved = store.getSetting(`connectedAt:${providerId}`);
    const order = saved ? Number(saved) : Date.now();
    providers.push({ providerId, capabilities: CAPABILITIES_BY_ID[providerId], connectionOrder: order });
  });
  if (providers.length === 0 && allowFixture) {
    providers.push({ providerId: "fixture", capabilities: CAPABILITIES_BY_ID.fixture, connectionOrder: 0 });
  }
  return providers;
}

export function publicTask(store: Store, taskId: string) {
  let task = store.getTask(taskId);
  if (!task) return undefined;
  if (task.status === "running" && !running.has(taskId)) {
    store.updateTask(taskId, {
      status: "interrupted",
      finished_at: new Date().toISOString(),
      error_code: "SESSION_ENDED",
      error_message:
        "Prentice stopped before this task finished. Confirmed edits remain in the working tree. A new run waits until the previous agent guardian has stopped.",
    });
    task = store.getTask(taskId) ?? task;
  }
  const events = store.listEvents(taskId);
  const timeline = toConversationTimeline(events.map((item) => ({ ...item.event, id: item.id })));
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
    continuation: continuationFor(task),
    recovery: recoveryFor(task),
    issues: debugIssues(timeline, understand?.observed.map((claim) => claim.text) ?? []),
  };
}

/** One failure is one Debug entry: a failed test command already carries the runner's own output. */
function debugIssues(timeline: ReturnType<typeof toTimeline>, observed: string[]) {
  const fromTimeline = debugIssuesFromTimeline(timeline);
  if (fromTimeline.some((issue) => issue.output)) return fromTimeline;
  return [...fromTimeline, ...debugIssuesFromObservations(observed)];
}

/** An interrupted or crashed run can be sent again as a new conversation with the same prompt. */
export function recoveryFor(task: TaskRow): { kind: "send-again"; prompt: string; message: string } | null {
  if (task.status !== "interrupted") return null;
  const crashed = task.error_code === "SESSION_ENDED";
  return {
    kind: "send-again",
    prompt: task.prompt,
    message: crashed
      ? "Prentice stopped before this run finished. Files the agent already changed are still in the working tree."
      : "This run was stopped. Files the agent already changed are still in the working tree.",
  };
}

export function explainView(state: ReturnType<Store["getExplain"]>) {
  if (!state) return null;
  if (state.asked.length && !state.asked.some(question => question.grounding === "inference")) {
    state = { ...state, asked: [], candidates: [], phase: "unavailable", current: null, feedback: { understood: [], unclear: [] }, teaching: null, hint: null, coach: null, learningMessage: "This saved check tested code recall. New turns use concept checks instead." };
  }
  return {
    phase: state.phase,
    questionNumber: state.initialAsked,
    policy: state.policy,
    current: state.current
      ? {
          id: state.current.id,
          concept: state.current.concept,
          prompt: state.current.prompt,
          grounding: state.current.grounding,
          citations: state.current.citations,
          assessmentEligible: Boolean(assessmentSpec(state.current) || knowledgeFor({prompt:state.current.prompt,concept:state.current.concept}).length),
        }
      : null,
    feedback: state.feedback,
    topics: state.candidates.map(question => ({ id: question.id, title: question.concept, understood: state.feedback.understood.includes(question.concept) })),
    unpractised: state.candidates.filter(question => !state.feedback.understood.includes(question.concept) && !state.feedback.unclear.includes(question.concept) && !(state.turns ?? []).some(turn => turn.questionId === question.id && turn.assessment?.status === "provisional")).map(question => question.concept),
    practisedProvisionally: state.candidates.filter(question => !state.feedback.understood.includes(question.concept) && (state.turns ?? []).some(turn => turn.questionId === question.id && turn.assessment?.status === "provisional")).map(question => question.concept),
    hasNext: Boolean(state.returnTo && state.returnTo !== state.current?.id) || state.candidates.some(question => !state.asked.some(asked => asked.id === question.id)),
    hint: state.hint ?? null,
    teaching: state.teaching ?? null,
    coach: state.coach ?? null,
    learningMessage: state.learningMessage ?? null,
    discussion: state.discussion ?? [],
    turns: (state.turns ?? []).map(({ evaluatedAnswer: _answer, assessment, ...turn }) => ({...turn,assessment:assessment?.status==='assessed'?{status:assessment.status,method:assessment.method,revision:assessment.revision,unitId:assessment.unitId,outcome:assessment.outcome,reason:assessment.reason}:assessment})),
  };
}

export function continuationFor(task: TaskRow): { available: boolean; message: string } {
  if (task.provider_id === "cursor") {
    return {
      available: false,
      message: "Continuation is not available for Cursor. A live resume has not been verified, so Prentice will not start a new agent and call it continuation.",
    };
  }
  if (task.provider_id !== "codex" && task.provider_id !== "claude-code") {
    return { available: false, message: "Continuation is not available for this agent." };
  }
  if (!task.provider_session_id) {
    return { available: false, message: "The agent did not record a conversation to continue." };
  }
  if (task.status === "running" || task.status === "analyzed") {
    return { available: false, message: "This conversation is still in progress." };
  }
  return { available: true, message: "Continue in the same coding-agent conversation." };
}

export async function beginExplain(store: Store, taskId: string) {
  const existing = store.getExplain(taskId);
  if (existing && existing.phase !== "unavailable" && (!existing.asked.length || existing.asked.some(question => question.grounding === "inference"))) return explainView(existing);
  const packet = store.getPacket(taskId);
  const decision = store.getDecision(taskId);
  if (!packet || !decision || store.getUnderstand(taskId)?.learning?.pending) return null;
  const task = store.getTask(taskId);
  const known = task ? store.demonstratedConcepts(task.project_id) : [];
  const status = learningStatus();
  const concepts = store.getUnderstand(taskId)?.learning?.concepts ?? [];
  const state = { ...startExplainSession(packet, decision.complexity, known, concepts), turns: existing?.turns ?? [], discussion: existing?.discussion ?? [] };
  if (status.ok && !state.current && concepts.length) {
    store.saveExplain(taskId, state);
    return explainView(state);
  }
  if (!status.ok || !state.current) {
    const unavailable = {
      ...state,
      phase: "unavailable" as const,
      current: null,
      learningMessage: status.ok ? "There is not enough evidence for a useful concept check yet." : status.message,
    };
    store.saveExplain(taskId, unavailable);
    return explainView(unavailable);
  }
  store.saveExplain(taskId, state);
  return explainView(state);
}

// Serialize all learning mutations per task. Separate tasks remain independent.
const learningTurns = new WeakMap<Store, Map<string, Promise<unknown>>>();
export function answerExplain(store: Store, taskId: string, answer: string, messageId: string = randomUUID(), action?: ExplainAction, hub?: EventHub, questionId?: string) {
  // Capture what the sender saw before queueing. A preceding correct answer may
  // advance the check while this message waits; it still belongs to that topic.
  const anchor = store.getExplain(taskId)?.current?.id ?? null;
  let tasks = learningTurns.get(store);
  if (!tasks) { tasks = new Map(); learningTurns.set(store, tasks); }
  const previous = tasks.get(taskId) ?? Promise.resolve();
  const work = previous.catch(() => undefined).then(() => respondExplain(store, taskId, answer, messageId, action, hub, questionId, anchor));
  tasks.set(taskId, work);
  void work.finally(() => { if (tasks.get(taskId) === work) tasks.delete(taskId); }).catch(() => undefined);
  return work;
}

async function respondExplain(store: Store, taskId: string, message: string, messageId: string, action?: ExplainAction, hub?: EventHub, requestedQuestionId?: string, anchor?: string | null) {
  let state = store.getExplain(taskId);
  const packet = store.getPacket(taskId);
  if (!state || !packet) return null;
  if (state.asked.length && !state.asked.some(question => question.grounding === "inference")) {
    state = { ...state, asked: [], candidates: [], current: null, phase: "unavailable", feedback: { understood: [], unclear: [] }, teaching: null, hint: null, coach: null };
  }
  message = scrubEvidence(message);
  const existing = state.turns?.find(turn => turn.id === messageId);
  // A retried transport request must never evaluate a new question or duplicate a sent message.
  if (existing?.status === "replied" || (existing && existing.message !== message)) return explainView(state);
  const turn = existing ?? {
    id: messageId, questionId: anchor ?? null, prompt: state.asked.find(question => question.id === anchor)?.prompt ?? null,
    action, requestedQuestionId,
    message, status: "pending" as const, response: null, kind: "inference" as const,
  };
  state = { ...state, learningMessage: null, turns: [...(state.turns ?? []).filter(item => item.id !== messageId), { ...turn, status: "pending" }] };
  store.saveExplain(taskId, state);
  if (hub) publish(store, hub, taskId, { type: "status", title: "Prentice is replying" });
  // A failed reply retried after the learner moved on still belongs to its original question.
  action = turn.action;
  requestedQuestionId = turn.requestedQuestionId;
  const anchorQuestion = state.candidates.find(question => question.id === turn.questionId) ?? null;
  const reply = action ? null : await converseLearning(packet, { ...state, current: anchorQuestion }, message);
  // Read again: Skip may have been requested while the model was replying.
  let next = store.getExplain(taskId) ?? state;
  let response: string;
  let assessed = false;
  let understood = false;
  let hint: string | null = null;
  let teaching: string | null = null;
  let questionId = turn.questionId;
  let prompt = turn.prompt;
  if (reply && !reply.ok) {
    response = reply.message;
    next = { ...next, learningMessage: reply.message };
  } else if (action === "finish" || reply?.intent === "finish") {
    next = finishExplainSession(next);
    response = "Learning session finished. Teaching and skipped questions do not count as demonstrated understanding. You can still ask questions or revisit a concept.";
  } else if (action === "next" || action === "skip" || reply?.intent === "continue" || reply?.intent === "skip") {
    if (next.current?.id === turn.questionId) next = continueExplainSession(next);
    response = next.current ? `Now exploring ${next.current.concept}. The previous topic remains available to revisit.` : "That's the end of this learning session. You can keep discussing these ideas or revisit a concept.";
  } else if (action === "practice" || action === "revisit" || reply?.intent === "practice" || reply?.intent === "revisit") {
    const id = requestedQuestionId ?? reply?.revisitId ?? next.current?.id ?? next.asked.at(-1)?.id;
    const target = next.candidates.find(question => question.id === id);
    const practice = action === "practice" || reply?.intent === "practice";
    if (target && next.phase !== "unavailable") {
      next = revisitExplainSession(next, target.id);
      if (practice) next = practiseExplainSession(next);
      questionId = target.id;
      prompt = null;
      response = practice ? `Let's practise ${target.concept} in your own words.\n\n${target.prompt}`
        : reply?.text ?? `Revisiting ${target.concept}. The saved lesson above is prior Prentice interpretation. Ask for a fresh explanation or example, choose to practise, or move forward when you're ready.`;
    } else response = "There is no concept available to practise yet. You can still ask a general question about the recorded lessons.";
  } else if (reply?.ok) {
    response = reply.text;
    // A help request can put its actual clue in hint rather than text. Keep both.
    hint = reply.hint || null;
    const target = reply.target;
    if (reply.intent === "teach") {
      // Keep the newly returned teaching body alongside its introduction. The
      // model may put the worked example here rather than repeat it in text.
      teaching = reply.teaching || null;
      if (next.current?.id === turn.questionId) {
        next = teachExplainSession(next);
        if (teaching) next = { ...next, teaching };
      }
    }
    if (reply.assessment?.status === "provisional" && target) {
      questionId=target.id; prompt=target.prompt;
      if(next.current?.id===target.id)next={...next,coach:response};

    }
    if (reply.assessment?.status === "assessed" && (reply.intent === "answer" || reply.intent === "review") && target?.grounding === "inference" && next.phase !== "skipped" && next.phase !== "unavailable") {
      assessed = true;
      understood = reply.understood;
      questionId = target.id;
      prompt = target.prompt;
      if (next.current?.id === target.id) {
        next = reply.intent === "review" && !understood
          ? { ...next, coach: response, hint: reply.hint || next.hint }
          : applyExplainJudgment(next, { understood, feedback: response, hint: reply.hint });
        // A review may retain coaching context internally, but its transcript
        // should contain only the clue returned for this particular message.
        hint = understood ? null : reply.intent === "review" ? reply.hint || null : next.hint;
        if (reply.teaching && next.phase === "taught") next = { ...next, teaching: reply.teaching };
        teaching = reply.teaching || (!state.teaching && next.phase === "taught" ? next.teaching : null);
      } else {
        // Correct a past evaluation without replacing the current question or losing its attempts.
        const known = new Set(next.feedback.understood);
        const unclear = new Set(next.feedback.unclear);
        if (understood) { known.add(target.concept); unclear.delete(target.concept); }
        else if (!known.has(target.concept)) unclear.add(target.concept);
        next = { ...next, feedback: { understood: [...known], unclear: [...unclear] } };
      }
      const task = store.getTask(taskId);
      if (task && understood) store.demonstrate(task.project_id, target.concept);
    }
  } else response = "Your learning conversation is saved. Choose a concept or send a follow-up question.";
  const finished = { ...turn, questionId, prompt, response, assessed, understood, hint, teaching,
    assessment: reply?.ok ? reply.assessment : undefined, support: reply?.ok ? reply.support : undefined,
    reviewOf: reply?.ok ? reply.reviewOf : undefined,
    evaluatedAnswer: reply?.ok && (assessed || reply.assessment) ? reply.evaluatedAnswer : undefined,
    status: reply && !reply.ok ? "failed" as const : "replied" as const };
  next = { ...next, turns: (next.turns ?? []).map(item => item.id === messageId ? finished : item) };
  if (assessed && reply?.ok && reply.intent === "review" && reply.target && reply.assessment?.status === 'assessed' && reply.assessment.outcome !== 'partial') {
    const judgments = new Map<string, boolean>();
    for (const item of next.turns ?? []) {
      if (item.assessed && item.questionId === reply.target.id && item.status === "replied" && !(item.reviewOf && item.assessment?.status === 'assessed' && item.assessment.outcome === 'partial')) judgments.set(item.reviewOf ?? item.id, Boolean(item.understood));
    }
    const concept = reply.target.concept;
    const proven = [...judgments.values()].some(Boolean);
    next = { ...next, feedback: {
      understood: proven ? [...new Set([...next.feedback.understood, concept])] : next.feedback.understood.filter(item => item !== concept),
      unclear: proven ? next.feedback.unclear.filter(item => item !== concept) : [...new Set([...next.feedback.unclear, concept])],
    } };
  }
  store.saveExplain(taskId, next);
  if (assessed && reply?.ok && reply.intent === "review" && reply.target && reply.assessment?.status === 'assessed' && reply.assessment.outcome === 'incorrect' && !next.feedback.understood.includes(reply.target.concept)) {
    const task = store.getTask(taskId);
    if (task && state.feedback.understood.includes(reply.target.concept)) store.retractDemonstrationIfUnproven(task.project_id, reply.target.concept);
  }
  if (hub) publish(store, hub, taskId, { type: "status", title: "Prentice replied" });
  return explainView(next);
}

/** Legacy discussion clients now share the same persisted conversational flow. */
export function discussTask(store: Store, taskId: string, question: string, messageId?: string, hub?: EventHub) {
  return answerExplain(store, taskId, question, messageId, undefined, hub);
}

export function skipExplain(store: Store, taskId: string) {
  const state = store.getExplain(taskId);
  if (!state) return null;
  const next = skipExplainSession(state);
  store.saveExplain(taskId, next);
  return explainView(next);
}
