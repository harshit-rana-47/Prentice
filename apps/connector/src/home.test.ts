import { describe, expect, it } from "vitest";
import { frameFromHttp, parseFrame } from "@prentice/protocol";
import { migrate, openDatabase } from "./db.js";
import { Store } from "./store.js";
import { createConnector } from "./connector.js";
import { dispatchRequest } from "./dispatch.js";
import { homeSnapshot } from "./home.js";
import { createApp } from "./server.js";

function setup() {
  const db = openDatabase(":memory:"); migrate(db); const store = new Store(db);
  const project = store.upsertProject("/disposable/journal-test", "Journal test");
  const conversation = store.insertConversation(project.id, "Session refresh");
  const task = store.insertTask(project.id, "Fix the expiry boundary", conversation.id);
  store.updateTask(task.id, { status: "completed", provider_id: "claude-code", finished_at: "2026-10-09T12:00:00.000Z" });
  const connector = createConnector({ store });
  return { db, store, project, conversation, task, connector };
}

describe("local Home journal", () => {
  it("uses recorded failures, excludes auth errors, and never invents resolution or understanding", () => {
    const { store, task } = setup();
    store.appendEvent(task.id, { type: "session.failed", code: "AGENT_SIGNED_OUT", message: "Sign in", retryable: false });
    expect(homeSnapshot(store, { query: "", offset: 0 }).entries[0]?.debug).toEqual([]);
    store.appendEvent(task.id, { type: "command.finished", command: "npm test", exitCode: 1 });
    const result = homeSnapshot(store, { query: "", offset: 0 });
    expect(result.entries[0]).toMatchObject({ status: "completed", understood: [], explored: [], debug: [{ symptom: "Command failed", evidence: "npm test" }] });
    expect(result.entries[0]?.debug[0]).not.toHaveProperty("resolved");
    expect(result.calendar).toEqual([{ day: "2026-10-09", tasks: 1, learning: 0, debug: 1 }]);
  });
  it("searches and filters before pagination, including older Debug records", () => {
    const { store, project, task } = setup();
    store.appendEvent(task.id, { type: "command.finished", command: "unique-failure-marker", exitCode: 1 });
    for (let i = 0; i < 55; i++) {
      const conversation = store.insertConversation(project.id, `Later conversation ${i}`);
      const next = store.insertTask(project.id, "Later work", conversation.id);
      store.updateTask(next.id, { status: "completed", finished_at: "2026-10-10T12:00:00.000Z" });
    }
    expect(homeSnapshot(store, { query: "", offset: 0 }).entries).toHaveLength(50);
    expect(homeSnapshot(store, { query: "", offset: 50 }).entries).toHaveLength(6);
    expect(homeSnapshot(store, { query: "unique-failure-marker", offset: 0 }).entries.map(entry => entry.id)).toEqual([task.id]);
    expect(homeSnapshot(store, { query: "", category: "debug", offset: 0 }).entries.map(entry => entry.id)).toEqual([task.id]);
    expect(homeSnapshot(store, { query: "", day: "2026-10-09", offset: 0 }).total).toBe(1);
  });
  it("pins persist and invalid objects or malformed input cannot create pins", async () => {
    const { store, connector, project, conversation } = setup();
    expect(connector.pinHome({ kind: "project", id: "missing", pinned: true }).ok).toBe(false);
    expect(connector.pinHome({ kind: "agent", id: project.id, pinned: true }).ok).toBe(false);
    const frame = frameFromHttp("POST", "/v1/home/pin", { kind: "conversation", id: conversation.id, pinned: true }, "pin");
    expect((await dispatchRequest(connector, frame)).kind).toBe("response");
    expect(homeSnapshot(store, { query: "", offset: 0 }).pins).toEqual([`conversation:${conversation.id}`]);
    const recreated = createConnector({ store });
    recreated.pinHome({ kind: "conversation", id: conversation.id, pinned: false });
    expect(homeSnapshot(store, { query: "", offset: 0 }).pins).toEqual([]);
  });
  it("reading Home does not change visit state, task status, selection, or start an agent", () => {
    const { store, connector, project, task } = setup();
    store.ensureConversations(project.id);
    const selection = store.getProject(project.id)?.selected_conversation_id;
    store.setSetting("home.lastVisit", "2026-10-08T00:00:00.000Z");
    const result = homeSnapshot(store, { query: "", offset: 0 });
    expect(result.since).toEqual({ completed: 1, interrupted: 0 });
    expect(store.getSetting("home.lastVisit")).toBe("2026-10-08T00:00:00.000Z");
    expect(store.getTask(task.id)?.status).toBe("completed");
    expect(store.getProject(project.id)?.selected_conversation_id).toBe(selection);
    connector.visitHome();
    expect(store.getSetting("home.lastVisit")).not.toBe("2026-10-08T00:00:00.000Z");
  });
  it("keeps interrupted work partial, distinct from Debug", () => {
    const { store, task } = setup();
    store.updateTask(task.id, { status: "interrupted", error_code: "SESSION_ENDED" });
    const result = homeSnapshot(store, { query: "", category: "interrupted", offset: 0 });
    expect(result.entries[0]).toMatchObject({ status: "interrupted", observed: [], debug: [] });
    expect(result.attention[0]?.id).toBe(task.id);
  });
  it("includes real tool failures alongside failed commands in Debug search", () => {
    const { store, task } = setup();
    store.appendEvent(task.id, { type: "tool.finished", name: "terminal", title: "Lint failed", ok: false, detail: "eslint exited 1" });
    const result = homeSnapshot(store, { query: "Lint failed", category: "debug", offset: 0 });
    expect(result.entries[0]?.debug).toEqual([{ symptom: "Lint failed", evidence: "eslint exited 1" }]);
  });
  it("authenticates local Home routes and scrubs summaries on local and relay paths", async () => {
    const { store, connector, task } = setup();
    store.appendEvent(task.id, { type: "command.finished", command: "curl -H 'Authorization: Bearer secret-token-example' https://example.invalid", exitCode: 1 });
    const app = createApp({ store, token: "test-token", allowedOrigins: ["http://localhost:3000"] });
    expect((await app.request("/v1/home", { method: "POST", body: "{}" })).status).toBe(401);
    const response = await app.request("/v1/home", { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain("secret-token-example");
    const frame = frameFromHttp("POST", "/v1/home", {}, "home");
    expect(JSON.stringify(await dispatchRequest(connector, frame))).not.toContain("secret-token-example");
    expect(() => parseFrame({ kind: "request", id: "bad", method: "home.get", params: { offset: -1 } })).toThrow();
  });
});

it('does not rewrite migrated conversations on each journal read, but repairs legacy and split chains', () => {
  const { db, store, project, conversation, task } = setup();
  store.selectConversation(project.id, conversation.id);
  store.touchConversation(conversation.id, '2030-01-01T00:00:00.000Z');
  homeSnapshot(store, { query: '', offset: 0 });
  expect(store.getConversation(conversation.id)?.updated_at).toBe('2030-01-01T00:00:00.000Z');
  const legacy = store.insertTask(project.id, 'Legacy chain');
  store.updateTask(legacy.id, { status: 'completed' });
  homeSnapshot(store, { query: '', offset: 0 });
  expect(store.getTask(legacy.id)?.conversation_id).toBeTruthy();
  const split = store.insertConversation(project.id, 'Wrong branch');
  const child = store.insertTask(project.id, 'Continuation', split.id);
  store.updateTask(child.id, { status: 'completed', continues_task_id: task.id });
  store.ensureConversations(project.id);
  expect(store.getTask(child.id)?.conversation_id).toBe(conversation.id);
  expect(store.getProject(project.id)?.selected_conversation_id).toBe(conversation.id);
  db.run('UPDATE projects SET selected_conversation_id = NULL WHERE id = ?', [project.id]);
  store.ensureConversations(project.id);
  expect(store.getProject(project.id)?.selected_conversation_id).toBeTruthy();
  const draft = store.insertTask(project.id, 'Unsent draft');
  store.ensureConversations(project.id);
  expect(store.getTask(draft.id)?.conversation_id).toBeNull();
});
