import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { PROVIDER_IDS, labelComplexity, labelIntensity, type ProviderId } from "@prentice/domain";
import { authMiddleware } from "./auth.js";
import { AccountService, type Accounts } from "./accounts.js";
import { SecretStore } from "./secrets.js";
import {
  EventHub,
  analyzeTask,
  answerExplain,
  beginExplain,
  connectedProviders,
  interruptTask,
  publicTask,
  skipExplain,
  startTask,
} from "./session.js";
import { Store } from "./store.js";
import { isGitRepo } from "./git.js";
import { providerFactory } from "./providers.js";
import { readWorkspaceDiff, readWorkspaceFile, workspaceSnapshot } from "./workspace.js";
import { basename, resolve } from "node:path";

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

export interface AppOptions {
  store: Store;
  secrets: SecretStore;
  token: string;
  allowedOrigins: string[];
  hub?: EventHub;
  accounts?: Accounts;
}

export function createApp(options: AppOptions) {
  const hub = options.hub ?? new EventHub();
  const accounts = options.accounts ?? new AccountService(options.secrets);
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => (options.allowedOrigins.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type"],
      maxAge: 600,
    }),
  );
  app.use("*", authMiddleware(options.token, options.allowedOrigins));

  app.get("/health", (c) => c.json({ ok: true, bind: "127.0.0.1" }));

  app.get("/v1/project", (c) => {
    const project = options.store.latestProject();
    return c.json({ project: project ? { id: project.id, path: project.path, name: project.name } : null });
  });

  app.post("/v1/project", async (c) => {
    const parsed = openSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "INVALID_INPUT", "Provide an absolute path to a local repository.");
    const path = resolve(parsed.data.path);
    if (!(await isGitRepo(path))) {
      return error(c, 400, "GIT_REQUIRED", "That path is not a git repository. Prentice does not upload it anywhere.");
    }
    const project = options.store.upsertProject(path, basename(path));
    return c.json({ project: { id: project.id, path: project.path, name: project.name } });
  });

  app.get("/v1/workspace", async (c) => {
    const project = options.store.latestProject();
    if (!project) return error(c, 400, "PROJECT_REQUIRED", "Open a local git repository first.");
    const snapshot = await workspaceSnapshot(project.path);
    return c.json({ project: { id: project.id, path: project.path, name: project.name }, ...snapshot });
  });

  app.get("/v1/workspace/file", async (c) => {
    const project = options.store.latestProject();
    if (!project) return error(c, 400, "PROJECT_REQUIRED", "Open a local git repository first.");
    const requestPath = c.req.query("path") ?? "";
    try {
      return c.json(await readWorkspaceFile(project.path, requestPath));
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      if (code === "PATH_OUTSIDE") return error(c, 400, "PATH_OUTSIDE", "That path is outside the open repository.");
      return error(c, 404, "NOT_FOUND", "That file is not in the open repository.");
    }
  });

  app.get("/v1/workspace/diff", async (c) => {
    const project = options.store.latestProject();
    if (!project) return error(c, 400, "PROJECT_REQUIRED", "Open a local git repository first.");
    const requestPath = c.req.query("path") ?? "";
    try {
      return c.json(await readWorkspaceDiff(project.path, requestPath));
    } catch (reason) {
      const code = reason instanceof Error ? reason.message : "";
      if (code === "PATH_OUTSIDE") return error(c, 400, "PATH_OUTSIDE", "That path is outside the open repository.");
      return error(c, 404, "NOT_FOUND", "That diff is not available.");
    }
  });

  app.get("/v1/providers", async (c) => {
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
    return c.json({
      providers,
      pinned,
      active: connectedProviders(options.store, snapshot.accounts).map((item) => item.providerId),
    });
  });

  app.post("/v1/providers/:id/connect", async (c) => {
    const id = c.req.param("id");
    if (!isProviderId(id)) return error(c, 404, "NOT_FOUND", "Unknown provider.");
    if (id === "fixture") {
      return c.json({ ok: true, message: "The fixture provider is a local demo. It does not use an account." });
    }
    await accounts.connect(id);
    return c.json({ ok: true, login: "pending", message: "Opening the official sign-in page." }, 202);
  });

  app.delete("/v1/providers/:id", async (c) => {
    const id = c.req.param("id");
    if (!isProviderId(id) || id === "fixture") return error(c, 404, "NOT_FOUND", "Unknown provider.");
    await accounts.disconnect(id);
    options.store.setSetting(`connectedAt:${id}`, "");
    return c.json({ ok: true });
  });

  app.post("/v1/preferences/pin", async (c) => {
    const parsed = pinSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "INVALID_INPUT", "Pin a connected provider or clear the pin.");
    if (parsed.data.providerId) options.store.setSetting("pinnedProvider", parsed.data.providerId);
    else options.store.setSetting("pinnedProvider", "");
    return c.json({ pinned: parsed.data.providerId });
  });

  app.post("/v1/tasks/analyze", async (c) => {
    const parsed = analyzeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "INVALID_INPUT", "Write a task prompt.");
    const snapshot = await accounts.list();
    const result = await analyzeTask(options.store, snapshot.accounts, parsed.data.prompt);
    if ("error" in result && result.error) return c.json({ error: result.error }, 400);
    return c.json(present(result));
  });

  app.post("/v1/tasks/:id/start", async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "INVALID_INPUT", "Consent is required before a task starts.");
    const snapshot = await accounts.list();
    const result = await startTask(options.store, snapshot.accounts, hub, c.req.param("id"), parsed.data);
    if ("error" in result && result.error) return c.json({ error: result.error }, 400);
    return c.json(result, 202);
  });

  app.post("/v1/tasks/:id/interrupt", async (c) => {
    await interruptTask(c.req.param("id"));
    return c.json({ ok: true });
  });

  app.get("/v1/tasks/:id", (c) => {
    const task = publicTask(options.store, c.req.param("id"));
    if (!task) return error(c, 404, "NOT_FOUND", "Task not found.");
    return c.json({ task: presentTask(task) });
  });

  app.get("/v1/tasks/:id/events", (c) => {
    const taskId = c.req.param("id");
    if (!options.store.getTask(taskId)) return error(c, 404, "NOT_FOUND", "Task not found.");
    return streamSSE(c, async (stream) => {
      const seen = new Set<string>();
      const send = (event: { id: string }) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        const task = publicTask(options.store, taskId);
        if (!task) return;
        void stream.writeSSE({ event: "task", data: JSON.stringify(presentTask(task)) });
      };
      for (const event of options.store.listEvents(taskId)) send(event);
      const unsubscribe = hub.subscribe(taskId, (event) => send(event));
      const heartbeat = setInterval(() => {
        void stream.writeSSE({ event: "ping", data: "{}" });
      }, 15000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      await new Promise<void>((resolvePromise) => {
        stream.onAbort(() => resolvePromise());
      });
    });
  });

  app.get("/v1/tasks/:id/understand", (c) => {
    const task = publicTask(options.store, c.req.param("id"));
    if (!task) return error(c, 404, "NOT_FOUND", "Task not found.");
    return c.json({ understand: task.understand });
  });

  app.post("/v1/tasks/:id/explain-back", (c) => {
    const view = beginExplain(options.store, c.req.param("id"));
    if (!view) return error(c, 409, "NOT_READY", "The explanation is not ready yet.");
    return c.json({ explain: view });
  });

  app.post("/v1/tasks/:id/explain-back/answer", async (c) => {
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return error(c, 400, "INVALID_INPUT", "Write an answer first.");
    const view = answerExplain(options.store, c.req.param("id"), parsed.data.answer);
    if (!view) return error(c, 409, "NOT_READY", "Start explain-back before answering.");
    return c.json({ explain: view });
  });

  app.post("/v1/tasks/:id/explain-back/skip", (c) => {
    const view = skipExplain(options.store, c.req.param("id"));
    if (!view) return error(c, 409, "NOT_READY", "There is no explain-back session to skip.");
    return c.json({ explain: view });
  });

  return app;
}

function present(result: { task?: ReturnType<typeof publicTask>; decision?: unknown }) {
  return { task: result.task ? presentTask(result.task) : null };
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

function error(c: { json: (body: unknown, status: number) => Response }, status: number, code: string, message: string) {
  return c.json({ error: { code, message, retryable: code === "PROVIDER_UNAVAILABLE" } }, status);
}
