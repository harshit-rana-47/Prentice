"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import {
  loadSession,
  readTaskStream,
  runtimeFetch,
  type ClaimView,
  type LocalSession,
  type TaskPayload,
  type TimelineItem,
} from "@/lib/prentice";
import { Shell } from "@/components/shell";

export function TaskScreen({ taskId }: { taskId: string }) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [task, setTask] = useState<TaskPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let timer = 0;
    loadSession()
      .then((next) => {
        setSession(next);
        const pull = () => {
          runtimeFetch<{ task: TaskPayload }>(next, `/v1/tasks/${taskId}`)
            .then((body) => setTask(body.task))
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the task."));
        };
        pull();
        timer = window.setInterval(() => {
          runtimeFetch<{ task: TaskPayload }>(next, `/v1/tasks/${taskId}`)
            .then((body) => {
              setTask(body.task);
              const done = body.task.status === "completed" || body.task.status === "failed" || body.task.status === "interrupted";
              if (done && (body.task.understand || body.task.status !== "completed")) window.clearInterval(timer);
            })
            .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load the task."));
        }, 1500);
        void readTaskStream(next, taskId, setTask, controller.signal).catch(() => undefined);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Runtime unavailable."));
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [taskId]);

  return (
    <Shell>
      <div className="mb-4">
        <Link href="/" className="text-sm text-muted-foreground">
          Back to tasks
        </Link>
      </div>
      {error ? <p className="mb-4 text-sm text-destructive">{error}</p> : null}
      {task ? (
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="font-[family-name:var(--font-serif)] text-2xl font-normal">
                {task.labels?.complexity ?? "Task"} · {task.labels?.intensity ?? task.status}
              </CardTitle>
              <CardDescription className="text-foreground">{task.prompt}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-sm text-muted-foreground">Status: {task.status}</p>
              {task.error ? (
                <p className="text-sm text-destructive">
                  {task.error.message}
                  {task.error.retryable ? " You can start a new task when the provider is back." : ""}
                </p>
              ) : null}
              {task.decision ? (
                <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
                  {task.decision.why.map((reason) => (
                    <li key={reason}>{reason}</li>
                  ))}
                </ul>
              ) : null}
              {task.status === "running" && session ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    runtimeFetch(session, `/v1/tasks/${taskId}/interrupt`, { method: "POST" }).catch((reason: unknown) =>
                      setError(reason instanceof Error ? reason.message : "Could not interrupt."),
                    )
                  }
                >
                  Interrupt
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Activity</CardTitle>
              <CardDescription>A readable timeline. Git confirms file changes.</CardDescription>
            </CardHeader>
            <CardContent>
              <ol className="flex flex-col gap-3">
                {task.timeline.map((item) => (
                  <TimelineRow key={item.id} item={item} />
                ))}
              </ol>
            </CardContent>
          </Card>
          {task.understand ? <UnderstandPanel understand={task.understand} /> : null}
          {task.understand && session ? (
            <ExplainPanel
              task={task}
              answer={answer}
              onAnswer={setAnswer}
              onError={setError}
              onUpdate={setTask}
              session={session}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the session…</p>
      )}
    </Shell>
  );
}

function TimelineRow({ item }: { item: TimelineItem }) {
  const tone =
    item.tone === "fail" ? "border-destructive" : item.tone === "ok" ? "border-primary" : "border-border";
  return (
    <li className={`border-l-2 pl-3 ${tone}`}>
      <p>{item.title}</p>
      {item.detail ? <p className="text-sm text-muted-foreground">{item.detail}</p> : null}
    </li>
  );
}

function UnderstandPanel({ understand }: { understand: NonNullable<TaskPayload["understand"]> }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Understand</CardTitle>
        <CardDescription>Observed facts, what the agent stated, and labeled inferences stay separate.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <ClaimList title="Observed" claims={understand.observed} />
        <ClaimList title="Agent stated" claims={understand.agentStated} empty="The session did not include an agent explanation." />
        <ClaimList title="Prentice inference" claims={understand.inferences} empty="No inference was added beyond the evidence." />
        {understand.changeMap ? (
          <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{understand.changeMap}</pre>
        ) : null}
        <div>
          <p className="mb-1 text-sm font-medium">Not in the evidence</p>
          <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
            {understand.insufficientEvidence.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function ClaimList({ title, claims, empty }: { title: string; claims: ClaimView[]; empty?: string }) {
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{title}</p>
      {claims.length === 0 ? <p className="text-sm text-muted-foreground">{empty ?? "Nothing recorded."}</p> : null}
      <ul className="flex flex-col gap-2">
        {claims.map((claim) => (
          <li key={claim.text} className="text-sm">
            {claim.text}
            {claim.citations.some((citation) => citation.file) ? (
              <span className="mt-1 block font-mono text-xs text-muted-foreground">
                {claim.citations
                  .map((citation) => citation.symbol ? `${citation.file} · ${citation.symbol}` : citation.file)
                  .filter(Boolean)
                  .join(", ")}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExplainPanel({
  task,
  session,
  answer,
  onAnswer,
  onUpdate,
  onError,
}: {
  task: TaskPayload;
  session: LocalSession;
  answer: string;
  onAnswer: (value: string) => void;
  onUpdate: (task: TaskPayload) => void;
  onError: (message: string) => void;
}) {
  async function send(path: string, body?: unknown) {
    try {
      await runtimeFetch(session, path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
      const next = await runtimeFetch<{ task: TaskPayload }>(session, `/v1/tasks/${task.id}`);
      onUpdate(next.task);
      onAnswer("");
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "Explain-back failed.");
    }
  }

  const explain = task.explain;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Explain it back</CardTitle>
        <CardDescription>
          Questions come from this change. You can skip. Feedback lists what is understood and what is still unclear.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!explain ? (
          <Button type="button" onClick={() => send(`/v1/tasks/${task.id}/explain-back`)}>
            Start explain-back
          </Button>
        ) : null}
        {explain?.phase === "asking" && explain.current ? (
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="answer">{explain.current.prompt}</FieldLabel>
              <p className="text-xs text-muted-foreground">Grounding: {explain.current.grounding}</p>
              <Textarea id="answer" value={answer} rows={4} onChange={(event) => onAnswer(event.target.value)} />
            </Field>
            <div className="flex gap-2">
              <Button type="button" disabled={answer.trim().length === 0} onClick={() => send(`/v1/tasks/${task.id}/explain-back/answer`, { answer })}>
                Submit answer
              </Button>
              {explain.policy.offerSkip ? (
                <Button type="button" variant="outline" onClick={() => send(`/v1/tasks/${task.id}/explain-back/skip`)}>
                  Skip
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        ) : null}
        {explain && explain.phase !== "asking" ? (
          <div className="flex flex-col gap-3 text-sm">
            <p>{explain.phase === "skipped" ? "Skipped. You can keep building." : "Explain-back finished."}</p>
            <Feedback title="You understand" items={explain.feedback.understood} />
            <Feedback title="Still unclear" items={explain.feedback.unclear} />
          </div>
        ) : null}
        {explain?.phase === "asking" ? (
          <div className="mt-4 flex flex-col gap-3 text-sm">
            <Feedback title="You understand" items={explain.feedback.understood} />
            <Feedback title="Still unclear" items={explain.feedback.unclear} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Feedback({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="font-medium">{title}</p>
      <ul className="mt-1 flex flex-col gap-1 text-muted-foreground">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
