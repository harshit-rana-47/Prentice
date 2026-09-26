import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { authMiddleware } from "./auth.js";
import { createConnector, type ConnectorResult } from "./connector.js";
import { SecretStore } from "./secrets.js";
import { EventHub } from "./session.js";
import { Store } from "./store.js";
import type { Accounts } from "./accounts.js";

export interface AppOptions {
  store: Store;
  secrets: SecretStore;
  token: string;
  allowedOrigins: string[];
  hub?: EventHub;
  accounts?: Accounts;
}

export function createApp(options: AppOptions) {
  const connector = createConnector(options);
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

  app.get("/v1/project", (c) => respond(c, connector.currentProject()));

  app.get("/v1/projects", (c) => respond(c, connector.projects()));

  app.post("/v1/project", async (c) => respond(c, await connector.openProject(await readJson(c))));

  app.get("/v1/workspace", async (c) => respond(c, await connector.workspace()));

  app.get("/v1/workspace/file", async (c) => respond(c, await connector.workspaceFile(c.req.query("path") ?? "")));

  app.get("/v1/workspace/diff", async (c) => respond(c, await connector.workspaceDiff(c.req.query("path") ?? "")));

  app.get("/v1/providers", async (c) => respond(c, await connector.providers()));

  app.post("/v1/providers/:id/connect", async (c) => respond(c, await connector.connectProvider(c.req.param("id"))));

  app.delete("/v1/providers/:id", async (c) => respond(c, await connector.disconnectProvider(c.req.param("id"))));

  app.post("/v1/preferences/pin", async (c) => respond(c, await connector.pinProvider(await readJson(c))));

  app.post("/v1/tasks/analyze", async (c) => respond(c, await connector.analyze(await readJson(c))));

  app.get("/v1/tasks/latest", (c) => respond(c, connector.latestTask()));

  app.post("/v1/conversations/:id/select", (c) => respond(c, connector.selectConversation(c.req.param("id"))));

  app.post("/v1/tasks/:id/start", async (c) => respond(c, await connector.start(c.req.param("id"), await readJson(c))));

  app.post("/v1/tasks/:id/interrupt", async (c) => respond(c, await connector.interrupt(c.req.param("id"))));

  app.get("/v1/tasks/:id", (c) => respond(c, connector.task(c.req.param("id"))));

  app.get("/v1/tasks/:id/events", (c) => {
    const opened = connector.watchTask(c.req.param("id"));
    if (!opened.ok) return respond(c, opened);
    const source = opened.body;
    return streamSSE(c, async (stream) => {
      const seen = new Set<string>();
      const send = (event: { id: string }) => {
        if (seen.has(event.id)) return;
        seen.add(event.id);
        const task = source.presented();
        if (!task) return;
        void stream.writeSSE({ event: "task", data: JSON.stringify(task) });
      };
      for (const event of source.replay()) send(event);
      const unsubscribe = source.subscribe((event) => send(event));
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

  app.get("/v1/tasks/:id/understand", (c) => respond(c, connector.understand(c.req.param("id"))));

  app.post("/v1/tasks/:id/explain-back", async (c) => respond(c, await connector.explainBack(c.req.param("id"))));

  app.post("/v1/tasks/:id/explain-back/answer", async (c) =>
    respond(c, await connector.answerExplainBack(c.req.param("id"), await readJson(c))),
  );

  app.post("/v1/tasks/:id/explain-back/discuss", async (c) =>
    respond(c, await connector.discussExplainBack(c.req.param("id"), await readJson(c))),
  );

  app.post("/v1/tasks/:id/continue", async (c) => respond(c, await connector.continueTask(c.req.param("id"), await readJson(c))));

  app.post("/v1/tasks/:id/explain-back/skip", (c) => respond(c, connector.skipExplainBack(c.req.param("id"))));

  return app;
}

async function readJson(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}

function respond(c: { json: (body: unknown, status?: number) => Response }, result: ConnectorResult<unknown>) {
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json(result.body, result.status);
}
