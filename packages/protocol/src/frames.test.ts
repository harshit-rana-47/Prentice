import { PROVIDER_IDS } from "@prentice/domain";
import { describe, expect, it } from "vitest";
import { parseFrame } from "./frames";
import { frameFromHttp } from "./http-frame";
import { protocolRoutes } from "./methods";
import { protocolProviderIds, taskResponseSchema } from "./schemas";

describe("protocol frames", () => {
  it("names a frame for every current workspace route except the local health check", () => {
    expect(protocolRoutes.map((route) => route.path)).toEqual([
      "/v1/project",
      "/v1/projects",
      "/v1/project",
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
      "/v1/tasks/:id/understand",
      "/v1/tasks/:id/explain-back",
      "/v1/tasks/:id/explain-back/answer",
      "/v1/tasks/:id/explain-back/skip",
      "/v1/tasks/:id/explain-back/discuss",
      "/v1/tasks/:id/continue",
    ]);
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
    expect(frameFromHttp("GET", "/v1/workspace", null, "1")).toMatchObject({ method: "workspace.get" });
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
