import { PROVIDER_IDS } from "@prentice/domain";
import { describe, expect, it } from "vitest";
import { parseFrame } from "./frames";
import { frameFromHttp } from "./http-frame";
import { protocolRoutes } from "./methods";
import { protocolProviderIds, taskResponseSchema } from "./schemas";

describe("protocol frames", () => {
  it("names a frame for every current workspace route except the local health check", () => {
    expect(protocolRoutes.map((route) => route.path)).toEqual([
      "/v1/home",
      "/v1/home/visit",
      "/v1/home/pin",
      "/v1/project",
      "/v1/projects",
      "/v1/project",
      "/v1/project/choose",
      "/v1/workspace",
      "/v1/workspace/file",
      "/v1/workspace/diff",
      "/v1/providers",
      "/v1/providers/:id/connect",
      "/v1/providers/:id",
      "/v1/preferences/pin",
      "/v1/tasks/analyze",
      "/v1/tasks/latest",
      "/v1/conversations/:id/select",
      "/v1/tasks/:id/start",
      "/v1/tasks/:id/interrupt",
      "/v1/tasks/:id",
      "/v1/tasks/:id/events",
      "/v1/tasks/:id/events",
      "/v1/tasks/:id/understand",
      "/v1/tasks/:id/explain-back",
      "/v1/tasks/:id/explain-back/answer",
      "/v1/tasks/:id/explain-back/skip",
      "/v1/tasks/:id/explain-back/discuss",
      "/v1/tasks/:id/continue",
    ]);
  });

  it("parses presence and keepalive frames and maps unwatch to a request", () => {
    expect(parseFrame({ kind: "presence", online: false })).toEqual({ kind: "presence", online: false });
    expect(parseFrame({ kind: "ping" })).toEqual({ kind: "ping" });
    expect(frameFromHttp("DELETE", "/v1/tasks/t1/events", null, "r1")).toMatchObject({ method: "tasks.unwatch", params: { taskId: "t1" } });
  });

  it("parses a request, a result, and a task event", () => {
    expect(parseFrame({ kind: "request", id: "1", method: "project.current" }).kind).toBe("request");
    expect(parseFrame({ kind: "auth", role: "connector", token: "device-token" })).toMatchObject({ role: "connector" });
    expect(parseFrame({ kind: "auth", role: "browser", token: "session-token", deviceId: "device-1" })).toMatchObject({
      role: "browser",
    });
    expect(
      parseFrame({
        kind: "request",
        id: "2",
        method: "tasks.analyze",
        params: { prompt: "Add a note" },
      }),
    ).toMatchObject({ method: "tasks.analyze" });
    expect(
      parseFrame({
        kind: "response",
        id: "2",
        ok: false,
        status: 400,
        error: { code: "INVALID_INPUT", message: "Write a task prompt.", retryable: false },
      }),
    ).toMatchObject({ ok: false });
    const event = parseFrame({ kind: "event", method: "tasks.events", taskId: "task-1", event: "ping", data: {} });
    expect(event.kind === "event" && event.event).toBe("ping");
  });

  it("rejects a prompt the runtime would reject", () => {
    expect(() => parseFrame({ kind: "request", id: "3", method: "tasks.analyze", params: { prompt: "  " } })).toThrow();
  });

  it("accepts the task payload shape the workspace already reads", () => {
    const parsed = taskResponseSchema.parse({
      task: {
        id: "task-1",
        prompt: "Add a note",
        status: "completed",
        providerId: "fixture",
        error: null,
        decision: null,
        labels: null,
        timeline: [{ id: "e1", title: "Session completed", tone: "ok" }],
        understand: null,
        explain: null,
        issues: [],
      },
    });
    expect(parsed.task?.status).toBe("completed");
  });

  it("keeps provider ids aligned with the domain package", () => {
    expect([...protocolProviderIds]).toEqual([...PROVIDER_IDS]);
  });

  it("turns the workspace HTTP calls into relay requests", () => {
    expect(frameFromHttp("POST", "/v1/home", { query: "failure", category: "debug", offset: 50 }, "home")).toMatchObject({
      method: "home.get", params: { query: "failure", category: "debug", offset: 50 },
    });
    expect(frameFromHttp("POST", "/v1/home/pin", { kind: "project", id: "p1", pinned: true }, "pin")).toMatchObject({
      method: "home.pin", params: { kind: "project", id: "p1", pinned: true },
    });
    expect(frameFromHttp("GET", "/v1/workspace", null, "1")).toMatchObject({ method: "workspace.get" });
    expect(frameFromHttp("POST", "/v1/project/choose", null, "5")).toMatchObject({ method: "project.choose" });
    expect(frameFromHttp("POST", "/v1/project", { path: "/repo" }, "2")).toMatchObject({
      method: "project.open",
      params: { path: "/repo" },
    });
    expect(frameFromHttp("GET", "/v1/workspace/file?path=src%2Fapp.ts", null, "3")).toMatchObject({
      method: "workspace.file",
      params: { path: "src/app.ts" },
    });
    expect(frameFromHttp("POST", "/v1/tasks/task-1/explain-back/answer", { answer: "It added a file." }, "4")).toMatchObject({
      method: "tasks.explainAnswer",
      params: { taskId: "task-1", answer: "It added a file." },
    });
  });
});

it("preserves explicit active-file context through local HTTP to relay conversion", async () => {
  const { frameFromHttp } = await import("./http-frame.js");
  const start = frameFromHttp("POST", "/v1/tasks/t/start", { consent: true, activeFile: "index.html", override: { providerId: "claude-code" } }, "r1");
  expect(start).toMatchObject({ method: "tasks.start", params: { activeFile: "index.html", override: { providerId: "claude-code" } } });
  const followup = frameFromHttp("POST", "/v1/tasks/t/continue", { prompt: "keep going", consent: true, activeFile: "auth.js" }, "r2");
  expect(followup).toMatchObject({ method: "tasks.continue", params: { prompt: "keep going", activeFile: "auth.js" } });
});

it("preserves learning message identity and explicit next actions across the relay", () => {
  expect(frameFromHttp("POST", "/v1/tasks/task-1/explain-back/answer", {answer:"Move on",messageId:"learning-1",action:"next"}, "r")).toMatchObject({params:{answer:"Move on",messageId:"learning-1",action:"next"}});
  expect(frameFromHttp("POST", "/v1/tasks/task-1/explain-back/discuss", {question:"Why?",messageId:"learning-2"}, "r2")).toMatchObject({params:{question:"Why?",messageId:"learning-2"}});
});

it.each(['next','practice','revisit','finish','skip'] as const)('preserves the %s learning choice over HTTP and relay',action=>{
 const request=frameFromHttp('POST','/v1/tasks/task-1/explain-back/answer',{answer:'My learning choice',messageId:'choice-1',action,questionId:'q-1'},'rpc-1');
 expect(request).toMatchObject({method:'tasks.explainAnswer',params:{taskId:'task-1',messageId:'choice-1',action,questionId:'q-1'}});
 expect(parseFrame(request)).toMatchObject({params:{action,questionId:'q-1'}});
});
