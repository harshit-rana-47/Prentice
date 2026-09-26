import { parseFrame, type Frame } from "./frames";

type RequestFrame = Extract<Frame, { kind: "request" }>;

/** Turns one current workspace HTTP call into the relay request the connector already understands. */
export function frameFromHttp(httpMethod: string, pathAndQuery: string, body: unknown, id: string): RequestFrame {
  const url = new URL(pathAndQuery, "http://prentice.local");
  const path = url.pathname;
  const json = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const queryPath = url.searchParams.get("path") ?? "";
  const frame = { kind: "request" as const, id, ...route(httpMethod.toUpperCase(), path, json, queryPath) };
  const parsed = parseFrame(frame);
  if (parsed.kind !== "request") throw new Error("The workspace call did not become a request frame.");
  return parsed;
}

function route(method: string, path: string, body: Record<string, unknown>, queryPath: string): { method: string; params?: unknown } {
  if (method === "GET" && path === "/v1/project") return { method: "project.current" };
  if (method === "POST" && path === "/v1/project") return { method: "project.open", params: { path: body.path } };
  if (method === "GET" && path === "/v1/workspace") return { method: "workspace.get" };
  if (method === "GET" && path === "/v1/workspace/file") return { method: "workspace.file", params: { path: queryPath } };
  if (method === "GET" && path === "/v1/workspace/diff") return { method: "workspace.diff", params: { path: queryPath } };
  if (method === "GET" && path === "/v1/providers") return { method: "providers.list" };
  if (method === "POST" && /^\/v1\/providers\/[^/]+\/connect$/.test(path)) {
    return { method: "providers.connect", params: { providerId: path.split("/")[3] } };
  }
  if (method === "DELETE" && /^\/v1\/providers\/[^/]+$/.test(path)) {
    return { method: "providers.disconnect", params: { providerId: path.split("/")[3] } };
  }
  if (method === "POST" && path === "/v1/preferences/pin") return { method: "preferences.pin", params: body };
  if (method === "POST" && path === "/v1/tasks/analyze") return { method: "tasks.analyze", params: { prompt: body.prompt } };
  if (method === "GET" && path === "/v1/tasks/latest") return { method: "tasks.latest" };
  const conversation = path.match(/^\/v1\/conversations\/([^/]+)\/select$/);
  if (method === "POST" && conversation) {
    return { method: "conversations.select", params: { conversationId: decodeURIComponent(conversation[1] ?? "") } };
  }
  const task = path.match(/^\/v1\/tasks\/([^/]+)(?:\/(.+))?$/);
  if (task) {
    const taskId = decodeURIComponent(task[1] ?? "");
    const action = task[2] ?? "";
    if (method === "POST" && action === "start") return { method: "tasks.start", params: { taskId, consent: body.consent, override: body.override } };
    if (method === "POST" && action === "interrupt") return { method: "tasks.interrupt", params: { taskId } };
    if (method === "GET" && action === "") return { method: "tasks.get", params: { taskId } };
    if (method === "GET" && action === "events") return { method: "tasks.events", params: { taskId } };
    if (method === "GET" && action === "understand") return { method: "tasks.understand", params: { taskId } };
    if (method === "POST" && action === "explain-back") return { method: "tasks.explainBack", params: { taskId } };
    if (method === "POST" && action === "explain-back/answer") return { method: "tasks.explainAnswer", params: { taskId, answer: body.answer } };
    if (method === "POST" && action === "explain-back/skip") return { method: "tasks.explainSkip", params: { taskId } };
    if (method === "POST" && action === "explain-back/discuss") return { method: "tasks.explainDiscuss", params: { taskId, question: body.question } };
    if (method === "POST" && action === "continue") return { method: "tasks.continue", params: { taskId, prompt: body.prompt, consent: body.consent } };
  }
  throw new Error(`There is no relay frame for ${method} ${path}.`);
}
