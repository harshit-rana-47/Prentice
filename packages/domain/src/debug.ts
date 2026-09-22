import { toTimeline } from "./activity.js";
import type { NormalizedEvent, TimelineItem } from "./types.js";

export interface DebugIssue {
  id: string;
  symptom: string;
  evidence: string;
}

/** Failures already stored on the session. An interrupt is a stop, not a defect. */
export function debugIssuesFromTimeline(items: TimelineItem[]): DebugIssue[] {
  return items.flatMap((item) => {
    if (item.tone !== "fail" || item.title === "Session interrupted") return [];
    return [
      {
        id: item.id,
        symptom: item.title,
        evidence: item.detail?.trim() || "The session recorded the failure and did not include more output.",
      },
    ];
  });
}

export function debugIssuesFromEvents(events: NormalizedEvent[]): DebugIssue[] {
  return debugIssuesFromTimeline(toTimeline(events));
}

/** Matches the sentence produced from a recorded test result. */
export function debugIssuesFromObservations(texts: string[]): DebugIssue[] {
  const issues: DebugIssue[] = [];
  for (const text of texts) {
    const match = /^Tests reported (\d+) passed and (\d+) failed\.$/.exec(text);
    if (!match || Number(match[2]) === 0) continue;
    issues.push({ id: `tests:${text}`, symptom: "Tests failed", evidence: text });
  }
  return issues;
}
