import {
  assembleUnderstand,
  CAPABILITIES_BY_ID,
  classifyTask,
  debugIssuesFromObservations,
  debugIssuesFromTimeline,
  routeTask,
  applyExplainJudgment,
  startExplainSession,
  skipExplainSession,
  toTimeline,
  type ActivityRecord,
  type ConnectedProvider,
  type EvidencePacket,
  type NormalizedEvent,
  type ProviderId,
  type RoutingOverride,
} from "@prentice/domain";
import { readProjectContext } from "./context.js";
import { captureWorktree, collectDiff, diffWorktrees, headCommit, sameWorktree, type TurnChange, type WorktreeSnapshot } from "./git.js";
import { log } from "./log.js";
import { providerFactory, type AgentSession } from "./providers.js";
import type { AccountSnapshot } from "./accounts.js";
import { conversationTitle, Store, type StoredEvent, type TaskRow } from "./store.js";
import { discussLearning, explainEvidence, judgeLearningAnswer, learningStatus, phraseQuestion } from "./learning.js";
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
const activeProjects = new Set<string>();

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

export function commandWritesRepository(command: string): boolean {
  return />>?|[|]\s*tee\b|\b(?:mkdir|rmdir|rm|mv|cp|touch|truncate|install|unlink)\b|\bsed\b[^\n]*\s-i|\bperl\b[^\n]*\s-i|\bgit\s+(?:add|commit|checkout|switch|restore|reset|clean|mv|rm)\b/i.test(
    command,
  );
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
        message: "Connect Codex, Claude Code, or Cursor on this computer before starting a task.",
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
  const conversation = store.insertConversation(project.id, conversationTitle(prompt));
  const task = store.insertTask(project.id, prompt, conversation.id);
  store.selectConversation(project.id, conversation.id);
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
    const ready = await launchTask(store, accounts, hub, task, input, allowFixture);
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
  hub: EventHub,
  task: TaskRow,
  input: { consent: boolean; override?: RoutingOverride },
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
        message: "Connect Codex, Claude Code, or Cursor on this computer before starting a task.",
        retryable: false,
      },
    };
  }
  store.updateTask(task.id, { consent: 1, base_commit: base, provider_id: decision.providerId, status: "running" });
  const abort = new AbortController();
  running.set(task.id, { abort });
  const current = store.getTask(task.id) ?? task;
  return { task: current, repoPath: project.path, providerId: decision.providerId, abort };
}

export async function continueTask(
  store: Store,
  hub: EventHub,
  taskId: string,
  input: { prompt: string; consent: boolean },
) {
  const loaded = store.getTask(taskId);
  if (!loaded) return { error: { code: "NOT_FOUND", message: "Task not found.", retryable: false } };
  store.ensureConversations(loaded.project_id);
  const previous = store.getTask(taskId) ?? loaded;
  const continuation = continuationFor(previous);
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
    const task = store.insertTask(project.id, input.prompt, previous.conversation_id);
    store.saveDecision(task.id, { ...decision, providerId: "codex" });
    store.updateTask(task.id, {
      consent: 1,
      base_commit: base,
      provider_id: "codex",
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
    void execute(store, hub, store.getTask(task.id) ?? task, project.path, "codex", abort)
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
  const before = await captureWorktree(repoPath).catch((error: unknown) => {
    log("warn", "Could not snapshot the worktree before the task", {
      taskId: task.id,
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  });
  try {
    const current = store.getTask(task.id) ?? task;
    session = await provider.startSession({
      prompt: current.prompt,
      repoPath,
      profile: decision!.profile,
      signal: abort.signal,
      resumeThreadId: current.continues_task_id ? current.provider_session_id ?? undefined : undefined,
    });
    running.set(task.id, { abort, session });
    let failed: Extract<NormalizedEvent, { type: "session.failed" }> | undefined;
    for await (const event of session.events) {
      if (event.type === "session.started" && event.providerSessionId) {
        store.updateTask(task.id, { provider_session_id: event.providerSessionId });
      }
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
    const missedWrite = !failed && before !== null && after !== null && sameWorktree(before, after) && claimedWriteMissed(events);
    const turnChanges = await changesForTurn(repoPath, base ?? null, before, after);
    if (turnChanges) await publishGitChanges(store, hub, task.id, turnChanges);
    if (turnChanges) await writeUnderstand(store, task.id, turnChanges, task.prompt);
    if (failed) {
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
      title: failed || missedWrite ? "Explanation kept for the failed run" : "Explanation ready",
      detail: missedWrite
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

async function changesForTurn(
  repoPath: string,
  base: string | null,
  before: WorktreeSnapshot | null,
  after: WorktreeSnapshot | null,
): Promise<TurnChange[] | null> {
  if (!base) return null;
  if (before && after) return diffWorktrees(repoPath, before, after);
  const files = await collectDiff(repoPath, base);
  return files.map((file) => ({ ...file, beforeText: null, afterText: null }));
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

async function writeUnderstand(store: Store, taskId: string, files: TurnChange[], prompt: string): Promise<void> {
  const symbols = [];
  const unparsedFiles: string[] = [];
  for (const file of files) {
    if (!isParsedLanguage(file.path)) {
      unparsedFiles.push(file.path);
      continue;
    }
    const extracted = await extractSymbolChanges(file.path, file.afterText, file.beforeText);
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
  const artifact = await explainEvidence(packet, assembleUnderstand(packet));
  store.saveUnderstand(taskId, artifact);
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
      error_message: "The runtime is not running this task.",
    });
    task = store.getTask(taskId) ?? task;
  }
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
    continuation: continuationFor(task),
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
    questionNumber: state.initialAsked,
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
    hint: state.hint ?? null,
    teaching: state.teaching ?? null,
    coach: state.coach ?? null,
    learningMessage: state.learningMessage ?? null,
    discussion: state.discussion ?? [],
  };
}

export function continuationFor(task: TaskRow): { available: boolean; message: string } {
  if (task.provider_id === "claude-code") {
    return {
      available: false,
      message: "Continuation is not available for Claude Code. A live resume has not been verified, so Prentice will not start a new session and call it continuation.",
    };
  }
  if (task.provider_id === "cursor") {
    return {
      available: false,
      message: "Continuation is not available for Cursor. A live resume has not been verified, so Prentice will not start a new agent and call it continuation.",
    };
  }
  if (task.provider_id !== "codex") {
    return { available: false, message: "Continuation is not available for this agent." };
  }
  if (!task.provider_session_id) {
    return { available: false, message: "Codex did not record a conversation to continue." };
  }
  if (task.status === "running" || task.status === "analyzed") {
    return { available: false, message: "This Codex conversation is still in progress." };
  }
  return { available: true, message: "Continue in the same Codex conversation." };
}

export async function beginExplain(store: Store, taskId: string) {
  const existing = store.getExplain(taskId);
  if (existing && existing.phase !== "unavailable") return explainView(existing);
  const packet = store.getPacket(taskId);
  const decision = store.getDecision(taskId);
  if (!packet || !decision) return null;
  const task = store.getTask(taskId);
  const known = task ? store.demonstratedConcepts(task.project_id) : [];
  const status = learningStatus();
  const state = startExplainSession(packet, decision.complexity, known);
  if (!status.ok || !state.current) {
    const unavailable = {
      ...state,
      phase: "unavailable" as const,
      current: null,
      learningMessage: status.ok ? "There is no recorded fact to ask about." : status.message,
    };
    store.saveExplain(taskId, unavailable);
    return explainView(unavailable);
  }
  const phrased = await phraseQuestion(packet, state.current);
  if (!phrased) {
    store.saveExplain(taskId, {
      ...state,
      phase: "unavailable",
      learningMessage: "The Learning AI is unavailable. Prentice will not ask a coding agent to teach instead.",
    });
    return explainView(store.getExplain(taskId));
  }
  const asking = { ...state, current: { ...state.current, prompt: phrased }, asked: [{ ...state.current, prompt: phrased }] };
  store.saveExplain(taskId, asking);
  return explainView(asking);
}

export async function answerExplain(store: Store, taskId: string, answer: string) {
  const state = store.getExplain(taskId);
  const packet = store.getPacket(taskId);
  if (!state || !packet || !state.current) return state ? explainView(state) : null;
  const before = new Set(state.feedback.understood);
  const judged = await judgeLearningAnswer(packet, state.current, answer);
  if (!judged.ok) {
    const next = { ...state, learningMessage: judged.message };
    store.saveExplain(taskId, next);
    return explainView(next);
  }
  const next = applyExplainJudgment(state, judged);
  store.saveExplain(taskId, next);
  const task = store.getTask(taskId);
  if (task) {
    for (const concept of next.feedback.understood) {
      if (!before.has(concept)) store.demonstrate(task.project_id, concept);
    }
  }
  return explainView(next);
}

export async function discussTask(store: Store, taskId: string, question: string) {
  const state = store.getExplain(taskId);
  const packet = store.getPacket(taskId);
  if (!state || !packet) return null;
  const reply = await discussLearning(packet, question);
  const entry = "ok" in reply
    ? { question, kind: "unrecorded" as const, text: reply.message }
    : { question, kind: reply.kind, text: reply.text };
  const next = { ...state, discussion: [...(state.discussion ?? []), entry], learningMessage: "ok" in reply ? reply.message : state.learningMessage };
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
