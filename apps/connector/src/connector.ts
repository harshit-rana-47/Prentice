import { basename, resolve } from "node:path";
import { PROVIDER_IDS, labelComplexity, labelIntensity, type ProviderId } from "@prentice/domain";
import { z } from "zod";
import { AccountService, type Accounts } from "./accounts.js";
import { gitRoot } from "./git.js";
import { canonicalRepoPath, identifiesRepository } from "./paths.js";
import { providerFactory } from "./providers.js";
import { SecretStore } from "./secrets.js";
import {
  EventHub,
  analyzeTask,
  answerExplain,
  beginExplain,
  connectedProviders,
  continueTask as continueSavedTask,
  discussTask,
  interruptTask,
  publicTask,
  skipExplain,
  startTask,
  taskIsRunning,
} from "./session.js";
import { Store, type StoredEvent } from "./store.js";
import { readWorkspaceDiff, readWorkspaceFile, workspaceSnapshot } from "./workspace.js";

const overrideSchema = z
  .object({
    providerId: z.enum(PROVIDER_IDS).optional(),
    intensity: z.enum(["fast", "balanced", "deep", "maximum"]).optional(),
    useProviderMax: z.boolean().optional(),
  })
  .optional();

const analyzeSchema = z.object({ prompt: z.string().trim().min(1).max(20_000) });
const startSchema = z.object({ consent: z.boolean(), override: overrideSchema });
const answerSchema = z.object({ answer: z.string().trim().min(1).max(8_000) });
const openSchema = z.object({ path: z.string().min(1) });
const pinSchema = z.object({ providerId: z.enum(PROVIDER_IDS).nullable() });

export interface ConnectorError {
  code: string;
  message: string;
  retryable: boolean;
}

export type ConnectorResult<T> =
  | { ok: true; status: number; body: T }
  | { ok: false; status: number; error: ConnectorError };

export interface ConnectorOptions {
  store: Store;
  secrets: SecretStore;
  hub?: EventHub;
  accounts?: Accounts;
}

export function createConnector(options: ConnectorOptions) {
  const hub = options.hub ?? new EventHub();
  const accounts = options.accounts ?? new AccountService(options.secrets);

  return {
    currentProject(): ConnectorResult<{ project: ProjectView | null }> {
      const project = options.store.latestProject();
      return ok({ project: project ? projectView(project) : null });
    },

    projects(): ConnectorResult<{
      projects: Array<{
        id: string;
        name: string;
        path: string;
        current: boolean;
        conversations: Array<{ id: string; title: string; updatedAt: string; current: boolean; running: boolean }>;
      }>;
    }> {
      const current = options.store.latestProject();
      const projects = options.store.listProjects().map((project) => {
        options.store.ensureConversations(project.id);
        const selected = options.store.getProject(project.id)?.selected_conversation_id ?? null;
        return {
          id: project.id,
          name: project.name,
          path: project.path,
          current: project.id === current?.id,
          conversations: options.store.listConversations(project.id).map((conversation) => {
            const head = options.store.conversationHead(conversation.id);
            return {
              id: conversation.id,
              title: conversation.title,
              updatedAt: conversation.updated_at,
              current: project.id === current?.id && conversation.id === selected,
              running: Boolean(head && taskIsRunning(head.id)),
            };
          }),
        };
      });
      return ok({ projects });
    },

    async openProject(body: unknown): Promise<ConnectorResult<{ project: ProjectView }>> {
      const parsed = openSchema.safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Provide an absolute path to a local repository.");
      const requested = resolve(parsed.data.path);
      const root = await gitRoot(requested);
      if (!root) {
        return fail(400, "GIT_REQUIRED", "That path is not a git repository. Prentice does not upload it anywhere.");
      }
      const path = await canonicalRepoPath(root);
      const aliasIds: string[] = [];
      for (const project of options.store.listProjects()) {
        if (await identifiesRepository(project.path, path)) aliasIds.push(project.id);
      }
      const project = options.store.reopenProject(path, basename(path), aliasIds);
      return ok({ project: projectView(project) });
    },

    async workspace(): Promise<ConnectorResult<{ project: ProjectView } & Awaited<ReturnType<typeof workspaceSnapshot>>>> {
      const project = options.store.latestProject();
      if (!project) return fail(400, "PROJECT_REQUIRED", "Open a local git repository first.");
      const snapshot = await workspaceSnapshot(project.path);
      return ok({ project: projectView(project), ...snapshot });
    },

    async workspaceFile(requestPath: string): Promise<ConnectorResult<Awaited<ReturnType<typeof readWorkspaceFile>>>> {
      const project = options.store.latestProject();
      if (!project) return fail(400, "PROJECT_REQUIRED", "Open a local git repository first.");
      try {
        return ok(await readWorkspaceFile(project.path, requestPath));
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : "";
        if (code === "PATH_OUTSIDE") return fail(400, "PATH_OUTSIDE", "That path is outside the open repository.");
        return fail(404, "NOT_FOUND", "That file is not in the open repository.");
      }
    },

    async workspaceDiff(requestPath: string): Promise<ConnectorResult<Awaited<ReturnType<typeof readWorkspaceDiff>>>> {
      const project = options.store.latestProject();
      if (!project) return fail(400, "PROJECT_REQUIRED", "Open a local git repository first.");
      try {
        return ok(await readWorkspaceDiff(project.path, requestPath));
      } catch (reason) {
        const code = reason instanceof Error ? reason.message : "";
        if (code === "PATH_OUTSIDE") return fail(400, "PATH_OUTSIDE", "That path is outside the open repository.");
        return fail(404, "NOT_FOUND", "That diff is not available.");
      }
    },

    async providers(): Promise<ConnectorResult<{ providers: ProviderView[]; pinned: string | null; active: string[] }>> {
      const snapshot = await accounts.list();
      for (const id of ["claude-code", "codex", "cursor"] as const) {
        if (snapshot.accounts[id].connected && !options.store.getSetting(`connectedAt:${id}`)) {
          options.store.setSetting(`connectedAt:${id}`, String(Date.now()));
        }
      }
      const pinned = options.store.getSetting("pinnedProvider") || null;
      const providers = PROVIDER_IDS.map((id) => {
        const capabilities = providerFactory(id).getCapabilities();
        const connected = id === "fixture" ? true : snapshot.accounts[id].connected;
        const job = id === "fixture" ? undefined : snapshot.jobs[id];
        return {
          id,
          connected,
          login: job?.phase ?? "idle",
          message: job?.message ?? "",
          capabilities,
          inference: capabilities.inference,
          repositoryExecution: capabilities.repositoryExecution,
        };
      });
      return ok({
        providers,
        pinned,
        active: connectedProviders(options.store, snapshot.accounts).map((item) => item.providerId),
      });
    },

    async connectProvider(id: string): Promise<ConnectorResult<{ ok: true; message?: string; login?: string }>> {
      if (!isProviderId(id)) return fail(404, "NOT_FOUND", "Unknown provider.");
      if (id === "fixture") {
        return ok({ ok: true, message: "The fixture provider is a local demo. It does not use an account." });
      }
      await accounts.connect(id);
      return { ok: true, status: 202, body: { ok: true, login: "pending", message: "Opening the official sign-in page." } };
    },

    async disconnectProvider(id: string): Promise<ConnectorResult<{ ok: true }>> {
      if (!isProviderId(id) || id === "fixture") return fail(404, "NOT_FOUND", "Unknown provider.");
      await accounts.disconnect(id);
      options.store.setSetting(`connectedAt:${id}`, "");
      return ok({ ok: true });
    },

    async pinProvider(body: unknown): Promise<ConnectorResult<{ pinned: ProviderId | null }>> {
      const parsed = pinSchema.safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Pin a connected provider or clear the pin.");
      if (parsed.data.providerId) options.store.setSetting("pinnedProvider", parsed.data.providerId);
      else options.store.setSetting("pinnedProvider", "");
      return ok({ pinned: parsed.data.providerId });
    },

    async analyze(body: unknown) {
      const parsed = analyzeSchema.safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Write a task prompt.");
      const snapshot = await accounts.list();
      const result = await analyzeTask(options.store, snapshot.accounts, parsed.data.prompt);
      if ("error" in result && result.error) return { ok: false as const, status: 400, error: result.error };
      return ok(present(result));
    },

    async start(taskId: string, body: unknown) {
      const parsed = startSchema.safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Consent is required before a task starts.");
      const snapshot = await accounts.list();
      const result = await startTask(options.store, snapshot.accounts, hub, taskId, parsed.data);
      if ("error" in result && result.error) {
        const status = result.error.code === "PROJECT_BUSY" ? 409 : 400;
        return { ok: false as const, status, error: result.error };
      }
      return { ok: true as const, status: 202, body: result };
    },

    async interrupt(taskId: string): Promise<ConnectorResult<{ ok: true }>> {
      await interruptTask(taskId);
      return ok({ ok: true });
    },

    task(taskId: string) {
      const task = publicTask(options.store, taskId);
      if (!task) return fail(404, "NOT_FOUND", "Task not found.");
      return ok({ task: presentTask(task) });
    },

    latestTask() {
      return ok(conversationSnapshot(options.store));
    },

    selectConversation(conversationId: string) {
      const project = options.store.latestProject();
      const conversation = options.store.getConversation(conversationId);
      if (!project || !conversation || conversation.project_id !== project.id) {
        return fail(404, "NOT_FOUND", "That conversation is not in the open repository.");
      }
      options.store.selectConversation(project.id, conversation.id);
      return ok(conversationSnapshot(options.store));
    },

    watchTask(taskId: string): ConnectorResult<{
      replay(): StoredEvent[];
      subscribe(listener: (event: StoredEvent) => void): () => void;
      presented(): ReturnType<typeof presentTask> | null;
    }> {
      if (!options.store.getTask(taskId)) return fail(404, "NOT_FOUND", "Task not found.");
      return ok({
        replay: () => options.store.listEvents(taskId),
        subscribe: (listener) => hub.subscribe(taskId, listener),
        presented: () => {
          const task = publicTask(options.store, taskId);
          return task ? presentTask(task) : null;
        },
      });
    },

    understand(taskId: string) {
      const task = publicTask(options.store, taskId);
      if (!task) return fail(404, "NOT_FOUND", "Task not found.");
      return ok({ understand: task.understand });
    },

    async explainBack(taskId: string) {
      const view = await beginExplain(options.store, taskId);
      if (!view) return fail(409, "NOT_READY", "The explanation is not ready yet.");
      return ok({ explain: view });
    },

    async answerExplainBack(taskId: string, body: unknown) {
      const parsed = answerSchema.safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Write an answer first.");
      const view = await answerExplain(options.store, taskId, parsed.data.answer);
      if (!view) return fail(409, "NOT_READY", "Start explain-back before answering.");
      return ok({ explain: view });
    },

    async continueTask(taskId: string, body: unknown) {
      const parsed = z.object({ prompt: z.string().trim().min(1).max(20_000), consent: z.boolean() }).safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Write what to continue, and confirm consent.");
      const result = await continueSavedTask(options.store, hub, taskId, parsed.data);
      if ("error" in result && result.error) {
        const status = result.error.code === "NOT_FOUND" ? 404 : 409;
        return fail(status, result.error.code, result.error.message);
      }
      return ok(result);
    },

    async discussExplainBack(taskId: string, body: unknown) {
      const parsed = z.object({ question: z.string().trim().min(1).max(4_000) }).safeParse(body);
      if (!parsed.success) return fail(400, "INVALID_INPUT", "Write a question first.");
      const view = await discussTask(options.store, taskId, parsed.data.question);
      if (!view) return fail(409, "NOT_READY", "Start explain-back before asking a question.");
      return ok({ explain: view });
    },

    skipExplainBack(taskId: string) {
      const view = skipExplain(options.store, taskId);
      if (!view) return fail(409, "NOT_READY", "There is no explain-back session to skip.");
      return ok({ explain: view });
    },
  };
}

export type ConnectorApi = ReturnType<typeof createConnector>;

interface ProjectView {
  id: string;
  path: string;
  name: string;
}

interface ProviderView {
  id: ProviderId;
  connected: boolean;
  login: string;
  message: string;
  capabilities: ReturnType<ReturnType<typeof providerFactory>["getCapabilities"]>;
  inference: string;
  repositoryExecution: string;
}

function projectView(project: ProjectView): ProjectView {
  return { id: project.id, path: project.path, name: project.name };
}

function present(result: { task?: ReturnType<typeof publicTask> }) {
  return { task: result.task ? presentTask(result.task) : null };
}

function conversationSnapshot(store: Store) {
  const project = store.latestProject();
  if (!project) return { task: null, earlier: [], conversations: [], selectedConversationId: null };
  store.ensureConversations(project.id);
  const selected = store.getProject(project.id)?.selected_conversation_id ?? null;
  const conversations = store.listConversations(project.id).map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updated_at,
  }));
  const head = selected ? store.conversationHead(selected) : undefined;
  if (!head) return { task: null, earlier: [], conversations, selectedConversationId: selected };
  const body = publicTask(store, head.id);
  if (!body) return { task: null, earlier: [], conversations, selectedConversationId: selected };
  return {
    task: presentTask(body),
    earlier: earlierTurns(store, head.id, selected),
    conversations,
    selectedConversationId: selected,
  };
}

function earlierTurns(store: Store, taskId: string, conversationId: string | null) {
  const turns = [];
  const seen = new Set<string>([taskId]);
  let cursor = store.getTask(taskId);
  while (cursor?.continues_task_id && turns.length < 100) {
    const previousId = cursor.continues_task_id;
    if (seen.has(previousId)) break;
    seen.add(previousId);
    const previous = store.getTask(previousId);
    if (!previous || (conversationId && previous.conversation_id !== conversationId)) break;
    const body = publicTask(store, previousId);
    if (!body) break;
    turns.push(presentTask(body));
    cursor = previous;
  }
  return turns.reverse();
}

function presentTask(task: NonNullable<ReturnType<typeof publicTask>>) {
  return {
    ...task,
    labels: task.decision
      ? {
          complexity: labelComplexity(task.decision.complexity),
          intensity: labelIntensity(task.decision.intensity),
        }
      : null,
  };
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function ok<T>(body: T, status = 200): ConnectorResult<T> {
  return { ok: true, status, body };
}

function fail(status: number, code: string, message: string): ConnectorResult<never> {
  return { ok: false, status, error: { code, message, retryable: code === "PROVIDER_UNAVAILABLE" } };
}
