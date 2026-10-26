"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { DebugIssueView, ExplainView, LearningAction, ProviderView, TaskPayload, TimelineItem } from "@/lib/prentice";

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
  active = true,
  task,
  earlier,
  providers,
  prompt,
  pending,
  stopping = false,
  running,
  separateConversation,
  canContinue,
  busyElsewhere,
  disconnected,
  repoPath,
  activeFile,
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
  explainError,
  hasProject,
  needsAgent,
  choosing,
  chooseError,
  recentProjects,
  onChooseFolder,
  onOpenProject,
  onOpenAccounts,
  onSendAgain,
}: {
  active?: boolean;
  task: TaskPayload | null;
  earlier: TaskPayload[];
  providers: ProviderView[];
  prompt: string;
  pending: boolean;
  stopping?: boolean;
  running: boolean;
  separateConversation: boolean;
  canContinue: boolean;
  busyElsewhere: string | null;
  disconnected: boolean;
  repoPath: string | null;
  activeFile?: string;
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
  hasProject: boolean;
  needsAgent: boolean;
  choosing: boolean;
  chooseError: string | null;
  recentProjects: Array<{ id: string; name: string }>;
  onChooseFolder: () => void;
  onOpenProject: (id: string) => void;
  onOpenAccounts: () => void;
  /** Starts a new conversation with this prompt in the composer. Nothing runs until the person sends it. */
  onSendAgain?: (prompt: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const followLearningReply = useRef(false);
  const seenTask = useRef<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerError, setAnswerError] = useState<string | null>(null);
  const [learningChatTask, setLearningChatTask] = useState<string | null>(null);
  const askingPrentice = Boolean(task && learningChatTask === task.id);
  const explainRequest = useRef<{ taskId: string; text: string; id: string } | null>(null);
  const acknowledgedReplies = useRef(new Set<string>());
  const controlRequest = useRef<{key: string; id: string} | null>(null);
  const explainBusyRef = useRef(false);
  const [explainBusy, setExplainBusy] = useState(false);
  const wasRunning = useRef(false);

  const explain = task?.explain ?? null;
  useEffect(() => {
    for (const turn of explain?.turns ?? []) {
      if (turn.status === "replied" && turn.kind !== "unrecorded") acknowledgedReplies.current.add(turn.id);
    }
    const request = explainRequest.current;
    if (request?.taskId === task?.id && request && acknowledgedReplies.current.has(request.id)) {
      setAnswer(current => current.trim() === request.text ? "" : current);
      setAnswerError(null);
      explainRequest.current = null;
    }
    if (controlRequest.current && acknowledgedReplies.current.has(controlRequest.current.id)) {
      controlRequest.current = null;
      setAnswerError(null);
    }
  }, [task?.id, explain?.turns]);

  const asking = Boolean(explain && (explain.phase === "asking" || explain.phase === "taught") && explain.current);
  const agentName = providerName(providers, task);
  const connectedProviders = providers.filter((provider) => provider.connected && provider.id !== "fixture");
  const chosen = providers.find((provider) => provider.id === (providerOverride || task?.decision?.providerId || task?.providerId || ""));
  const showChange = (separateConversation || !task) && connectedProviders.length > 0;
  const sendBlocked = pending || running || Boolean(busyElsewhere);
  const unavailable = Boolean(task?.continuation && !task.continuation.available && task.status !== "running" && task.status !== "analyzed");
  const signature = `${earlier.map((item) => item.id).join(",")}:${task?.id ?? ""}:${task?.timeline.length ?? 0}:${explain?.phase ?? ""}:${explain?.discussion?.length ?? 0}:${explain?.turns?.length ?? 0}:${explain?.turns?.at(-1)?.status ?? ""}:${explain?.current?.id ?? ""}`;

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const id = task?.id ?? null;
    const changed = seenTask.current !== id;
    seenTask.current = id;
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (!changed && distance > 180 && !followLearningReply.current) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollTo({ top: node.scrollHeight, behavior: changed && !reduce ? "smooth" : "auto" });
    if (explain?.turns?.at(-1)?.status !== "pending") followLearningReply.current = false;
  }, [signature, task?.id, explain?.turns]);

  useEffect(() => {
    if (!separateConversation) return;
    document.getElementById("task-prompt")?.focus();
  }, [separateConversation]);

  useEffect(() => {
    if (!active || !asking || separateConversation) return;
    document.getElementById("explain-answer")?.focus();
  }, [active, asking, explain?.current?.id, separateConversation]);

  useEffect(() => {
    if (!active) return;
    if (askingPrentice) document.getElementById("explain-answer")?.focus();
    else if (hasProject && !asking) document.getElementById("task-prompt")?.focus();
  }, [active, hasProject, asking, askingPrentice]);

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
    if (explainBusyRef.current) throw new Error("Prentice is still replying.");
    explainBusyRef.current = true;
    followLearningReply.current = true;
    setExplainBusy(true);
    try {
      await onExplain(path, body);
    } catch (reason) {
      const messageId = body && typeof body === "object" && "messageId" in body ? body.messageId : null;
      if (typeof messageId === "string" && acknowledgedReplies.current.has(messageId)) return;
      followLearningReply.current = false;
      throw reason;
    } finally {
      explainBusyRef.current = false;
      setExplainBusy(false);
    }
  }

  function sendLearning(text: string) {
    if (!task) return Promise.reject(new Error("Open the learning conversation first."));
    setLearningChatTask(task.id);
    if (!explainRequest.current || explainRequest.current.taskId !== task.id || explainRequest.current.text !== text) {
      explainRequest.current = { taskId: task.id, text, id: crypto.randomUUID() };
    }
    return submitExplain(`/v1/tasks/${task.id}/explain-back/answer`, { answer: text, messageId: explainRequest.current.id }).then(() => {
      explainRequest.current = null;
    });
  }

  function chooseLearning(action: LearningAction, message: string, questionId?: string) {
    if (!task) return;
    setLearningChatTask(task.id);
    const key = `${task.id}:${explain?.current?.id ?? "done"}:${action}:${questionId ?? ""}`;
    if (controlRequest.current?.key !== key) controlRequest.current = {key, id: crypto.randomUUID()};
    setAnswerError(null);
    void submitExplain(`/v1/tasks/${task.id}/explain-back/answer`, {answer:message, action, questionId, messageId:controlRequest.current.id})
      .then(() => { controlRequest.current = null; })
      .catch(reason => setAnswerError(reason instanceof Error ? reason.message : "Your choice could not be sent. Try again."));
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="h-0.5 shrink-0" />
      <div ref={scroller} className="prentice-thread h-0 min-h-0 flex-1 overflow-auto overscroll-contain px-5 py-5">
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
                onSendAgain={onSendAgain}
                onRetryLearning={(turn) => void submitExplain(`/v1/tasks/${task.id}/explain-back/answer`, { answer: turn.message, messageId: turn.id, action: turn.action, questionId: turn.requestedQuestionId }).catch(reason => setAnswerError(reason instanceof Error ? reason.message : "Retry failed."))}
                learningBusy={explainBusy}
              />
            ) : null}
          </div>
        ) : (
          <div className="flex min-h-full items-end">
            <div className="max-w-lg pb-6">
              <h2 className="font-serif text-[2rem] leading-tight tracking-[-0.03em] text-balance">
                {disconnected ? "This computer is offline." : choosing ? "Opening the selected project…" : !hasProject ? "Choose a project folder" : needsAgent ? (agentMissing(providers) ? "Install a coding agent" : "Connect a coding agent") : "What should the agent work on?"}
              </h2>
              <p className="mt-2 text-sm text-pretty text-muted-foreground">
                {disconnected
                  ? "Your work stays on this computer and will show up when it is available."
                  : choosing
                    ? "Loading its files and saved conversations. Your project stays on this computer."
                    : !hasProject
                    ? "Prentice opens this computer's folder window. The project stays on this computer."
                    : needsAgent
                      ? agentMissing(providers)
                        ? "Install Codex, Claude Code, or Cursor on this computer, then connect it. That account does the writing."
                        : "Connect Codex, Claude Code, or Cursor on this computer. That account does the writing."
                      : "After the agent finishes, Prentice asks about the work in this same conversation."}
              </p>
              {!hasProject && !disconnected && recentProjects.length > 0 ? (
                <ul className="mt-4 flex flex-col gap-1">
                  {recentProjects.map((project) => (
                    <li key={project.id}>
                      <button
                        type="button"
                        className="rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        translate="no"
                        onClick={() => onOpenProject(project.id)}
                      >
                        {project.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
              {chooseError ? <p className="mt-3 text-sm text-destructive">{chooseError}</p> : null}
            </div>
          </div>
        )}
      </div>

      {!separateConversation && (asking || askingPrentice) && explain && task ? (
        <form className="prentice-rise prentice-composer shrink-0 border-t border-border px-5 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (explainBusyRef.current) return;
            const text = answer.trim();
            if (!text) { setAnswerError("Write a message first."); return; }
            setAnswerError(null);
            void sendLearning(text).then(() => setAnswer(current => current.trim() === text ? "" : current)).catch(reason => setAnswerError(reason instanceof Error ? reason.message : "Your message could not be sent. Try again."));
          }}>
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
            <label className="font-serif text-base leading-snug" htmlFor="explain-answer">Talk with Prentice</label>
            {explain.phase === "taught" ? <p className="text-sm text-muted-foreground">Keep exploring{explain.current?.concept ? ` ${explain.current.concept}` : " this concept"}. Ask a follow-up, try explaining it yourself, or move forward. Practice is optional.</p> : null}
            <Textarea id="explain-answer" name="explanation" autoComplete="off" value={answer} rows={3}
              placeholder={explain.phase === "taught" ? "Ask about the explanation, request an example, or share your reasoning…" : "Explain your reasoning, ask a question, or clarify an earlier answer…"}
              disabled={explainBusy} maxLength={8000} enterKeyHint="send"
              aria-invalid={answerError ? true : undefined} aria-describedby={answerError ? "explain-answer-error composer-hint" : "composer-hint"}
              aria-keyshortcuts="Enter" onChange={event => { setAnswer(event.target.value); setAnswerError(null); }}
              onKeyDown={event => enterSends(event, explainBusy || !answer.trim())}
              className="composer-text min-h-20 resize-none bg-background text-[13.5px] leading-6" />
            {answerError ? <p id="explain-answer-error" role="alert" className="text-xs text-destructive">{answerError}</p> : null}
            <p id="composer-hint" className="hidden text-[11px] text-muted-foreground [@media(pointer:fine)]:block">Enter to send. Shift+Enter for a new line.</p>
            <div className="flex flex-wrap items-center justify-end gap-2 [&_button]:min-h-11 sm:[&_button]:min-h-7">
              {explain.current && explain.phase === "taught" ? <Button type="button" size="sm" variant="outline" disabled={explainBusy}
                onClick={() => chooseLearning("practice", "I'd like to practise explaining this concept.")}>Practise explaining</Button> : null}
              {explain.current && explain.phase === "taught" && explain.hasNext !== false ? <Button type="button" size="sm" variant="ghost" disabled={explainBusy}
                onClick={() => chooseLearning("next", "Move to the next concept")}>Next concept</Button> : null}
              {explain.phase === "asking" && explain.policy.offerSkip ? <Button type="button" size="sm" variant="ghost" disabled={explainBusy}
                onClick={() => chooseLearning("skip", "Skip this question")}>Skip question</Button> : null}
              {asking ? <Button type="button" size="sm" variant="ghost" disabled={explainBusy}
                onClick={() => chooseLearning("finish", "Finish this learning session")}>Finish learning</Button> : null}
              {!asking && explain.topics?.length ? <select aria-label="Revisit a concept" value="" disabled={explainBusy}
                className="max-w-full rounded-md border border-border bg-background p-2 text-sm"
                onChange={event => { const topic = explain.topics?.find(item => item.id === event.target.value); if (topic) chooseLearning("revisit", `Revisit ${topic.title}`, topic.id); }}>
                <option value="" disabled>Revisit a concept…</option>
                {explain.topics.map(topic => <option key={topic.id} value={topic.id}>{topic.title}{topic.understood ? " (understood)" : ""}</option>)}
              </select> : null}
              {!asking ? <Button type="button" size="sm" variant="ghost" disabled={explainBusy} onClick={() => setLearningChatTask(null)}>Back to the agent</Button> : null}
              <Button type="submit" size="sm" disabled={explainBusy || !answer.trim()} aria-busy={explainBusy}>{explainBusy ? "Replying…" : "Reply"}</Button>
            </div>
          </div>
        </form>
      ) : !hasProject || (needsAgent && !running) ? (
        <div className="shrink-0 border-t border-border px-5 py-3">
          <div className="mx-auto flex w-full max-w-3xl justify-end">
            {!hasProject ? (
              <Button type="button" disabled={choosing || disconnected} onClick={onChooseFolder}>
                {choosing ? "Opening…" : "Choose Folder"}
              </Button>
            ) : (
              <Button type="button" onClick={onOpenAccounts}>
                {agentMissing(providers) ? "Install an agent" : "Connect an agent"}
              </Button>
            )}
          </div>
        </div>
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
            {activeFile ? <p className="mb-2 text-xs text-muted-foreground">Using open file: <span className="font-mono break-all">{activeFile}</span></p> : null}
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
              className="composer-text min-h-20 resize-none bg-background text-[13.5px] leading-6"
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
              {explain ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setLearningChatTask(task?.id ?? null)}>
                  Ask Prentice
                </Button>
              ) : null}
              {running ? (
                <Button type="button" size="sm" variant="outline" disabled={stopping} aria-busy={stopping} onClick={onStop}>
                  {stopping ? "Stopping…" : "Stop"}
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
  onSendAgain,
  onRetryLearning,
  learningBusy = false,
}: {
  task: TaskPayload;
  providers: ProviderView[];
  repoPath: string | null;
  live: boolean;
  running?: boolean;
  explainError?: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
  onSendAgain?: (prompt: string) => void;
  onRetryLearning?: (turn: NonNullable<ExplainView["turns"]>[number]) => void;
  learningBusy?: boolean;
}) {
  const name = providerName(providers, task);
  const intensity = task.decision ? labelIntensity(task.decision.intensity) : null;
  const explain = task.explain;
  const waiting = live && Boolean(task.understand) && !task.understand?.learning?.pending && !explain && (task.status === "completed" || task.status === "failed" || task.status === "interrupted");
  const messages = task.timeline.filter(item => (item.title === "Agent" && item.detail?.trim()) || isActivity(item));
  const changedFiles = task.timeline.filter(item => item.tone === "change" && item.detail?.startsWith("Confirmed from git"));
  return (
    <section id={`turn-${task.id}`} tabIndex={-1} data-task-status={task.status} className={live ? "prentice-turn prentice-rise flex flex-col gap-3" : "prentice-turn flex flex-col gap-3"}>
      <p className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-card px-3.5 py-2 text-[13.5px] leading-6 text-pretty break-words shadow-[0_1px_0_rgb(36_24_15/0.04),0_8px_16px_-12px_rgb(36_24_15/0.28)]">{task.prompt}</p>
      {name ? (
        <p className="font-mono text-[11px] tracking-wide text-muted-foreground" translate="no">
          {name}
          {intensity ? ` · ${intensity}` : ""}
        </p>
      ) : null}
      {messages.map(item => item.title === "Agent" ? (
        <AgentReply key={item.id} text={item.detail ?? ""} repoPath={repoPath} onOpen={onOpen} />
      ) : (
        <ol key={item.id}><TimelineRow item={item} repoPath={repoPath} active={false} issue={task.issues.find(entry => entry.id === item.id) ?? null} onOpen={onOpen} /></ol>
      ))}
      {running ? <div role="status" aria-label="Agent is working" className="flex items-center gap-2 text-xs text-muted-foreground"><span className="prentice-live inline-block size-2 rounded-full bg-primary" aria-hidden="true" /><span className="sr-only">Agent is working</span></div> : null}
      {!running && changedFiles.length > 0 ? (
        <div aria-label="Files changed" className="flex flex-col gap-2">
          <p className="text-xs text-muted-foreground">{changedFiles.length} {changedFiles.length === 1 ? "file" : "files"} changed</p>
          <div className="flex flex-wrap gap-2">{changedFiles.map(item => <FileChip key={item.id} path={item.title.replace(/^(Added|Modified|Removed)\s+/, "")} repoPath={repoPath} onOpen={onOpen} />)}</div>
        </div>
      ) : null}
      {task.error && !messages.some(item => item.tone === "fail") ? <p role="alert" className="text-sm text-destructive">{task.error.message}</p> : null}
      {live && task.recovery ? (
        <div className="flex flex-col gap-2 border-l-2 border-border pl-3" role="status">
          <p className="text-sm text-pretty text-muted-foreground">{task.recovery.message}</p>
          {onSendAgain ? (
            <div>
              <Button type="button" size="sm" variant="outline" onClick={() => onSendAgain(task.recovery!.prompt)}>
                Send Again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {task.status === "interrupted" ? <p className="font-mono text-[11px] text-muted-foreground">Interrupted · confirmed partial work</p> : null}
      <LearningClose task={task} />
      {waiting ? (
        <p className="font-serif text-sm text-pretty text-muted-foreground">{explainError ?? "Prentice is reading this change…"}</p>
      ) : null}
      {explain ? <ExplainMoment explain={explain} repoPath={repoPath} onOpen={onOpen} onRetry={onRetryLearning} busy={learningBusy} /> : null}
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
  issue: DebugIssueView | null;
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
    <li className={`activity-row text-[13px] leading-5 ${item.tone === "fail" ? "activity-failed" : ""}`}>
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
                  {issue.output ? (
                    <div className="mt-2">
                      <p className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                        Command output{issue.output.truncated ? " · last lines only" : ""}
                      </p>
                      <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-[11px] leading-5 whitespace-pre-wrap break-all text-muted-foreground">
                        {issue.output.text}
                      </pre>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-muted-foreground">No command output was recorded.</p>
                  )}
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

function LearningClose({ task }: { task: TaskPayload }) {
  const understand = task.understand;
  if (!understand) return null;
  const concepts = understand.learning?.concepts ?? [];
  const limits = understand.insufficientEvidence.filter(line => /interrupted|attribution|no file changes/i.test(line));
  const observed = understand.observed.filter(claim => !/^(Added|Removed|Updated) (function|method|class|other) /i.test(claim.text));
  return (
    <div className="learning-moment prentice-rise border-l-2 border-primary pl-3">
      <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Understand</p>
      {concepts.length > 0 ? <p className="mt-2 text-xs text-muted-foreground">Prentice interpretation · open the evidence to see what was verified and what the agent reported.</p> : null}
      {understand.learning?.pending ? <p role="status" className="mt-2 text-sm text-muted-foreground">Preparing the concept lesson…</p> : null}
      {concepts.length ? <div className="mt-3 flex flex-col gap-6">{concepts.map(concept => (
        <article key={concept.title} className="flex flex-col gap-2">
          <h3 className="font-serif text-lg leading-snug">{concept.title}</h3>
          {concept.support ? <p className="text-xs text-muted-foreground">{concept.support.kind === "source-backed" ? "Source-backed general teaching · project application unverified" : "Provisional teaching · source coverage incomplete"}</p> : null}
          <p className="text-sm leading-6 text-pretty">{concept.explanation}</p>
          <p className="text-sm leading-6 text-pretty"><span className="font-medium">How it works. </span>{concept.mechanism}</p>
          <p className="text-sm leading-6 text-pretty"><span className="font-medium">Trade-off. </span>{concept.tradeoff}</p>
          <p className="text-sm leading-6 text-pretty"><span className="font-medium">Think it through. </span><Rich text={concept.transfer} /></p>
          <details className="text-xs text-muted-foreground">
            <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">What this lesson is based on</summary>
            {concept.basis.map(item => <p key={item.id} className="mb-2 whitespace-pre-wrap break-words"><span className="font-medium">{item.kind === "observed" ? "Observed" : "Agent stated"}: </span>{item.text}</p>)}
          </details>
        </article>
      ))}</div> : !understand.learning?.pending ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{understand.learning?.available ? "There is not enough evidence for a useful concept lesson yet." : understand.learning?.message ?? "Concept lessons are unavailable for this saved turn."}</p> : null}
      {limits.map(line => <p key={line} className="mt-2 text-sm text-muted-foreground">{line}</p>)}
      <details className="mt-2 text-sm text-muted-foreground">
        <summary className="min-h-11 cursor-pointer py-3 focus-visible:outline-2 focus-visible:outline-ring">Recorded evidence</summary>
        <p className="mb-2 text-xs">These observations establish changes and recorded outcomes. They do not prove the agent&apos;s claims about behavior.</p>
        {observed.map((claim, index) => <p key={index} className="mb-1 break-words"><span className="font-medium">Observed: </span><Rich text={claim.text} /></p>)}
        {understand.agentStated.map((claim, index) => <p key={index} className="mb-1 break-words"><span className="font-medium">Agent stated: </span><Rich text={claim.text} /></p>)}
      </details>
    </div>
  );
}

function ExplainMoment({
  explain,
  repoPath,
  onOpen,
  onRetry,
  busy,
}: {
  explain: ExplainView;
  onRetry?: (turn: NonNullable<ExplainView["turns"]>[number]) => void;
  busy?: boolean;
  repoPath: string | null;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  const asking = (explain.phase === "asking" || explain.phase === "taught") && explain.current;
  const visible =
    Boolean(explain.learningMessage) || Boolean(explain.turns?.length) ||
    Boolean(asking) ||
    explain.phase === "skipped" ||
    explain.feedback.understood.length > 0 ||
    explain.feedback.unclear.length > 0 ||
    Boolean(explain.phase === "done" && explain.unpractised?.length) ||
    (explain.discussion?.length ?? 0) > 0;
  if (!visible) return null;
  return (
    <div className="flex flex-col gap-3 border-l-2 border-primary/40 pl-3">
      {explain.turns?.map((turn, index, turns) => (
        <article key={turn.id} className="flex flex-col gap-2">
          {turn.prompt && (index === 0 || turn.questionId !== turns[index - 1]?.questionId) ? <p className="font-serif text-sm text-muted-foreground">{turn.prompt}</p> : null}
          <p className="font-mono text-[10px] tracking-wide text-muted-foreground uppercase">You</p>
          <p className="whitespace-pre-wrap break-words text-sm">{turn.message}</p>
          <p className="font-mono text-[10px] tracking-wide text-primary uppercase">Prentice · Interpretation{turn.support ? turn.support.kind === "source-backed" ? " · General sources" : " · Provisional" : ""}</p>
          {turn.status === "pending" ? <p role="status" className="text-sm text-muted-foreground">Waiting for Prentice’s reply…</p> : <p className="whitespace-pre-wrap break-words font-serif text-sm leading-relaxed"><Rich text={turn.response ?? ""} /></p>}
          {turn.hint && turn.hint.trim() !== turn.response?.trim() ? <p className="whitespace-pre-wrap text-sm text-muted-foreground">Hint: <Rich text={turn.hint} /></p> : null}
          {turn.teaching ? <div><p className="text-xs font-medium">Revisit the concept</p><p className="mt-1 font-serif text-sm leading-relaxed">{turn.teaching}</p></div> : null}
          {turn.status !== "replied" && onRetry ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => onRetry(turn)}>Retry reply</Button> : null}
        </article>
      ))}

      {explain.learningMessage ? (
        <p role="status" className="font-serif text-sm leading-relaxed text-pretty">{explain.learningMessage}</p>
      ) : null}
      {asking && explain.current && explain.turns?.at(-1)?.questionId !== explain.current.id ? (
        <div className="prentice-rise flex flex-col gap-2">
          <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">Prentice</p>
          <p className="font-serif text-[16px] leading-7 text-pretty">{explain.current.prompt}</p>
          {explain.current.grounding === "inference" && explain.phase === "asking" ? <p className="text-xs text-muted-foreground">Explain the reasoning in your own words, or ask for help. {explain.current.assessmentEligible ? 'Understanding is recorded when the maintained criteria can be assessed reliably; otherwise feedback stays provisional.' : 'Feedback on this question is provisional.'}</p> : null}
          {explain.current.grounding === "agent-stated" ? <p className="text-[11px] text-muted-foreground">From what the agent said</p> : null}
          <div className="flex flex-wrap gap-1.5">
            {uniqueFiles((explain.current.citations ?? []).map((citation) => citation.file).filter(Boolean) as string[]).map((file) => (
              <FileChip key={file} path={file} repoPath={repoPath} onOpen={onOpen} />
            ))}
          </div>
          {!explain.turns?.length && explain.coach ? <p className="text-sm text-pretty">{explain.coach}</p> : null}
          {!explain.turns?.length && explain.hint ? (
            <p className="text-sm text-pretty text-muted-foreground">
              <span className="font-mono text-[10px] tracking-[0.16em] uppercase">Hint. </span>
              {explain.hint}
            </p>
          ) : null}
          {!explain.turns?.length && explain.teaching ? (
            <div>
              <p className="font-mono text-[10px] tracking-[0.16em] text-primary uppercase">{explain.current.grounding === "inference" ? "Revisit the concept" : "From the record"}</p>
              <p className="mt-1 font-serif text-sm leading-relaxed text-pretty">{explain.teaching}</p>
            </div>
          ) : null}
        </div>
      ) : null}
      {explain.feedback.unclear.length > 0 && explain.phase === "done" ? <p className="text-sm text-muted-foreground">Keep practicing: {explain.feedback.unclear.join(", ")}. These concepts are not marked as understood.</p> : null}
      {explain.phase === "done" && explain.unpractised?.length ? <p className="text-sm text-muted-foreground">Not yet practised: {explain.unpractised.join(", ")}. Teaching and moving on do not establish understanding.</p> : null}
      {explain.practisedProvisionally?.length ? <p className="text-sm text-muted-foreground">Practised with provisional feedback: {explain.practisedProvisionally.join(", ")}. These are not marked as demonstrated understanding.</p> : null}
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
            {item.kind === "inference" ? "Interpretation (Learning AI)" : item.kind === "general"
              ? "General"
              : item.kind === "observed"
                ? "About this change"
                : item.kind === "agent-stated"
                  ? "The agent said"
                  : "Not in the record"}
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
  const parts = text.split(/(\[[^\]]+\]\(https:\/\/[^\s)]+\)|\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, index) => {
    const link = /^\[([^\]]+)\]\((https:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-ring">{link[1]}</a>;
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

function isActivity(item: TimelineItem): boolean {
  return item.tone === "fail" || (item.title === "Command outcome unavailable");
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

function agentMissing(providers: ProviderView[]): boolean {
  const agents = providers.filter((provider) => provider.id !== "fixture");
  return agents.length > 0 && agents.every((provider) => provider.installed === false);
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
