import type { NormalizedEvent, TimelineItem } from "./types.js";

export function toTimeline(events: NormalizedEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  const gitPaths = new Set(
    events.flatMap((event) => (event.type === "file.changed" && event.source === "git" ? [event.path] : [])),
  );
  let assistantCount = 0;

  events.forEach((event, index) => {
    const id = event.id ?? `e${index}`;
    switch (event.type) {
      case "session.started":
        items.push({ id, title: "Session started", tone: "neutral" });
        break;
      case "status":
        items.push({ id, title: event.title, detail: event.detail, tone: "neutral" });
        break;
      case "assistant": {
        assistantCount += 1;
        const compact = event.text.replace(/\s+/g, " ").trim();
        if (compact.length === 0 || compact.length > 280 || compact.includes("```")) {
          items.push({
            id,
            title: "Agent sent a long update",
            detail: "The full text is kept in the session record and is not dumped into the timeline.",
            tone: "neutral",
          });
        } else if (assistantCount <= 4) {
          items.push({ id, title: "Agent note", detail: compact, tone: "neutral" });
        }
        break;
      }
      case "tool.started":
        items.push({ id, title: event.title, detail: event.path ?? event.command, tone: "neutral" });
        break;
      case "tool.finished":
        items.push({
          id,
          title: event.title,
          detail: event.detail,
          tone: event.ok ? "ok" : "fail",
        });
        break;
      case "file.changed":
        if (event.source === "agent" && gitPaths.has(event.path)) break;
        items.push({
          id,
          title: `${labelChange(event.change)} ${event.path}`,
          detail: event.source === "git" ? "Confirmed from git." : "Reported by the agent. Git is the change record.",
          tone: "change",
        });
        break;
      case "command.started":
        items.push({ id, title: "Running command", detail: event.command, tone: "neutral" });
        break;
      case "command.finished":
        items.push({
          id,
          title: event.exitCode === 0 ? "Command finished" : "Command failed",
          detail: event.command,
          tone: event.exitCode === 0 ? "ok" : "fail",
        });
        break;
      case "usage":
        break;
      case "session.completed":
        items.push({ id, title: "Session completed", detail: event.summary, tone: "ok" });
        break;
      case "session.failed":
        items.push({ id, title: "Session failed", detail: event.message, tone: "fail" });
        break;
      case "session.interrupted":
        items.push({ id, title: "Session interrupted", tone: "fail" });
        break;
      default:
        break;
    }
  });

  return items;
}

function labelChange(change: "added" | "modified" | "deleted"): string {
  if (change === "added") return "Added";
  if (change === "deleted") return "Removed";
  return "Modified";
}

export const DESTRUCTIVE_COMMAND =
  /(\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\brm\s+-rf\b|\bsudo\b|\bmkfs\b|\bshutdown\b|\breboot\b|\b(curl|wget)\b[^|\n]*\|\s*(ba)?sh\b)/i;

export function commandAllowed(command: string): { allowed: boolean; reason?: string } {
  if (DESTRUCTIVE_COMMAND.test(command)) {
    return {
      allowed: false,
      reason: "Prentice blocked this command. It can push, erase history, or run a remote script.",
    };
  }
  return { allowed: true };
}
