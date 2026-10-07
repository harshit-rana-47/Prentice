import { toTimeline } from "./activity.js";
import type { CommandOutput, NormalizedEvent, TimelineItem } from "./types.js";

export interface DebugIssue {
  id: string;
  symptom: string;
  evidence: string;
  /** Bounded stdout/stderr from the failed command, labelled as command output. Absent when none was recorded. */
  output?: CommandOutput;
}

/**
 * Session failures that describe setup, not a defect in the work: a coding agent that is not signed in or not
 * installed, a run Prentice itself stopped, or a runtime that went away. Debug is for real failures only.
 */
export const NON_DEFECT_FAILURE_CODES = new Set([
  "AGENT_SIGNED_OUT",
  "AGENT_NOT_INSTALLED",
  "AGENT_UNAVAILABLE",
  "CONTINUATION_UNAVAILABLE",
  "SESSION_ENDED",
  "RUNTIME_DISCONNECTED",
]);

/** Failures already stored on the session. An interrupt is a stop, not a defect. */
export function debugIssuesFromTimeline(items: TimelineItem[]): DebugIssue[] {
  return items.flatMap((item) => {
    if (item.tone !== "fail" || item.title === "Session interrupted") return [];
    if (item.code && NON_DEFECT_FAILURE_CODES.has(item.code)) return [];
    return [
      {
        id: item.id,
        symptom: item.title,
        evidence: item.detail?.trim() || "The session recorded the failure and did not include more output.",
        ...(item.output ? { output: item.output } : {}),
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
