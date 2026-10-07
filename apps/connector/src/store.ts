import { randomUUID } from "node:crypto";
import type { ExplainSessionState, EvidencePacket, NormalizedEvent, RoutingDecision, UnderstandArtifact } from "@prentice/domain";
import type { Sql } from "./db.js";

export interface ProjectRow {
  id: string;
  path: string;
  name: string;
  opened_at: string;
  selected_conversation_id: string | null;
}

export interface ConversationRow {
  id: string;
  project_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

/** The first line of the first prompt, kept short enough for a conversation list. */
export function conversationTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  if (line.length <= 80) return line;
  return `${line.slice(0, 79)}…`;
}

export interface TaskRow {
  id: string;
  project_id: string;
  prompt: string;
  status: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error_code: string | null;
  error_message: string | null;
  consent: number;
  base_commit: string | null;
  provider_id: string | null;
  provider_session_id: string | null;
  continues_task_id: string | null;
  conversation_id: string | null;
}

export interface StoredEvent {
  id: string;
  seq: number;
  event: NormalizedEvent;
}

export class Store {
  constructor(private readonly db: Sql) {}

  upsertProject(path: string, name: string): ProjectRow {
    const openedAt = new Date().toISOString();
    const existing = this.db.get<ProjectRow>("SELECT * FROM projects WHERE path = ?", [path]);
    if (existing) {
      this.db.run("UPDATE projects SET name = ?, opened_at = ? WHERE id = ?", [name, openedAt, existing.id]);
      return { ...existing, name, opened_at: openedAt };
    }
    const row: ProjectRow = { id: randomUUID(), path, name, opened_at: openedAt, selected_conversation_id: null };
    this.db.run("INSERT INTO projects (id, path, name, opened_at) VALUES (?, ?, ?, ?)", [
      row.id,
      row.path,
      row.name,
      row.opened_at,
    ]);
    return row;
  }

  latestProject(): ProjectRow | undefined {
    return this.db.get<ProjectRow>("SELECT * FROM projects ORDER BY opened_at DESC LIMIT 1");
  }

  listProjects(): ProjectRow[] {
    return this.db.all<ProjectRow>("SELECT * FROM projects ORDER BY opened_at DESC");
  }

  /**
   * Opens the canonical path and folds any earlier rows for that same directory into one project.
   * Tasks stay attached to the surviving project id.
   */
  reopenProject(path: string, name: string, aliasIds: string[]): ProjectRow {
    const openedAt = new Date().toISOString();
    const aliases = [...new Set(aliasIds)]
      .map((id) => this.getProject(id))
      .filter((row): row is ProjectRow => row !== undefined);
    const primary = aliases.find((row) => row.path === path) ?? aliases[0];
    const others = aliases.filter((row) => row.id !== primary?.id);
    this.db.exec("BEGIN");
    try {
      let row: ProjectRow;
      if (!primary) {
        row = { id: randomUUID(), path, name, opened_at: openedAt, selected_conversation_id: null };
        this.db.run("INSERT INTO projects (id, path, name, opened_at) VALUES (?, ?, ?, ?)", [
          row.id,
          row.path,
          row.name,
          row.opened_at,
        ]);
      } else {
        for (const other of others) {
          this.db.run("UPDATE tasks SET project_id = ? WHERE project_id = ?", [primary.id, other.id]);
          this.db.run("UPDATE conversations SET project_id = ? WHERE project_id = ?", [primary.id, other.id]);
          this.db.run(
            `INSERT INTO understood_concepts (project_id, concept, demonstrated_at)
             SELECT ?, concept, demonstrated_at FROM understood_concepts WHERE project_id = ?
             ON CONFLICT(project_id, concept) DO UPDATE SET demonstrated_at = excluded.demonstrated_at`,
            [primary.id, other.id],
          );
          this.db.run("DELETE FROM understood_concepts WHERE project_id = ?", [other.id]);
          this.db.run("DELETE FROM projects WHERE id = ?", [other.id]);
        }
        this.db.run("UPDATE projects SET path = ?, name = ?, opened_at = ? WHERE id = ?", [path, name, openedAt, primary.id]);
        row = { ...primary, path, name, opened_at: openedAt };
      }
      this.db.exec("COMMIT");
      return row;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
  }

  insertTask(projectId: string, prompt: string, conversationId: string | null = null): TaskRow {
    const row: TaskRow = {
      id: randomUUID(),
      project_id: projectId,
      prompt,
      status: "analyzed",
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      error_code: null,
      error_message: null,
      consent: 0,
      base_commit: null,
      provider_id: null,
      provider_session_id: null,
      continues_task_id: null,
      conversation_id: conversationId,
    };
    this.db.run(
      `INSERT INTO tasks (
        id, project_id, prompt, status, created_at, started_at, finished_at,
        error_code, error_message, consent, base_commit, provider_id, conversation_id
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?)`,
      [row.id, row.project_id, row.prompt, row.status, row.created_at, row.conversation_id],
    );
    return row;
  }

  insertConversation(projectId: string, title: string): ConversationRow {
    const now = new Date().toISOString();
    const row: ConversationRow = {
      id: randomUUID(),
      project_id: projectId,
      title,
      created_at: now,
      updated_at: now,
    };
    this.db.run(
      "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [row.id, row.project_id, row.title, row.created_at, row.updated_at],
    );
    return row;
  }

  getConversation(id: string): ConversationRow | undefined {
    return this.db.get<ConversationRow>("SELECT * FROM conversations WHERE id = ?", [id]);
  }

  listConversations(projectId: string): ConversationRow[] {
    return this.db.all<ConversationRow>(
      "SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC, rowid DESC",
      [projectId],
    );
  }

  conversationHead(conversationId: string): TaskRow | undefined {
    return this.db.get<TaskRow>(
      "SELECT * FROM tasks WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      [conversationId],
    );
  }

  selectConversation(projectId: string, conversationId: string): void {
    this.db.run("UPDATE projects SET selected_conversation_id = ? WHERE id = ?", [conversationId, projectId]);
  }

  touchConversation(conversationId: string, at = new Date().toISOString()): void {
    this.db.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [at, conversationId]);
  }

  /**
   * Older databases stored only task chains. Each chain becomes one conversation,
   * titled by its first prompt. A chain keeps a conversation it already has.
   * The newest chain stays selected when the project has no selection.
   */
  ensureConversations(projectId: string): void {
    const project = this.getProject(projectId);
    if (!project) return;
    // A task that never started has no conversation. It must not become an empty chat on its own.
    // An older chain root is kept when later turns continue it.
    const all = this.listTasks(projectId);
    const continued = new Set(all.flatMap((task) => (task.continues_task_id ? [task.continues_task_id] : [])));
    const tasks = all.filter((task) => task.conversation_id || task.status !== "analyzed" || continued.has(task.id));
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const children = new Map<string, TaskRow[]>();
    for (const task of tasks) {
      if (!task.continues_task_id || !byId.has(task.continues_task_id)) continue;
      const list = children.get(task.continues_task_id) ?? [];
      list.push(task);
      children.set(task.continues_task_id, list);
    }
    const seen = new Set<string>();
    for (const task of tasks) {
      if (seen.has(task.id)) continue;
      const component: TaskRow[] = [];
      const stack = [chainRoot(task, byId)];
      while (stack.length > 0) {
        const current = stack.pop();
        if (!current || seen.has(current.id)) continue;
        seen.add(current.id);
        component.push(current);
        stack.push(...(children.get(current.id) ?? []));
      }
      const root = component.find((item) => !item.continues_task_id || !byId.has(item.continues_task_id)) ?? component[0];
      if (!root) continue;
      const existing = [...new Set(component.flatMap((item) => (item.conversation_id ? [item.conversation_id] : [])))]
        .map((id) => this.getConversation(id))
        .filter((row): row is ConversationRow => row !== undefined)
        .sort((left, right) => left.created_at.localeCompare(right.created_at));
      const preferred = existing.find((row) => row.id === project.selected_conversation_id);
      let conversationId = preferred?.id ?? existing[0]?.id;
      if (!conversationId) {
        conversationId = this.insertConversation(projectId, conversationTitle(root.prompt)).id;
      }
      let latest = root.created_at;
      for (const member of component) {
        if (member.conversation_id !== conversationId) this.updateTask(member.id, { conversation_id: conversationId });
        if (member.created_at > latest) latest = member.created_at;
      }
      this.touchConversation(conversationId, latest);
    }
    this.db.run(
      `DELETE FROM conversations WHERE project_id = ? AND id NOT IN (
        SELECT conversation_id FROM tasks WHERE conversation_id IS NOT NULL
      )`,
      [projectId],
    );
    const selected = this.getProject(projectId)?.selected_conversation_id;
    const selectedRow = selected ? this.getConversation(selected) : undefined;
    if (selectedRow?.project_id === projectId) return;
    const newest = this.listConversations(projectId)[0];
    if (newest) this.selectConversation(projectId, newest.id);
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  }

  listTasks(projectId: string): TaskRow[] {
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC, rowid DESC", [projectId]);
  }

  updateTask(id: string, patch: Partial<TaskRow>): void {
    const current = this.getTask(id);
    if (!current) return;
    const next = { ...current, ...patch, id: current.id };
    this.db.run(
      `UPDATE tasks SET status = ?, started_at = ?, finished_at = ?, error_code = ?, error_message = ?,
        consent = ?, base_commit = ?, provider_id = ?, provider_session_id = ?, continues_task_id = ?, conversation_id = ? WHERE id = ?`,
      [
        next.status,
        next.started_at,
        next.finished_at,
        next.error_code,
        next.error_message,
        next.consent,
        next.base_commit,
        next.provider_id,
        next.provider_session_id,
        next.continues_task_id,
        next.conversation_id,
        id,
      ],
    );
  }

  saveDecision(taskId: string, decision: RoutingDecision): void {
    this.db.run(
      `INSERT INTO routing_decisions (task_id, decision_json, created_at) VALUES (?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET decision_json = excluded.decision_json, created_at = excluded.created_at`,
      [taskId, JSON.stringify(decision), new Date().toISOString()],
    );
  }

  getDecision(taskId: string): RoutingDecision | undefined {
    const row = this.db.get<{ decision_json: string }>("SELECT decision_json FROM routing_decisions WHERE task_id = ?", [
      taskId,
    ]);
    return row ? (JSON.parse(row.decision_json) as RoutingDecision) : undefined;
  }

  appendEvent(taskId: string, event: NormalizedEvent): StoredEvent {
    const last = this.db.get<{ seq: number }>("SELECT seq FROM activity_events WHERE task_id = ? ORDER BY seq DESC LIMIT 1", [
      taskId,
    ]);
    const stored: StoredEvent = { id: randomUUID(), seq: (last?.seq ?? 0) + 1, event: { ...event, id: undefined } };
    this.db.run("INSERT INTO activity_events (id, task_id, seq, event_json) VALUES (?, ?, ?, ?)", [
      stored.id,
      taskId,
      stored.seq,
      JSON.stringify(stored.event),
    ]);
    return stored;
  }

  listEvents(taskId: string): StoredEvent[] {
    const rows = this.db.all<{ id: string; seq: number; event_json: string }>(
      "SELECT id, seq, event_json FROM activity_events WHERE task_id = ? ORDER BY seq ASC",
      [taskId],
    );
    return rows.map((row) => ({ id: row.id, seq: row.seq, event: JSON.parse(row.event_json) as NormalizedEvent }));
  }

  savePacket(taskId: string, packet: EvidencePacket): void {
    this.db.run(
      `INSERT INTO evidence_packets (task_id, packet_json) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET packet_json = excluded.packet_json`,
      [taskId, JSON.stringify(packet)],
    );
  }

  getPacket(taskId: string): EvidencePacket | undefined {
    const row = this.db.get<{ packet_json: string }>("SELECT packet_json FROM evidence_packets WHERE task_id = ?", [taskId]);
    return row ? (JSON.parse(row.packet_json) as EvidencePacket) : undefined;
  }

  saveUnderstand(taskId: string, artifact: UnderstandArtifact): void {
    this.db.run(
      `INSERT INTO understand_artifacts (task_id, artifact_json) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET artifact_json = excluded.artifact_json`,
      [taskId, JSON.stringify(artifact)],
    );
  }

  getUnderstand(taskId: string): UnderstandArtifact | undefined {
    const row = this.db.get<{ artifact_json: string }>(
      "SELECT artifact_json FROM understand_artifacts WHERE task_id = ?",
      [taskId],
    );
    return row ? (JSON.parse(row.artifact_json) as UnderstandArtifact) : undefined;
  }

  saveExplain(taskId: string, state: ExplainSessionState): void {
    this.db.run(
      `INSERT INTO explain_sessions (task_id, state_json) VALUES (?, ?)
       ON CONFLICT(task_id) DO UPDATE SET state_json = excluded.state_json`,
      [taskId, JSON.stringify(state)],
    );
  }

  getExplain(taskId: string): ExplainSessionState | undefined {
    const row = this.db.get<{ state_json: string }>("SELECT state_json FROM explain_sessions WHERE task_id = ?", [taskId]);
    return row ? (JSON.parse(row.state_json) as ExplainSessionState) : undefined;
  }

  recordTelemetry(taskId: string, payload: Record<string, unknown>): void {
    this.db.run("INSERT INTO telemetry (id, task_id, payload_json, created_at) VALUES (?, ?, ?, ?)", [
      randomUUID(),
      taskId,
      JSON.stringify(payload),
      new Date().toISOString(),
    ]);
  }

  telemetryCount(): number {
    const row = this.db.get<{ count: number }>("SELECT COUNT(*) AS count FROM telemetry");
    return row?.count ?? 0;
  }

  demonstratedConcepts(projectId: string): string[] {
    return this.db
      .all<{ concept: string }>("SELECT concept FROM understood_concepts WHERE project_id = ? ORDER BY demonstrated_at", [
        projectId,
      ])
      .map((row) => row.concept);
  }

  demonstrate(projectId: string, concept: string): void {
    this.db.run(
      `INSERT INTO understood_concepts (project_id, concept, demonstrated_at) VALUES (?, ?, ?)
       ON CONFLICT(project_id, concept) DO UPDATE SET demonstrated_at = excluded.demonstrated_at`,
      [projectId, concept, new Date().toISOString()],
    );
  }

  getSetting(key: string): string | undefined {
    return this.db.get<{ value: string }>("SELECT value FROM settings WHERE key = ?", [key])?.value;
  }

  setSetting(key: string, value: string): void {
    this.db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }
}

function chainRoot(task: TaskRow, byId: Map<string, TaskRow>): TaskRow {
  let cursor = task;
  const seen = new Set<string>();
  while (cursor.continues_task_id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const previous = byId.get(cursor.continues_task_id);
    if (!previous || previous.project_id !== cursor.project_id) break;
    cursor = previous;
  }
  return cursor;
}
