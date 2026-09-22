"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runtimeFetch, type ClaimView, type LocalSession, type TaskPayload } from "@/lib/prentice";

export type LearningStep = "build" | "understand" | "explain" | "debug";

const HELP = [
  "Investigate yourself",
  "Hint",
  "Relevant evidence",
  "Concept",
  "Guided investigation",
  "Root cause",
  "Full solution",
] as const;

export function taskIssues(task: TaskPayload | null): Array<{ id: string; symptom: string; evidence: string }> {
  return task?.issues ?? [];
}

export function LearningSidebar({
  task,
  step,
  onStep,
}: {
  task: TaskPayload | null;
  step: LearningStep;
  onStep: (step: LearningStep) => void;
}) {
  const issues = taskIssues(task);
  const files = fileClaims(task);
  const concepts = conceptClaims(task);
  const rows: Array<{ id: LearningStep; title: string; detail: string; mark: "done" | "current" | "pending" | "fail" }> = [
    { id: "build", title: "Build", detail: buildDetail(task), mark: buildMark(task) },
    {
      id: "understand",
      title: "Understand",
      detail: task?.understand
        ? `${files.length} ${files.length === 1 ? "file" : "files"} changed\n${concepts.length} ${concepts.length === 1 ? "concept" : "concepts"} introduced`
        : "Waiting for a completed build",
      mark: understandMark(task),
    },
    { id: "explain", title: "Explain-back", detail: explainDetail(task), mark: explainMark(task) },
    {
      id: "debug",
      title: "Debug",
      detail: issues.length === 0 ? "No active issue" : `${issues.length} ${issues.length === 1 ? "failure" : "failures"} detected`,
      mark: issues.length === 0 ? "pending" : "current",
    },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">Prentice</p>
      <ul className="flex flex-col gap-1 px-2">
        {rows.map((row) => (
          <li key={row.id}>
            <button
              type="button"
              className={`w-full rounded-md px-2 py-2 text-left hover:bg-sidebar-accent ${step === row.id ? "bg-sidebar-accent" : ""}`}
              onClick={() => onStep(row.id)}
            >
              <span className="text-xs">
                <Mark name={row.mark} /> {row.title}
              </span>
              <span className="mt-1 block whitespace-pre-line pl-4 text-[11px] text-muted-foreground">{row.detail}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LearningPanel({
  task,
  session,
  step,
  onStep,
  onTask,
  onOpen,
  onReturn,
  onError,
}: {
  task: TaskPayload | null;
  session: LocalSession | null;
  step: LearningStep;
  onStep: (step: LearningStep) => void;
  onTask: (task: TaskPayload) => void;
  onOpen: (path: string, mode: "file" | "diff") => void;
  onReturn: () => void;
  onError: (message: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        {step === "build" ? <BuildView task={task} onUnderstand={() => onStep("understand")} /> : null}
        {step === "understand" ? <UnderstandView task={task} onOpen={onOpen} /> : null}
        {step === "explain" ? <ExplainView task={task} session={session} onTask={onTask} onOpen={onOpen} onError={onError} /> : null}
        {step === "debug" ? <DebugView task={task} /> : null}
      </div>
      <div className="border-t border-border p-3">
        <Button type="button" variant="outline" size="sm" onClick={onReturn}>
          Return to build
        </Button>
      </div>
    </div>
  );
}

function BuildView({ task, onUnderstand }: { task: TaskPayload | null; onUnderstand: () => void }) {
  const analyzed = Boolean(task?.decision);
  const selected = Boolean(task?.decision?.providerId || task?.providerId);
  const working = task?.status === "running";
  const complete = task?.status === "completed";
  const failed = task?.status === "failed";
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">Build</p>
      <p>{task?.prompt ?? "No task yet."}</p>
      <ol className="flex flex-col gap-2">
        <li>{analyzed ? "✓" : "○"} Task analyzed</li>
        <li>{selected ? "✓" : "○"} Agent selected</li>
        <li>{complete ? "✓" : working ? "→" : failed ? "×" : "○"} {complete ? "Build complete" : failed ? "Build failed" : "Agent working"}</li>
      </ol>
      {complete && task?.understand ? (
        <div>
          <p>→ Understand available</p>
          <Button type="button" size="sm" className="mt-2" onClick={onUnderstand}>
            Open Understand
          </Button>
        </div>
      ) : null}
      {failed && task?.error ? <p className="text-destructive">{task.error.message}</p> : null}
    </div>
  );
}

function UnderstandView({ task, onOpen }: { task: TaskPayload | null; onOpen: (path: string, mode: "file" | "diff") => void }) {
  const understand = task?.understand;
  if (!understand) {
    return <p className="text-sm text-muted-foreground">Understand is available after the build finishes and the git record is in.</p>;
  }
  return (
    <div className="flex flex-col gap-5 text-sm">
      <div>
        <p className="text-xs tracking-wide text-muted-foreground uppercase">What changed</p>
        <ClaimList claims={fileClaims(task).concat(conceptClaims(task))} onOpen={onOpen} empty="Git recorded no file or symbol change." />
      </div>
      {understand.changeMap ? (
        <div>
          <p className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">Change map</p>
          <pre className="overflow-x-auto font-mono text-xs whitespace-pre">{understand.changeMap}</pre>
        </div>
      ) : null}
      <ClaimList title="Observed" claims={understand.observed} onOpen={onOpen} />
      <ClaimList title="Agent stated" claims={understand.agentStated} onOpen={onOpen} empty="The session did not include an agent explanation." />
      <ClaimList title="Prentice inference" claims={understand.inferences} onOpen={onOpen} empty="No inference was added beyond the evidence." />
      <div>
        <p className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">Not in the evidence</p>
        <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
          {understand.insufficientEvidence.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function ExplainView({
  task,
  session,
  onTask,
  onOpen,
  onError,
}: {
  task: TaskPayload | null;
  session: LocalSession | null;
  onTask: (task: TaskPayload) => void;
  onOpen: (path: string, mode: "file" | "diff") => void;
  onError: (message: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  if (!task?.understand) return <p className="text-sm text-muted-foreground">Explain-back starts from a completed change.</p>;
  const explain = task.explain;

  async function send(path: string, body?: unknown) {
    if (!session) return;
    try {
      await runtimeFetch(session, path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      const next = await runtimeFetch<{ task: TaskPayload }>(session, `/v1/tasks/${task!.id}`);
      onTask(next.task);
      setAnswer("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Explain-back failed.");
    }
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">Explain-back</p>
      {!explain ? (
        <Button type="button" size="sm" onClick={() => send(`/v1/tasks/${task.id}/explain-back`)}>
          Start explain-back
        </Button>
      ) : null}
      {explain?.phase === "asking" && explain.current ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{explainDetail(task)}</p>
          <p>{explain.current.prompt}</p>
          <p className="text-xs text-muted-foreground">Grounding: {explain.current.grounding}</p>
          <CitationLinks citations={explain.current.citations ?? []} onOpen={onOpen} />
          <Textarea value={answer} rows={4} onChange={(event) => setAnswer(event.target.value)} placeholder="Write your explanation..." />
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={answer.trim().length === 0} onClick={() => send(`/v1/tasks/${task.id}/explain-back/answer`, { answer })}>
              Submit
            </Button>
            {explain.policy.offerSkip ? (
              <Button type="button" size="sm" variant="outline" onClick={() => send(`/v1/tasks/${task.id}/explain-back/skip`)}>
                Skip
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {explain && explain.phase !== "asking" ? (
        <p>{explain.phase === "skipped" ? "Skipped. You can keep building." : "Explain-back finished."}</p>
      ) : null}
      {explain ? (
        <>
          <Feedback title="You understand" items={explain.feedback.understood} />
          <Feedback title="Still unclear" items={explain.feedback.unclear} />
        </>
      ) : null}
    </div>
  );
}

function DebugView({ task }: { task: TaskPayload | null }) {
  const issues = taskIssues(task);
  const [level, setLevel] = useState<Record<string, number>>({});
  if (issues.length === 0) {
    return (
      <div className="text-sm">
        <p className="text-xs tracking-wide text-muted-foreground uppercase">Debug</p>
        <p className="mt-2 text-muted-foreground">No active issue. Debug appears when this session records a failed command, test, or runtime error.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">Debug</p>
      {issues.map((issue) => {
        const current = level[issue.id] ?? 0;
        return (
          <article key={issue.id} className="flex flex-col gap-2">
            <p className="font-medium">{issue.symptom}</p>
            <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
              {HELP.slice(0, current + 1).map((name, index) => (
                <li key={name}>
                  <span className="text-foreground">{index === current ? "→" : "✓"} {name}</span>
                  <span className="mt-1 block pl-4">{helpText(issue, index)}</span>
                </li>
              ))}
            </ol>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={current === 0} onClick={() => setLevel((value) => ({ ...value, [issue.id]: current - 1 }))}>
                Less help
              </Button>
              <Button type="button" size="sm" disabled={current >= HELP.length - 1} onClick={() => setLevel((value) => ({ ...value, [issue.id]: current + 1 }))}>
                More help
              </Button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function helpText(issue: { symptom: string; evidence: string }, level: number): string {
  if (level <= 0) return "Start from the symptom. The recorded detail stays hidden until you ask for it.";
  if (level === 1) return "This session stored a failure. The command or error text is the next step.";
  if (level === 2) return issue.evidence;
  if (level === 3) {
    return issue.symptom === "Command failed" || issue.symptom === "Tests failed"
      ? "A non-zero result means the command or test reported failure. That report is not a root cause."
      : "This is the failure text stored with the session. It is not a Prentice diagnosis.";
  }
  if (level === 4) return "Read that record next to the diff for this task. Prentice has not named a cause.";
  if (level === 5) return "No separate root cause was recorded.";
  return "No fix was recorded for this failure.";
}

function ClaimList({
  title,
  claims,
  onOpen,
  empty,
}: {
  title?: string;
  claims: ClaimView[];
  onOpen: (path: string, mode: "file" | "diff") => void;
  empty?: string;
}) {
  return (
    <div>
      {title ? <p className="mb-1 text-xs tracking-wide text-muted-foreground uppercase">{title}</p> : null}
      {claims.length === 0 && empty ? <p className="text-xs text-muted-foreground">{empty}</p> : null}
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => (
          <li key={claim.text}>
            <p>{claim.text}</p>
            <CitationLinks citations={claim.citations} onOpen={onOpen} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function CitationLinks({
  citations,
  onOpen,
}: {
  citations: Array<{ file?: string; symbol?: string }>;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const files = citations.filter((citation) => citation.file);
  if (files.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1">
      {files.map((citation) => (
        <button
          key={`${citation.file}-${citation.symbol ?? ""}`}
          type="button"
          className="text-left font-mono text-xs text-primary hover:underline"
          onClick={() => onOpen(citation.file!, "file")}
        >
          {citation.symbol ? `${citation.symbol} → ${citation.file}` : citation.file}
        </button>
      ))}
    </div>
  );
}

function Feedback({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{title === "You understand" ? `✓ ${item}` : `• ${item}`}</li>
        ))}
      </ul>
    </div>
  );
}

function Mark({ name }: { name: "done" | "current" | "pending" | "fail" }) {
  if (name === "done") return <span>✓</span>;
  if (name === "current") return <span>→</span>;
  if (name === "fail") return <span>×</span>;
  return <span>○</span>;
}

function buildMark(task: TaskPayload | null): "done" | "current" | "pending" | "fail" {
  if (!task) return "pending";
  if (task.status === "failed") return "fail";
  if (task.status === "completed") return "done";
  return "current";
}

function understandMark(task: TaskPayload | null): "done" | "current" | "pending" {
  if (!task?.understand) return "pending";
  if (task.explain) return "done";
  return "current";
}

function explainMark(task: TaskPayload | null): "done" | "current" | "pending" {
  if (!task?.explain) return "pending";
  if (task.explain.phase === "asking") return "current";
  return "done";
}

function buildDetail(task: TaskPayload | null): string {
  if (!task) return "No task yet";
  if (task.status === "running") return "Agent working";
  if (task.status === "completed") return "Implementation complete";
  if (task.status === "failed") return "The session failed";
  if (task.status === "analyzed") return "Ready to run";
  return task.status;
}

function explainDetail(task: TaskPayload | null): string {
  if (!task?.understand) return "Not ready";
  if (!task.explain) return "Not started";
  if (task.explain.phase === "skipped") return "Skipped";
  if (task.explain.phase === "done") return "Finished";
  const asked = task.explain.feedback.understood.length + task.explain.feedback.unclear.length + 1;
  return `Question ${asked}`;
}

function fileClaims(task: TaskPayload | null): ClaimView[] {
  return (task?.understand?.observed ?? []).filter(
    (claim) => claim.citations.some((citation) => citation.file) && claim.citations.every((citation) => !citation.symbol),
  );
}

function conceptClaims(task: TaskPayload | null): ClaimView[] {
  return (task?.understand?.observed ?? []).filter((claim) => claim.citations.some((citation) => citation.symbol));
}
