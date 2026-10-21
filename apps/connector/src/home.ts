import { debugIssuesFromEvents, debugIssuesFromObservations, scrubEvidence, type ExplainSessionState, type NormalizedEvent, type UnderstandArtifact } from "@prentice/domain";
import type { HomeSnapshot, JournalEntry } from "@prentice/protocol";
import type { Store } from "./store.js";

const unique = (items: string[]) => [...new Set(items)];
export function homeSnapshot(store: Store, filter: { query: string; category?: "all" | "learning" | "debug" | "interrupted"; day?: string; offset: number }): HomeSnapshot {
  const projects = store.listProjects();
  for (const project of projects) store.ensureConversations(project.id);
  const failures = new Map<string, NormalizedEvent[]>();
  for (const row of store.journalFailures()) {
    const list = failures.get(row.task_id) ?? [];
    list.push(JSON.parse(row.event_json));
    failures.set(row.task_id, list);
  }
  const entries: JournalEntry[] = store.journalRows().map(row => {
    const understand = row.artifact ? JSON.parse(row.artifact) as UnderstandArtifact : null;
    const explain = row.explanation ? JSON.parse(row.explanation) as ExplainSessionState : null;
    const observed = understand?.observed.map(claim => claim.text) ?? [];
    const recorded = debugIssuesFromEvents(failures.get(row.id) ?? []);
    const debug = recorded.some(item => item.output) ? recorded : [...recorded, ...debugIssuesFromObservations(observed)];
    return {
      id: row.id, projectId: row.project_id, conversationId: row.conversation_id!, title: row.title,
      focus: row.prompt.slice(0, 600), at: row.finished_at ?? row.started_at ?? row.created_at,
      status: row.status, providerId: row.provider_id,
      observed, understood: explain?.feedback.understood ?? [], unclear: explain?.feedback.unclear ?? [],
      explored: unique((explain?.asked ?? []).map(question => question.concept)),
      debug: debug.map(item => ({ symptom: item.symptom, evidence: item.evidence.slice(0, 400) })),
      explainPhase: explain?.phase ?? null,
    };
  });
  const calendar = new Map<string, HomeSnapshot["calendar"][number]>();
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    const item = calendar.get(day) ?? { day, tasks: 0, learning: 0, debug: 0 };
    item.tasks++; item.learning += Number(entry.understood.length > 0); item.debug += entry.debug.length;
    calendar.set(day, item);
  }
  const historyByProject = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    const history = historyByProject.get(entry.projectId) ?? [];
    history.push(entry);
    historyByProject.set(entry.projectId, history);
  }
  const projectViews = projects.map(project => {
    const history = historyByProject.get(project.id) ?? [];
    return { id: project.id, name: project.name, path: project.path,
      conversations: store.listConversations(project.id).length, latest: history[0] ?? null,
      understood: unique(history.flatMap(entry => entry.understood)), explored: unique(history.flatMap(entry => entry.explored)) };
  });
  const names = new Map(projects.map(project => [project.id, project.name]));
  const query = filter.query.trim().toLocaleLowerCase();
  const matching = entries.filter(entry => (!filter.category || filter.category === "all" || (filter.category === "learning" ? entry.observed.length || entry.explored.length || entry.understood.length : filter.category === "debug" ? entry.debug.length : entry.status === "interrupted")) && (!filter.day || entry.at.startsWith(filter.day)) && (!query ||
    [names.get(entry.projectId), entry.title, entry.focus, entry.debug.length ? "Debug" : "", ...entry.observed, ...entry.understood, ...entry.unclear, ...entry.explored,
      ...entry.debug.flatMap(item => [item.symptom, item.evidence])].join(" ").toLocaleLowerCase().includes(query)));
  const lastVisit = store.getSetting("home.lastVisit") ?? null;
  const since = entries.filter(entry => lastVisit && entry.at > lastVisit);
  return scrubEvidence({ projects: projectViews, entries: matching.slice(filter.offset, filter.offset + 50), total: matching.length,
    nextOffset: filter.offset + 50 < matching.length ? filter.offset + 50 : null,
    latest: entries[0] ?? null, attention: entries.filter(entry => entry.status === "interrupted" || entry.unclear.length || entry.debug.length).slice(0, 5),
    learned: entries.filter(entry => entry.understood.length).slice(0, 5), pins: readPins(store), lastVisit,
    since: { completed: since.filter(entry => entry.status === "completed").length, interrupted: since.filter(entry => entry.status === "interrupted").length },
    calendar: [...calendar.values()] });
}
export function readPins(store: Store): string[] {
  try { const value: unknown = JSON.parse(store.getSetting("home.pins") ?? "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 100) : []; }
  catch { return []; }
}
