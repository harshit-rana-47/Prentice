import { randomUUID } from "node:crypto";
import type { ExplainSessionState, EvidencePacket, NormalizedEvent, RoutingDecision, UnderstandArtifact } from "@prentice/domain";
import type { Sql } from "./db.js";

export interface ProjectRow {
  id: string;
  path: string;
  name: string;
  opened_at: string;
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
}

export interface StoredEvent {
  id: string;
  seq: number;
  event: NormalizedEvent;
}

export class Store {
  constructor(private readonly db: Sql) {}

  upsertProject(path: string, name: string): ProjectRow {
    const existing = this.db.get<ProjectRow>("SELECT * FROM projects WHERE path = ?", [path]);
    if (existing) return existing;
    const row: ProjectRow = { id: randomUUID(), path, name, opened_at: new Date().toISOString() };
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

  getProject(id: string): ProjectRow | undefined {
    return this.db.get<ProjectRow>("SELECT * FROM projects WHERE id = ?", [id]);
  }

  insertTask(projectId: string, prompt: string): TaskRow {
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
    };
    this.db.run(
      `INSERT INTO tasks (
        id, project_id, prompt, status, created_at, started_at, finished_at,
        error_code, error_message, consent, base_commit, provider_id
      ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, NULL, NULL)`,
      [row.id, row.project_id, row.prompt, row.status, row.created_at],
    );
    return row;
  }

  getTask(id: string): TaskRow | undefined {
    return this.db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", [id]);
  }

  listTasks(projectId: string): TaskRow[] {
    return this.db.all<TaskRow>("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC", [projectId]);
  }

  updateTask(id: string, patch: Partial<TaskRow>): void {
    const current = this.getTask(id);
    if (!current) return;
    const next = { ...current, ...patch, id: current.id };
    this.db.run(
      `UPDATE tasks SET status = ?, started_at = ?, finished_at = ?, error_code = ?, error_message = ?,
        consent = ?, base_commit = ?, provider_id = ? WHERE id = ?`,
      [
        next.status,
        next.started_at,
        next.finished_at,
        next.error_code,
        next.error_message,
        next.consent,
        next.base_commit,
        next.provider_id,
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
