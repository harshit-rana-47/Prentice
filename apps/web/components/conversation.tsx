"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { ExplainView, ProviderView, TaskPayload, TimelineItem } from "@/lib/prentice";

const INTENSITIES = ["fast", "balanced", "deep", "maximum"] as const;

function enterSends(event: KeyboardEvent<HTMLTextAreaElement>, blocked: boolean) {
  if (event.key !== "Enter" || event.shiftKey) return;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return;
  if (window.matchMedia("(pointer: coarse)").matches) return;
  event.preventDefault();
  if (blocked) return false;
  event.currentTarget.form?.requestSubmit();
  return true;
}

export function Conversation({
  task,
  earlier,
  providers,
  prompt,
  pending,
  running,
  separateConversation,
  canContinue,
  busyElsewhere,
  disconnected,
  repoPath,
  providerOverride,
  intensityOverride,
  useProviderMax,
  changing,
  onPrompt,
  onSend,
  onStop,
  onChanging,
  onProvider,
  onIntensity,
  onMax,
  onOpen,
  onExplain,
  onError,
  explainError,
}: {
  task: TaskPayload | null;
  earlier: TaskPayload[];
  providers: ProviderView[];
  prompt: string;
  pending: boolean;
  running: boolean;
  separateConversation: boolean;
  canContinue: boolean;
  busyElsewhere: string | null;
  disconnected: boolean;
  repoPath: string | null;
  providerOverride: string;
  intensityOverride: string;
  useProviderMax: boolean;
  changing: boolean;
  onPrompt: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  onChanging: (value: boolean) => void;
  onProvider: (value: string) => void;
  onIntensity: (value: string) => void;
  onMax: (value: boolean) => void;
  onOpen: (path: string, mode: "file" | "diff") => void;
  onExplain: (path: string, body?: unknown) => Promise<void>;
  onError: (message: string) => void;
  explainError: string | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const seenTask = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [askingPrentice, setAskingPrentice] = useState(false);
  const [question, setQuestion] = useState("");
  const [questionError, setQuestionError] = useState<string | null>(null);
  const [explainBusy, setExplainBusy] = useState(false);
  const wasRunning = useRef(false);

  const explain = task?.explain ?? null;
  const asking = Boolean(explain && (explain.phase === "asking" || explain.phase === "taught") && explain.current);
  const agentName = providerName(providers, task);
  const connectedProviders = providers.filter((provider) => provider.connected && provider.id !== "fixture");
  const chosen = providers.find((provider) => provider.id === (providerOverride || task?.decision?.providerId || task?.providerId || ""));
  const showChange = (separateConversation || !task) && connectedProviders.length > 0;
  const sendBlocked = pending || running || Boolean(busyElsewhere);
  const unavailable = Boolean(task?.continuation && !task.continuation.available && task.status !== "running" && task.status !== "analyzed");
  const signature = `${earlier.map((item) => item.id).join(",")}:${task?.id ?? ""}:${task?.timeline.length ?? 0}:${explain?.phase ?? ""}:${explain?.discussion?.length ?? 0}`;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const id = task?.id ?? null;
    const changed = seenTask.current !== id;
    seenTask.current = id;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (!changed && distance > 180) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({ top: node.scrollHeight, behavior: changed && !reduce ? "smooth" : "auto" });
  }, [signature, task?.id]);

  useEffect(() => {
    if (!separateConversation) return;
    document.getElementById("task-prompt")?.focus();
  }, [separateConversation]);

  useEffect(() => {
    if (!asking || separateConversation) return;
    document.getElementById("explain-answer")?.focus();
  }, [asking, explain?.current?.id, separateConversation]);

  useEffect(() => {
    if (!askingPrentice) return;
    document.getElementById("explain-follow-up")?.focus();
  }, [askingPrentice]);

  useEffect(() => {
    if (explain?.phase !== "done") setAskingPrentice(false);
  }, [explain?.phase, task?.id]);

  useEffect(() => {
    if (!changing) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onChanging(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [changing, onChanging]);

  useEffect(() => {
    const finished = wasRunning.current && !running;
    wasRunning.current = running;
    if (!finished || asking || askingPrentice) return;
    const active = document.activeElement;
    if (active && active !== document.body && !(active instanceof HTMLTextAreaElement && active.id === "task-prompt")) return;
    document.getElementById("task-prompt")?.focus();
  }, [running, asking, askingPrentice]);

  async function submitExplain(path: string, body?: unknown) {
    setExplainBusy(true);
    try {
      await onExplain(path, body);
    } finally {
      setExplainBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {running ? <div className="prentice-progress h-0.5 shrink-0" /> : <div className="h-0.5 shrink-0" />}
      <div ref={scroller} className="prentice-thread min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-5">
        {!separateConversation && (task || earlier.length > 0) ? (
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
            {earlier.map((turn) => (
              <Turn key={turn.id} task={turn} providers={providers} repoPath={repoPath} live={false} onOpen={onOpen} />
            ))}
            {task ? (
              <Turn
                task={task}
                providers={providers}
                repoPath={repoPath}
                live
                running={running}
                explainError={explainError}
                onOpen={onOpen}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex h-full items-end">
            <div className="max-w-lg pb-6">
              <h2 className="font-serif text-[2rem] leading-tight tracking-[-0.03em] text-balance">
                {disconnected ? "This computer is not connected." : "What should the agent work on?"}
              </h2>
              {disconnected ? null : (
                <p className="mt-2 text-sm text-pretty text-muted-foreground">
                  The repository stays on this computer. After the agent finishes, Prentice asks about the work in this same conversation.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {!separateConversation && asking && explain?.current && task ? (
        <form
          className="prentice-rise prentice-composer shrink-0 border-t border-border px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (explainBusy) return;
            if (answer.trim().length === 0) {
              setAnswerError("Write an explanation first.");
              document.getElementById("explain-answer")?.focus();
              return;
            }
            setAnswerError(null);
            void submitExplain(`/v1/tasks/${task.id}/explain-back/answer`, { answer }).then(() => setAnswer("")).catch(() => undefined);
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Prentice</p>
            <label className="font-serif text-base leading-snug" htmlFor="explain-answer">
              Explain it to Prentice
            </label>
            <Textarea
              id="explain-answer"
              name="explanation"
              autoComplete="off"
              value={answer}
              rows={3}
              placeholder="Say what changed, in your own words…"
              disabled={explainBusy}
              enterKeyHint="send"
              aria-invalid={answerError ? true : undefined}
              aria-describedby={answerError ? "explain-answer-error composer-hint" : "composer-hint"}
              aria-keyshortcuts="Enter"
              onChange={(event) => {
                setAnswer(event.target.value);
                if (answerError) setAnswerError(null);
              }}
              onKeyDown={(event) => {
                const blocked = enterSends(event, explainBusy || answer.trim().length === 0);
                if (blocked === false && !explainBusy && answer.trim().length === 0) setAnswerError("Write an explanation first.");
              }}
              className="min-h-20 resize-none bg-background text-[13.5px] leading-6"
            />
            {answerError ? (
              <p id="explain-answer-error" className="text-xs text-destructive">
                {answerError}
              </p>
            ) : null}
            <p id="composer-hint" className="hidden text-[11px] text-muted-foreground [@media(pointer:fine)]:block">
              Enter to send. Shift+Enter for a new line.
            </p>
            <div className="flex items-center justify-end gap-2">
              {explain.policy.offerSkip ? (
                <Button type="button" size="sm" variant="ghost" disabled={explainBusy} onClick={() => void submitExplain(`/v1/tasks/${task.id}/explain-back/skip`).catch(() => undefined)}>
                  Skip
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={explainBusy || answer.trim().length === 0} aria-busy={explainBusy}>
                {explainBusy ? "Replying…" : "Reply"}
              </Button>
            </div>
          </div>
        </form>
      ) : !separateConversation && askingPrentice && explain && task && explain.phase === "done" ? (
        <form
          className="prentice-rise prentice-composer shrink-0 border-t border-border px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (explainBusy) return;
            const next = question.trim();
            if (!next) {
              setQuestionError("Write a question first.");
              document.getElementById("explain-follow-up")?.focus();
              return;
            }
            setQuestionError(null);
            void submitExplain(`/v1/tasks/${task.id}/explain-back/discuss`, { question: next })
              .then(() => {
                setQuestion("");
                setAskingPrentice(false);
              })
              .catch((reason: unknown) => onError(reason instanceof Error ? reason.message : "The follow-up failed."));
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Prentice</p>
            <label className="font-serif text-base leading-snug" htmlFor="explain-follow-up">
              Ask Prentice
            </label>
            <Textarea
              id="explain-follow-up"
              name="follow-up"
              autoComplete="off"
              value={question}
              rows={2}
              placeholder="Ask about this change, or about the idea behind it…"
              disabled={explainBusy}
              enterKeyHint="send"
              aria-invalid={questionError ? true : undefined}
              aria-describedby={questionError ? "explain-follow-up-error composer-hint" : "composer-hint"}
              aria-keyshortcuts="Enter"
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setAskingPrentice(false);
                  document.getElementById("task-prompt")?.focus();
                  return;
                }
                const blocked = enterSends(event, explainBusy || question.trim().length === 0);
                if (blocked === false && !explainBusy && question.trim().length === 0) setQuestionError("Write a question first.");
              }}
              className="min-h-16 resize-none bg-background text-[13.5px] leading-6"
            />
            {questionError ? (
              <p id="explain-follow-up-error" className="text-xs text-destructive">
                {questionError}
              </p>
            ) : null}
            <p id="composer-hint" className="hidden text-[11px] text-muted-foreground [@media(pointer:fine)]:block">
              Enter to send. Shift+Enter for a new line.
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={explainBusy} onClick={() => setAskingPrentice(false)}>
                Back to the agent
              </Button>
              <Button type="submit" size="sm" disabled={explainBusy || question.trim().length === 0} aria-busy={explainBusy}>
                {explainBusy ? "Asking…" : "Ask"}
              </Button>
            </div>
          </div>
        </form>
      ) : (
        <form
          className="prentice-rise prentice-composer shrink-0 border-t border-border px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (sendBlocked) return;
            if (prompt.trim().length === 0) {
              setFormError("Write what the agent should do.");
              document.getElementById("task-prompt")?.focus();
              return;
            }
            setFormError(null);
            onSend();
          }}
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            {busyElsewhere ? <p className="text-xs text-pretty text-muted-foreground">{busyElsewhere}</p> : null}
            {unavailable && !separateConversation && task?.continuation?.message ? (
              <p className="text-xs text-pretty text-muted-foreground">{task.continuation.message} New Chat starts a separate conversation.</p>
            ) : null}
            {separateConversation ? <p className="text-xs text-muted-foreground">This message starts a new conversation.</p> : null}
            {showChange ? (
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-xs text-muted-foreground" translate="no">
                  {chosen
                    ? `${chosen.capabilities.displayName}${intensityOverride || task?.decision ? ` · ${labelIntensity(intensityOverride || task?.decision?.intensity || "balanced")}` : ""}`
                    : "Prentice will choose the agent"}
                </p>
                <Button type="button" size="sm" variant="ghost" aria-expanded={changing} onClick={() => onChanging(!changing)}>
                  Change Agent
                </Button>
              </div>
            ) : null}
            {showChange && changing ? (
              <AgentChoices
                providers={connectedProviders}
                chosen={chosen}
                providerOverride={providerOverride}
                intensityOverride={intensityOverride}
                useProviderMax={useProviderMax}
                onProvider={onProvider}
                onIntensity={onIntensity}
                onMax={onMax}
              />
            ) : null}
            <label className="sr-only" htmlFor="task-prompt">
              Task
            </label>
            <Textarea
              id="task-prompt"
              name="task"
              autoComplete="off"
              value={prompt}
              disabled={sendBlocked}
              enterKeyHint="send"
              placeholder={canContinue ? `Continue with ${agentName}…` : "Ask the agent to work on this project…"}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? "task-error composer-hint" : "composer-hint"}
              aria-keyshortcuts="Enter"
              onChange={(event) => {
                onPrompt(event.target.value);
                if (formError) setFormError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && changing) {
                  event.preventDefault();
                  onChanging(false);
                  return;
                }
                const blocked = enterSends(event, sendBlocked || prompt.trim().length === 0);
                if (blocked === false && !sendBlocked && prompt.trim().length === 0) {
                  setFormError("Write what the agent should do.");
                }
              }}
              className="min-h-20 resize-none bg-background text-[13.5px] leading-6"
            />
            {formError ? (
              <p id="task-error" className="text-xs text-destructive">
                {formError}
              </p>
            ) : null}
            <p id="composer-hint" className="hidden text-[11px] text-muted-foreground [@media(pointer:fine)]:block">
              Enter to send. Shift+Enter for a new line.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {canContinue ? (
                <p className="mr-auto font-mono text-[11px] tracking-wide text-muted-foreground" translate="no">
                  Continuing with {agentName}
                </p>
              ) : null}
              {explain?.phase === "done" ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setAskingPrentice(true)}>
                  Ask Prentice
                </Button>
              ) : null}
              {running ? (
                <Button type="button" size="sm" variant="outline" onClick={onStop}>
                  Stop
                </Button>
              ) : null}
              <Button type="submit" size="sm" disabled={sendBlocked || prompt.trim().length === 0} aria-busy={pending}>
                {pending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

function Turn({
  task,
  providers,
  repoPath,
  live,
  running = false,
  explainError = null,
  onOpen,
}: {
  task: TaskPayload;
  providers: ProviderView[];
  repoPath: string | null;
  live: boolean;
  running?: boolean;
  explainError?: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const name = providerName(providers, task);
  const intensity = task.decision ? labelIntensity(task.decision.intensity) : null;
  const explain = task.explain;
  const waiting = live && Boolean(task.understand) && !explain && (task.status === "completed" || task.status === "failed");
  const replies = task.timeline.filter((item) => item.title === "Agent" && publicDetail(item.detail));
  const activity = task.timeline.filter(isActivity);
  return (
    <section className={live ? "prentice-rise flex flex-col gap-3" : "flex flex-col gap-3"}>
      <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-card px-3.5 py-2 text-[13.5px] leading-6 text-pretty break-words shadow-[0_1px_0_rgb(36_24_15/0.04),0_8px_16px_-12px_rgb(36_24_15/0.28)]">{task.prompt}</p>
      {name ? (
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground" translate="no">
          {name}
          {intensity ? ` · ${intensity}` : ""}
        </p>
      ) : null}
      {replies.map((item) => (
        <AgentReply key={item.id} text={publicDetail(item.detail) ?? ""} repoPath={repoPath} onOpen={onOpen} />
      ))}
      {running && replies.length === 0 ? <p className="prentice-live font-serif text-sm text-muted-foreground">Working in this repository…</p> : null}
      {activity.length > 0 ? (
        <ol className="flex flex-col gap-1.5">
          {activity.map((item, index, items) => (
            <TimelineRow
              key={item.id}
              item={item}
              repoPath={repoPath}
              active={running && index === items.length - 1}
              issue={task.issues.find((entry) => entry.id === item.id) ?? null}
              onOpen={onOpen}
            />
          ))}
        </ol>
      ) : null}
      <LearningClose task={task} repoPath={repoPath} onOpen={onOpen} />
      {waiting ? (
        <p className="font-serif text-sm text-pretty text-muted-foreground">{explainError ?? "Prentice is reading this change…"}</p>
      ) : null}
      {explain ? <ExplainMoment explain={explain} repoPath={repoPath} onOpen={onOpen} /> : null}
    </section>
  );
}

function TimelineRow({
  item,
  repoPath,
  active,
  issue,
  onOpen,
}: {
  item: TimelineItem;
  repoPath: string | null;
  active: boolean;
  issue: { id: string; symptom: string; evidence: string } | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const [open, setOpen] = useState(false);
  if (!isActivity(item)) return null;
  const detail = publicDetail(item.detail);
  if (item.title === "Agent" && detail) {
    return (
      <li>
        <AgentReply text={detail} repoPath={repoPath} onOpen={onOpen} />
      </li>
    );
  }
  const fileChange = /^(Added|Modified|Removed)\s+(.+)$/.exec(item.title);
  const mark = item.tone === "fail" ? "×" : item.tone === "ok" || item.tone === "change" ? "✓" : "·";
  const title = item.title === "Agent note" ? null : item.title === "Running command" ? "Running" : item.title;
  return (
    <li className="text-[13px] leading-5">
      <div className="flex gap-2">
        <span className={`w-3 shrink-0 ${markTone(item.tone, active)} ${active ? "prentice-live" : ""}`} aria-hidden="true">
          {mark}
        </span>
        <div className="min-w-0">
          {fileChange ? (
            <span>
              {fileChange[1]} <FileChip path={fileChange[2] ?? ""} repoPath={repoPath} onOpen={onOpen} />
              {detail ? (
                <span className="ml-1 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">{detail.startsWith("Confirmed from git") ? "git" : "agent"}</span>
              ) : null}
            </span>
          ) : title ? (
            <span>{title}</span>
          ) : null}
          {item.title === "Agent note" && detail ? <Note text={detail} repoPath={repoPath} onOpen={onOpen} /> : null}
          {item.title !== "Agent note" && detail && !issue && !fileChange ? (
            <span className="mt-1 block rounded-md bg-muted px-2 py-1 font-mono text-[11px] leading-5 break-all text-muted-foreground">{detail}</span>
          ) : null}
          {issue && item.tone === "fail" ? (
            <div className="mt-1">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                aria-expanded={open}
                onClick={() => setOpen((current) => !current)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && open) {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              >
                {open ? "Hide the record" : "Show what was recorded"}
              </button>
              {open ? (
                <div className="prentice-rise mt-2 border-l border-destructive/50 pl-3">
                  <p className="font-mono text-xs break-all text-muted-foreground">{issue.evidence}</p>
                  <p className="mt-1 text-xs text-muted-foreground">No cause was recorded. No fix was recorded.</p>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function LearningClose({
  task,
  repoPath,
  onOpen,
}: {
  task: TaskPayload;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const understand = task.understand;
  if (!understand) return null;
  const prose = understand.learning?.explanation || understand.learning?.message || "";
  const files = uniqueFiles(understand.observed.flatMap((claim) => claim.citations.map((citation) => citation.file).filter(Boolean) as string[]));
  if (!prose && files.length === 0) return null;
  return (
    <div className="prentice-rise border-l-2 border-primary pl-3">
      <p className="prentice-rule mb-1 h-px w-10 origin-left bg-primary" />
      <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Prentice</p>
      {prose ? <p className="mt-1 font-serif text-[16px] leading-7 text-pretty"><Rich text={prose} /></p> : null}
      {files.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {files.map((file) => (
            <FileChip key={file} path={file} repoPath={repoPath} onOpen={onOpen} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ExplainMoment({
  explain,
  repoPath,
  onOpen,
}: {
  explain: ExplainView;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const asking = (explain.phase === "asking" || explain.phase === "taught") && explain.current;
  const visible =
    Boolean(explain.learningMessage && explain.phase === "unavailable") ||
    Boolean(asking) ||
    explain.phase === "skipped" ||
    explain.feedback.understood.length > 0 ||
    (explain.discussion?.length ?? 0) > 0;
  if (!visible) return null;
  return (
    <div className="flex flex-col gap-3 border-l-2 border-primary/40 pl-3">
      {explain.learningMessage && explain.phase === "unavailable" ? (
        <p className="font-serif text-sm leading-relaxed text-pretty">{explain.learningMessage}</p>
      ) : null}
      {asking && explain.current ? (
        <div className="prentice-rise flex flex-col gap-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Prentice</p>
          <p className="font-serif text-[16px] leading-7 text-pretty">{explain.current.prompt}</p>
          {explain.current.grounding === "agent-stated" ? <p className="text-[11px] text-muted-foreground">From what the agent said</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {uniqueFiles((explain.current.citations ?? []).map((citation) => citation.file).filter(Boolean) as string[]).map((file) => (
              <FileChip key={file} path={file} repoPath={repoPath} onOpen={onOpen} />
            ))}
          </div>
          {explain.coach ? <p className="text-sm text-pretty">{explain.coach}</p> : null}
          {explain.hint ? (
            <p className="text-sm text-pretty text-muted-foreground">
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase">Hint. </span>
              {explain.hint}
            </p>
          ) : null}
          {explain.teaching ? (
            <div>
              <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">From the record</p>
              <p className="mt-1 font-serif text-sm leading-relaxed text-pretty">{explain.teaching}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {explain.phase === "skipped" ? <p className="text-sm text-muted-foreground">Skipped. You can keep building.</p> : null}
      {explain.feedback.understood.length > 0 ? (
        <div>
          <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">You can explain</p>
          <ul className="mt-1 flex flex-col gap-2">
            {explain.feedback.understood.map((item) => {
              const memory = remembered(item);
              return (
                <li key={item} className="text-sm">
                  <span className="text-success" aria-hidden="true">
                    ✓{" "}
                  </span>
                  {memory.title}
                  {memory.cite ? <span className="mt-0.5 block font-mono text-xs break-all text-muted-foreground">{memory.cite}</span> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
      {explain.discussion?.map((item) => (
        <div key={`${item.kind}:${item.question}`} className="prentice-rise flex flex-col gap-1">
          <p className="text-sm text-pretty text-muted-foreground">{item.question}</p>
          <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
            {item.kind === "general" ? "General" : item.kind === "observed" ? "About this change" : "Not in the record"}
          </p>
          <p className="font-serif text-sm leading-relaxed text-pretty">
            <Rich text={item.text} />
          </p>
        </div>
      ))}
    </div>
  );
}

function AgentReply({
  text,
  repoPath,
  onOpen,
}: {
  text: string;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const blocks = splitFenceBlocks(text);
  return (
    <div className="flex flex-col gap-2">
      <p className="font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Agent</p>
      <div className="text-[13.5px] leading-6">
        {blocks.map((block, index) =>
          block.kind === "code" ? (
            <pre key={index} className="my-1 overflow-x-auto rounded-md bg-muted px-3 py-2 font-mono text-[12px] leading-5">
              {block.text}
            </pre>
          ) : (
            <p key={index} className="whitespace-pre-wrap break-words">
              {splitNote(block.text).map((part, partIndex) =>
                part.kind === "file" ? (
                  <FileChip key={`${part.path}-${partIndex}`} path={part.path} repoPath={repoPath} onOpen={onOpen} />
                ) : (
                  <Rich key={partIndex} text={part.text} />
                ),
              )}
            </p>
          ),
        )}
      </div>
    </div>
  );
}

function splitFenceBlocks(text: string): Array<{ kind: "prose" | "code"; text: string }> {
  const blocks: Array<{ kind: "prose" | "code"; text: string }> = [];
  const pattern = /```[^\n]*\n?([\s\S]*?)```/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const prose = text.slice(cursor, index).trim();
    if (prose) blocks.push({ kind: "prose", text: prose });
    const code = (match[1] ?? "").replace(/\n$/, "");
    if (code.trim()) blocks.push({ kind: "code", text: code });
    cursor = index + match[0].length;
  }
  const rest = text.slice(cursor).trim();
  if (rest) blocks.push({ kind: "prose", text: rest });
  return blocks.length > 0 ? blocks : [{ kind: "prose", text }];
}

function Note({
  text,
  repoPath,
  onOpen,
}: {
  text: string;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const parts = splitNote(text);
  return (
    <p className="text-pretty break-words">
      {parts.map((part, index) =>
        part.kind === "file" ? (
          <FileChip key={`${part.path}-${index}`} path={part.path} repoPath={repoPath} onOpen={onOpen} />
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function FileChip({
  path,
  repoPath,
  onOpen,
}: {
  path: string;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const relative = repoRelative(path, repoPath);
  const name = relative.split("/").pop() || relative;
  return (
    <button
      type="button"
      className="mx-0.5 inline-flex max-w-full items-center rounded-md bg-muted px-1.5 py-0.5 align-baseline font-mono text-[11px] text-foreground transition-[background-color,color,transform] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:-translate-y-px hover:bg-primary/12 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-px"
      translate="no"
      onClick={() => onOpen(relative, "file")}
    >
      <span className="truncate">{name}</span>
    </button>
  );
}

function AgentChoices({
  providers,
  chosen,
  providerOverride,
  intensityOverride,
  useProviderMax,
  onProvider,
  onIntensity,
  onMax,
}: {
  providers: ProviderView[];
  chosen: ProviderView | undefined;
  providerOverride: string;
  intensityOverride: string;
  useProviderMax: boolean;
  onProvider: (value: string) => void;
  onIntensity: (value: string) => void;
  onMax: (value: boolean) => void;
}) {
  return (
    <div className="prentice-rise flex flex-col gap-2">
      <ToggleGroup value={providerOverride ? [providerOverride] : []} onValueChange={(value) => onProvider(value[value.length - 1] ?? "")} variant="outline" size="sm">
        {providers.map((provider) => (
          <ToggleGroupItem key={provider.id} value={provider.id}>
            {provider.capabilities.displayName}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <ToggleGroup value={intensityOverride ? [intensityOverride] : []} onValueChange={(value) => onIntensity(value[value.length - 1] ?? "")} variant="outline" size="sm">
        {INTENSITIES.map((intensity) => (
          <ToggleGroupItem key={intensity} value={intensity}>
            {labelIntensity(intensity)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {chosen?.capabilities.effortControl ? (
        <label className="flex items-start gap-2 text-xs text-muted-foreground">
          <Checkbox checked={useProviderMax} onCheckedChange={(checked) => onMax(checked === true)} />
          Use this provider&apos;s maximum effort. Prentice will not choose this on its own.
        </label>
      ) : null}
    </div>
  );
}

function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={index} className="font-mono text-[0.92em]">
          {part.slice(1, -1)}
        </code>
      );
    }
    return <span key={index}>{part}</span>;
  });
}

function splitNote(text: string): Array<{ kind: "text"; text: string } | { kind: "file"; path: string }> {
  const parts: Array<{ kind: "text"; text: string } | { kind: "file"; path: string }> = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: "text", text: text.slice(cursor, index) });
    parts.push({ kind: "file", path: match[2] ?? match[1] ?? "" });
    cursor = index + match[0].length;
  }
  if (cursor < text.length) parts.push({ kind: "text", text: text.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

const VENDOR_DETAIL = /vendor control|not auto-retried|sandboxing/i;
const VENDOR_STATUS = /is using |running locally|local agent/i;
const HIDDEN_ACTIVITY = /^(Session started|Explanation ready|Session completed|Agent)$/;

function isActivity(item: TimelineItem): boolean {
  if (HIDDEN_ACTIVITY.test(item.title) || item.title.startsWith("Explanation kept")) return false;
  if (VENDOR_STATUS.test(item.title)) return false;
  return true;
}

function markTone(tone: string, active: boolean): string {
  if (active || (tone !== "fail" && tone !== "ok" && tone !== "change")) return "text-primary";
  if (tone === "fail") return "text-destructive";
  return "text-success";
}

function publicDetail(detail?: string): string | undefined {
  if (!detail) return undefined;
  if (VENDOR_DETAIL.test(detail)) return undefined;
  if (detail.startsWith("The full text is kept")) return undefined;
  return detail;
}

function remembered(item: string): { title: string; cite?: string } {
  if (item.startsWith("/") || item.includes(" -lc ") || /\b(zsh|bash|rg|npm|git)\b/.test(item)) {
    return { title: "What that command did", cite: item };
  }
  if (/\.[a-z0-9]+$/i.test(item) || item.includes("/")) {
    const name = item.split("/").pop() ?? item;
    return { title: `What changed in ${name}`, cite: item === name ? undefined : item };
  }
  return { title: item };
}

function uniqueFiles(paths: string[]): string[] {
  return [...new Set(paths)];
}

function repoRelative(path: string, repoPath: string | null): string {
  const normalized = path.replaceAll("\\", "/");
  if (repoPath) {
    const root = repoPath.replaceAll("\\", "/").replace(/\/$/, "");
    if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  }
  if (normalized.startsWith("/")) return normalized.split("/").pop() ?? normalized;
  return normalized;
}

function providerName(providers: ProviderView[], task: TaskPayload | null): string {
  const id = task?.decision?.providerId || task?.providerId;
  return providers.find((provider) => provider.id === id)?.capabilities.displayName ?? "";
}

function labelIntensity(intensity: string): string {
  if (intensity === "fast") return "Fast";
  if (intensity === "balanced") return "Balanced";
  if (intensity === "deep") return "Deep";
  if (intensity === "maximum") return "Maximum";
  return intensity;
}
