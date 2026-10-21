/** Local journal summaries. No repository contents or inferred mastery scores. */
export interface JournalEntry {
  id: string;
  projectId: string;
  conversationId: string;
  title: string;
  focus: string;
  at: string;
  status: string;
  providerId: string | null;
  observed: string[];
  understood: string[];
  unclear: string[];
  explored: string[];
  debug: Array<{ symptom: string; evidence: string }>;
  explainPhase: string | null;
}
export interface HomeProject {
  id: string;
  name: string;
  path: string;
  conversations: number;
  latest: JournalEntry | null;
  understood: string[];
  explored: string[];
}
export interface HomeSnapshot {
  projects: HomeProject[];
  entries: JournalEntry[];
  total: number;
  nextOffset: number | null;
  latest: JournalEntry | null;
  attention: JournalEntry[];
  learned: JournalEntry[];
  pins: string[];
  lastVisit: string | null;
  since: { completed: number; interrupted: number };
  /** UTC activity dates, explicitly labelled by the calendar. */
  calendar: Array<{ day: string; tasks: number; learning: number; debug: number }>;
}
