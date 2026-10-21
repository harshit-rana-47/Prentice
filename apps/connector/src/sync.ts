import { redactCredentials } from "@prentice/domain";
import { syncPayloadSchema, type SyncPayload } from "@prentice/protocol";
import type { Store } from "./store.js";

function label(value: string): string | null {
  const safe = redactCredentials(value).replace(/[\r\n\\/]/g, " ").trim().slice(0, 160);
  return safe && !safe.includes("://") ? safe : null;
}

/** Only explicit scalar fields are built here; no Home snapshot, prompt, event or evidence JSON is serialized. */
export function summaryForSync(store: Store): SyncPayload {
  const projects = store.listProjects().slice(0, 500);
  const projectRecords: SyncPayload["projects"] = [];
  const tasks = projects.flatMap(project => store.listTasks(project.id)).filter(task => ["completed", "failed", "interrupted"].includes(task.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 50);
  for (const project of projects) {
    const displayName = label(project.name);
    if (!displayName) continue;
    const ownTasks = tasks.filter(task => task.project_id === project.id);
    projectRecords.push({ id: project.cloud_project_id ?? project.id, displayName,
      createdAt: project.opened_at, lastActiveAt: ownTasks[0]?.finished_at ?? ownTasks[0]?.created_at ?? project.opened_at });
  }
  const allowed = new Map(projects.map(project => [project.id, project.cloud_project_id ?? project.id]));
  const activity: SyncPayload["activity"] = [];
  const concepts = new Map<string, SyncPayload["concepts"][number]>();
  for (const task of tasks) {
    const projectId = allowed.get(task.project_id);
    if (!projectId || !projectRecords.some(project => project.id === projectId)) continue;
    const packet = store.getPacket(task.id);
    const files = packet?.attribution === "available" ? packet.files : [];
    activity.push({ id: task.id, projectId, createdAt: task.created_at, finishedAt: task.finished_at,
      status: task.status as "completed" | "failed" | "interrupted",
      providerId: (["codex", "claude-code", "cursor", "fixture"] as const).find(id => id === task.provider_id) ?? null,
      filesAdded: files.filter(file => file.change === "added").length,
      filesModified: files.filter(file => file.change === "modified").length,
      filesDeleted: files.filter(file => file.change === "deleted").length,
      testsPassed: packet?.tests?.passed ?? null, testsFailed: packet?.tests?.failed ?? null });
    const explain = store.getExplain(task.id);
    if (!explain) continue;
    const understood = new Set(explain.feedback.understood);
    for (const question of explain.asked) {
      const concept = label(question.concept);
      if (!concept) continue;
      const key = `${projectId}:${concept}`;
      const state = understood.has(question.concept) ? "understood" : "explored";
      const existing = concepts.get(key);
      if (!existing || state === "understood") concepts.set(key, { projectId, concept, state, recordedAt: task.finished_at ?? task.created_at });
    }
  }
  return syncPayloadSchema.parse({ projects: projectRecords, activity, concepts: [...concepts.values()].slice(0, 1000) });
}

export async function pushSummary(cloudUrl: string, deviceToken: string, store: Store): Promise<void> {
  const response = await fetch(new URL("/v1/sync", cloudUrl), {
    method: "POST", headers: { authorization: `Bearer ${deviceToken}`, "content-type": "application/json" },
    body: JSON.stringify(summaryForSync(store)),
  });
  if (!response.ok) throw new Error(`Summary sync returned ${response.status}`);
}
