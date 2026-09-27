"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Files, GitCompare, MessagesSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CodeView, DiffView } from "@/components/code-view";
import { Conversation } from "@/components/conversation";
import { ProjectPane, flatten, type WorkspaceSnapshot } from "@/components/project-pane";
import { ProjectNavigation, type LibraryProject } from "@/components/project-switcher";
import {
  loadSession,
  readTaskStream,
  runtimeFetch,
  type LocalSession,
  type ProviderView,
  type TaskPayload,
} from "@/lib/prentice";

type Activity = "explorer" | "search" | "changes";

interface ConversationSnapshot {
  task: TaskPayload | null;
  earlier?: TaskPayload[];
  conversations?: Array<{ id: string; title: string }>;
  selectedConversationId?: string | null;
}

interface Tab {
  id: string;
  path: string;
  mode: "file" | "diff";
  title: string;
  body: string;
  binary?: boolean;
}

const ACTIVITIES: Array<{ id: Activity; label: string; icon: typeof Files }> = [
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "changes", label: "Changes", icon: GitCompare },
];

export function Workspace({ connectionNotice = null }: { connectionNotice?: string | null }) {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity>("explorer");
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const accountsRef = useRef<HTMLDivElement>(null);
  const accountsButtonRef = useRef<HTMLButtonElement>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [chooseError, setChooseError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<TaskPayload | null>(null);
  const [earlier, setEarlier] = useState<TaskPayload[]>([]);
  const [library, setLibrary] = useState<LibraryProject[]>([]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const chatsButtonRef = useRef<HTMLButtonElement>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [paneOpen, setPaneOpen] = useState(false);
  const [linkDown, setLinkDown] = useState<string | null>(null);
  const desktop = useDesktop();
  const [providerOverride, setProviderOverride] = useState("");
  const [intensityOverride, setIntensityOverride] = useState("");
  const [useProviderMax, setUseProviderMax] = useState(false);
  const [changing, setChanging] = useState(false);
  const [separateConversation, setSeparateConversation] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const tabsRef = useRef<Tab[]>([]);
  const explainStarted = useRef(new Set<string>());
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [explainError, setExplainError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  tabsRef.current = tabs;

  async function refresh(next = session) {
    if (!next) return;
    const [providerBody, snapshot] = await Promise.all([
      runtimeFetch<{ providers: ProviderView[] }>(next, "/v1/providers"),
      runtimeFetch<WorkspaceSnapshot>(next, "/v1/workspace").catch(() => null),
    ]);
    setProviders(providerBody.providers);
    setWorkspace(snapshot);
  }

  async function loadLibrary(next: LocalSession) {
    const body = await runtimeFetch<{ projects: LibraryProject[] }>(next, "/v1/projects");
    setLibrary(body.projects);
  }

  async function restoreLatest(next: LocalSession) {
    const body = await runtimeFetch<ConversationSnapshot>(next, "/v1/tasks/latest");
    applyConversation(body);
    await loadLibrary(next);
  }

  function applyConversation(body: ConversationSnapshot) {
    setEarlier(body.earlier ?? []);
    setSelectedConversationId(body.selectedConversationId ?? null);
    if (!body.task) {
      setPrompt("");
      setTask(null);
      return;
    }
    setTask(body.task);
    setPrompt(body.task.status === "analyzed" ? body.task.prompt : "");
  }

  async function reloadOpenTabs(next: LocalSession) {
    const current = tabsRef.current;
    if (current.length === 0) return;
    const updated = await Promise.all(
      current.map(async (tab) => {
        try {
          if (tab.mode === "diff") {
            const body = await runtimeFetch<{ patch: string }>(next, `/v1/workspace/diff?path=${encodeURIComponent(tab.path)}`);
            return { ...tab, body: body.patch };
          }
          const body = await runtimeFetch<{ content: string; binary: boolean }>(next, `/v1/workspace/file?path=${encodeURIComponent(tab.path)}`);
          return { ...tab, body: body.binary ? "" : body.content, binary: body.binary };
        } catch {
          return tab;
        }
      }),
    );
    tabsRef.current = updated;
    setTabs(updated);
  }

  useEffect(() => {
    loadSession()
      .then(async (next) => {
        setSession(next);
        setOffline(null);
        await refresh(next);
        await restoreLatest(next);
      })
      .catch((reason: unknown) => setOffline(reason instanceof Error ? reason.message : "This computer is offline."));
  }, []);

  useEffect(() => {
    setPaneOpen(desktop);
  }, [desktop]);

  useEffect(() => {
    if (!accountsOpen) return;
    const root = accountsRef.current;
    const dialog = root?.querySelector("[role='dialog']");
    const preferred = confirmDisconnect
      ? dialog?.querySelector<HTMLElement>("[data-confirm-disconnect]")
      : dialog?.querySelector<HTMLElement>("button, a[href]");
    preferred?.focus();
    function onPointerDown(event: PointerEvent) {
      if (!root?.contains(event.target as Node)) {
        setAccountsOpen(false);
        setConfirmDisconnect(null);
      }
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Tab") {
        const dialog = root?.querySelector("[role='dialog']");
        const items = [...(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), a[href], input:not([disabled])") ?? [])];
        if (items.length === 0) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (confirmDisconnect) {
        setConfirmDisconnect(null);
        return;
      }
      setAccountsOpen(false);
      accountsButtonRef.current?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [accountsOpen, confirmDisconnect]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".prentice-project")) {
        if (!desktop && paneOpen) {
          event.preventDefault();
          setPaneOpen(false);
        }
        return;
      }
      const file = document.querySelector(".prentice-file[data-open='true']");
      const focusInFile = Boolean(target && file?.contains(target));
      if (file && activeTab && (!desktop || focusInFile)) {
        event.preventDefault();
        const remaining = tabsRef.current.filter((item) => item.id !== activeTab);
        setTabs(remaining);
        setActiveTab(remaining[0]?.id ?? null);
        if (!desktop && remaining.length === 0) document.getElementById("task-prompt")?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [desktop, paneOpen, activeTab]);

  useEffect(() => {
    if (!session || session.mode === "relay") return;
    let stop = false;
    const ping = () => {
      void fetch(`${session.runtimeUrl}/health`, { cache: "no-store" })
        .then((response) => {
          if (stop) return;
          setLinkDown(response.ok ? null : "This computer is offline.");
        })
        .catch(() => {
          if (!stop) setLinkDown("This computer is offline.");
        });
    };
    ping();
    const timer = setInterval(ping, 4000);
    return () => {
      stop = true;
      clearInterval(timer);
    };
  }, [session]);

  useEffect(() => {
    if (!session?.onReconnect) return;
    return session.onReconnect(() => {
      void restoreLatest(session);
      void refresh(session);
    });
  }, [session]);

  useEffect(() => {
    if (!session || !providers.some((provider) => provider.login === "pending")) return;
    const timer = setInterval(() => {
      void refresh(session);
    }, 1500);
    return () => clearInterval(timer);
  }, [session, providers]);

  useEffect(() => {
    if (!session || task?.status !== "running") return;
    const timer = setInterval(() => {
      void refresh(session);
      void reloadOpenTabs(session);
      void loadLibrary(session);
    }, 1500);
    return () => clearInterval(timer);
  }, [session, task?.status]);

  useEffect(() => {
    if (!session) return;
    const busy = library.some((project) => project.conversations.some((conversation) => conversation.running));
    if (!busy || task?.status === "running") return;
    const timer = setInterval(() => {
      void loadLibrary(session);
    }, 2000);
    return () => clearInterval(timer);
  }, [session, library, task?.status]);

  useEffect(() => {
    if (!session || !task) return;
    const taskId = task.id;
    const controller = new AbortController();
    void readTaskStream(session, taskId, (next) => {
      setTask((current) => (current?.id === taskId ? next : current));
    }, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof Error && error.name === "AbortError") return;
      setLinkDown("This computer is offline.");
    });
    return () => controller.abort();
  }, [session, task?.id]);

  useEffect(() => {
    if (!session || (task?.status !== "completed" && task?.status !== "failed")) return;
    void refresh(session);
    void reloadOpenTabs(session);
  }, [session, task?.status, task?.id]);

  useEffect(() => {
    if (!session || !task?.understand || task.explain) return;
    if (task.status !== "completed" && task.status !== "failed") return;
    if (explainStarted.current.has(task.id)) return;
    explainStarted.current.add(task.id);
    const taskId = task.id;
    setExplainError(null);
    void runtimeFetch(session, `/v1/tasks/${taskId}/explain-back`, { method: "POST", body: "{}" })
      .then(() => runtimeFetch<{ task: TaskPayload }>(session, `/v1/tasks/${taskId}`))
      .then((body) => setTask(body.task))
      .catch((reason: unknown) => {
        explainStarted.current.delete(taskId);
        const message = reason instanceof Error ? reason.message : "Explain-back failed.";
        setExplainError(message);
        setError(message);
      });
  }, [session, task?.id, task?.status, task?.understand, task?.explain]);

  const changes = useMemo(() => new Map(workspace?.changes.map((change) => [change.path, change.change]) ?? []), [workspace]);
  const files = useMemo(() => flatten(workspace?.tree ?? []), [workspace]);
  const currentTab = tabs.find((tab) => tab.id === activeTab) ?? null;
  const running = task?.status === "running";
  const connectionText = connectionNotice || linkDown || offline;
  const realAgent = providers.some((provider) => provider.connected && provider.id !== "fixture");
  const demoAgent = providers.some((provider) => provider.id === "fixture" && provider.connected);
  const needsAgent = Boolean(workspace) && !realAgent && !demoAgent;
  const canContinue = Boolean(
    task?.continuation?.available && !separateConversation && task.status !== "running" && task.status !== "analyzed",
  );
  const otherRun = library
    .find((project) => project.current)
    ?.conversations.find((conversation) => conversation.running && conversation.id !== selectedConversationId);
  const busyElsewhere = otherRun
    ? `An agent is working in “${otherRun.title}”. Wait for it to finish before sending here.`
    : null;

  async function chooseFolder() {
    if (!session) return;
    setChoosing(true);
    setChooseError(null);
    try {
      await runtimeFetch(session, "/v1/project/choose", { method: "POST", body: "{}" });
      setTabs([]);
      setActiveTab(null);
      setTask(null);
      setEarlier([]);
      setSelectedConversationId(null);
      setPrompt("");
      setSeparateConversation(false);
      setSwitcherOpen(false);
      await restoreLatest(session);
      await refresh(session);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "No folder was chosen.";
      if (!/no folder was chosen/i.test(message)) setChooseError(message);
    } finally {
      setChoosing(false);
    }
  }

  async function openPath(path: string, mode: "file" | "diff") {
    if (!session) return;
    const id = `${mode}:${path}`;
    const existing = tabs.find((tab) => tab.id === id);
    if (existing) {
      setActiveTab(id);
      return;
    }
    if (mode === "diff") {
      const body = await runtimeFetch<{ patch: string }>(session, `/v1/workspace/diff?path=${encodeURIComponent(path)}`);
      const tab: Tab = { id, path, mode, title: `${fileName(path)} diff`, body: body.patch };
      setTabs((current) => [...current, tab]);
    } else {
      const body = await runtimeFetch<{ content: string; binary: boolean }>(session, `/v1/workspace/file?path=${encodeURIComponent(path)}`);
      const tab: Tab = {
        id,
        path,
        mode,
        title: fileName(path),
        body: body.binary ? "" : body.content,
        binary: body.binary,
      };
      setTabs((current) => [...current, tab]);
    }
    setActiveTab(id);
  }

  async function openQuiet(path: string, mode: "file" | "diff") {
    setError(null);
    try {
      await openPath(path, mode);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open that file.");
    }
  }

  async function act(action: () => Promise<void>) {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Something went wrong.");
    } finally {
      setPending(false);
    }
  }

  async function sendPrompt() {
    if (!session || !workspace) throw new Error("Open a repository first.");
    const text = prompt.trim();
    if (!text) throw new Error("Write what the agent should do.");
    if (!separateConversation && task?.status === "analyzed" && text === task.prompt.trim()) {
      await startTask(task.id);
      await restoreLatest(session);
      return;
    }
    if (separateConversation || !task) {
      const analyzed = await runtimeFetch<{ task: TaskPayload }>(session, "/v1/tasks/analyze", {
        method: "POST",
        body: JSON.stringify({ prompt: text }),
      });
      setEarlier([]);
      setTask(analyzed.task);
      setSeparateConversation(false);
      await startTask(analyzed.task.id);
      await restoreLatest(session);
      return;
    }
    if (canContinue && task) {
      await runtimeFetch(session, `/v1/tasks/${task.id}/continue`, {
        method: "POST",
        body: JSON.stringify({ prompt: text, consent: true }),
      });
      setPrompt("");
      setSeparateConversation(false);
      await restoreLatest(session);
      return;
    }
    throw new Error(task.continuation?.message ?? "This conversation cannot be continued. Start a new one.");
  }

  async function startTask(taskId: string) {
    if (!session) return;
    const started = await runtimeFetch<{ task: TaskPayload }>(session, `/v1/tasks/${taskId}/start`, {
      method: "POST",
      body: JSON.stringify({
        consent: true,
        override: {
          providerId: providerOverride || undefined,
          intensity: intensityOverride || undefined,
          useProviderMax,
        },
      }),
    });
    setTask(started.task);
    setPrompt("");
    setSeparateConversation(false);
    setProviderOverride("");
    setIntensityOverride("");
    setUseProviderMax(false);
    setChanging(false);
  }

  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-hidden bg-sidebar text-[13.5px] leading-6">
      {connectionText ? (
        <p className="shrink-0 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-pretty text-destructive" role="status">
          {connectionText}
          {task ? " The open task stays here." : ""}
        </p>
      ) : null}
      <header className="relative z-40 flex h-11 shrink-0 items-center gap-3 border-b border-sidebar-border px-3">
        <h1 className="shrink-0 font-serif text-[17px] tracking-[-0.03em] text-balance" translate="no">
          Prentice
        </h1>
        <span className="min-w-0 truncate text-muted-foreground" translate="no">
          {workspace?.project.name ?? "No project"}
        </span>
        <span className="hidden shrink-0 font-mono text-[11px] tracking-wide text-muted-foreground sm:inline" translate="no">
          {workspace?.branch ?? ""}
        </span>
        <div className="relative ml-auto" ref={accountsRef}>
          <Button
            ref={accountsButtonRef}
            type="button"
            variant="ghost"
            size="sm"
            aria-expanded={accountsOpen}
            aria-haspopup="dialog"
            aria-controls="accounts-menu"
            onClick={() => setAccountsOpen((open) => !open)}
          >
            Accounts
          </Button>
          {accountsOpen ? (
            <div
              id="accounts-menu"
              role="dialog"
              aria-label="Accounts"
              className="prentice-rise absolute top-9 right-0 z-30 max-h-[min(24rem,70vh)] w-[min(20rem,calc(100vw-1.5rem))] origin-top-right overflow-auto overscroll-contain rounded-lg border border-border bg-popover p-3 shadow-[0_16px_40px_-20px_rgb(36_24_15/0.4)]"
            >
              <AccountMenu
                providers={providers}
                pending={pending}
                confirmDisconnect={confirmDisconnect}
                onConfirm={setConfirmDisconnect}
                onConnect={(id) =>
                  act(async () => {
                    await runtimeFetch(session!, `/v1/providers/${id}/connect`, { method: "POST" });
                    await refresh();
                  })
                }
                onDisconnect={(id) =>
                  act(async () => {
                    await runtimeFetch(session!, `/v1/providers/${id}`, { method: "DELETE" });
                    setConfirmDisconnect(null);
                    await refresh();
                  })
                }
              />
            </div>
          ) : null}
        </div>
      </header>

      <div className="prentice-body relative flex min-h-0 flex-1">
        <nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar py-2" aria-label="Project">
          <button
            ref={chatsButtonRef}
            type="button"
            aria-label="Projects and conversations"
            aria-expanded={switcherOpen}
            aria-controls="project-switcher"
            title="Projects and conversations"
            className={`flex size-9 items-center justify-center rounded-md transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-px ${switcherOpen ? "bg-sidebar-accent text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
            onClick={() => {
              setSwitcherOpen((open) => !open);
              if (!switcherOpen && session) void loadLibrary(session).catch(() => undefined);
            }}
          >
            <MessagesSquare aria-hidden="true" />
          </button>
          <div className="my-1 h-px w-5 bg-border" />
          {ACTIVITIES.map((item) => {
            const Icon = item.icon;
            const selectedActivity = activity === item.id;
            return (
              <button
                key={item.id}
                type="button"
                aria-label={item.label}
                aria-current={selectedActivity ? "page" : undefined}
                title={item.label}
                className={`flex size-9 items-center justify-center rounded-md transition-[background-color,color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-px ${selectedActivity && paneOpen ? "bg-sidebar-accent text-primary" : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"}`}
                onClick={() => {
                  if (activity === item.id) setPaneOpen((open) => !open);
                  else {
                    setActivity(item.id);
                    setPaneOpen(true);
                  }
                }}
              >
                <Icon aria-hidden="true" />
              </button>
            );
          })}
        </nav>

        {paneOpen ? (
          <button type="button" className="prentice-scrim" aria-label="Close panel" onClick={() => setPaneOpen(false)} />
        ) : null}
        <ProjectNavigation
          projects={library}
          open={switcherOpen}
          buttonRef={chatsButtonRef}
          onOpenChange={setSwitcherOpen}
          onSelectProject={(project) =>
            void act(async () => {
              await runtimeFetch(session!, "/v1/project", { method: "POST", body: JSON.stringify({ path: project.path }) });
              setTabs([]);
              setActiveTab(null);
              setTask(null);
              setEarlier([]);
              setSelectedConversationId(null);
              setPrompt("");
              setSeparateConversation(false);
              setSwitcherOpen(false);
              if (session) await restoreLatest(session);
              await refresh();
            })
          }
          onSelectConversation={(project, conversationId) =>
            void act(async () => {
              if (!project.current) {
                await runtimeFetch(session!, "/v1/project", { method: "POST", body: JSON.stringify({ path: project.path }) });
                setTabs([]);
                setActiveTab(null);
              }
              const body = await runtimeFetch<ConversationSnapshot>(session!, `/v1/conversations/${conversationId}/select`, {
                method: "POST",
                body: "{}",
              });
              applyConversation(body);
              setSeparateConversation(false);
              setSwitcherOpen(false);
              await loadLibrary(session!);
              if (!project.current) await refresh();
            })
          }
          onNewChat={() => {
            setSeparateConversation(true);
            setPrompt("");
            setSwitcherOpen(false);
            requestAnimationFrame(() => document.getElementById("task-prompt")?.focus());
          }}
          choosing={choosing}
          onChooseFolder={() => void act(chooseFolder)}
        />
        <ProjectPane
          open={paneOpen}
          activity={activity}
          workspace={workspace}
          changes={changes}
          files={files}
          query={query}
          onQuery={setQuery}
          onOpen={(path, mode) => void openQuiet(path, mode)}
        />

        <div className="prentice-stage flex min-h-0 min-w-0 flex-1">
        <main id="prentice-main" className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <Conversation
            task={task}
            earlier={earlier}
            providers={providers}
            disconnected={Boolean(connectionText)}
            repoPath={workspace?.project.path ?? null}
            prompt={prompt}
            pending={pending}
            running={running}
            separateConversation={separateConversation}
            canContinue={canContinue}
            busyElsewhere={busyElsewhere}
            providerOverride={providerOverride}
            intensityOverride={intensityOverride}
            useProviderMax={useProviderMax}
            changing={changing}
            onPrompt={setPrompt}
            onSend={() => void act(sendPrompt)}
            onStop={() => void act(async () => runtimeFetch(session!, `/v1/tasks/${task!.id}/interrupt`, { method: "POST" }))}
            onChanging={setChanging}
            onProvider={setProviderOverride}
            onIntensity={setIntensityOverride}
            onMax={setUseProviderMax}
            onOpen={(path, mode) => void openQuiet(path, mode)}
            explainError={explainError}
            onExplain={async (path, body) => {
              if (!session || !task) return;
              try {
                await runtimeFetch(session, path, { method: "POST", body: body ? JSON.stringify(body) : "{}" });
                const next = await runtimeFetch<{ task: TaskPayload }>(session, `/v1/tasks/${task.id}`);
                setTask(next.task);
              } catch (reason) {
                const message = reason instanceof Error ? reason.message : "Explain-back failed.";
                setError(message);
                throw reason;
              }
            }}
            onError={setError}
            hasProject={Boolean(workspace)}
            needsAgent={needsAgent}
            choosing={choosing}
            chooseError={chooseError}
            recentProjects={library.map((project) => ({ id: project.id, name: project.name }))}
            onChooseFolder={() => void act(chooseFolder)}
            onOpenProject={(id) => {
              const project = library.find((item) => item.id === id);
              if (project) {
                void act(async () => {
                  await runtimeFetch(session!, "/v1/project", { method: "POST", body: JSON.stringify({ path: project.path }) });
                  setTabs([]);
                  setActiveTab(null);
                  if (session) await restoreLatest(session);
                  await refresh();
                });
              }
            }}
            onOpenAccounts={() => setAccountsOpen(true)}
          />
        </main>

        <FilePane
          tab={currentTab}
          tabs={tabs}
          onSelect={setActiveTab}
          onClose={(id) => {
            const remaining = tabs.filter((item) => item.id !== id);
            setTabs(remaining);
            setActiveTab((current) => (current === id ? (remaining[0]?.id ?? null) : current));
          }}
        />
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-4 border-t border-sidebar-border px-3 font-mono text-[11px] tracking-wide text-muted-foreground tabular-nums">
        <span>Git {workspace?.branch ?? "—"}</span>
        <span>Changes {workspace?.changes.length ?? 0}</span>
        <span>
          <span className={(workspace?.additions ?? 0) > 0 ? "text-success" : ""}>+{workspace?.additions ?? 0}</span>{" "}
          <span className={(workspace?.deletions ?? 0) > 0 ? "text-destructive" : ""}>-{workspace?.deletions ?? 0}</span>
        </span>
        <span>{connectionText ? "Disconnected" : session ? "Connected" : "Connecting"}</span>
        <span className="ml-auto text-destructive" role="status" aria-live="polite">
          {error && error !== connectionText ? error : ""}
        </span>
      </footer>
    </div>
  );
}

function FilePane({
  tab,
  tabs,
  onSelect,
  onClose,
}: {
  tab: Tab | null;
  tabs: Tab[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  return (
    <aside
      data-open={tab ? "true" : "false"}
      className={`prentice-file flex min-h-0 shrink-0 flex-col overflow-hidden border-border ${tab ? "w-[min(440px,42%)] border-l opacity-100" : "w-0 border-l-0 opacity-0"}`}
      aria-hidden={tab ? undefined : true}
      inert={tab ? undefined : true}
      aria-readonly="true"
      aria-label="Read-only file"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2" role="tablist" aria-label="Open files">
        {tabs.map((item) => (
          <div key={item.id} className={`mb-[-1px] flex h-8 items-center rounded-t-md border border-b-0 ${item.id === tab?.id ? "border-border bg-card" : "border-transparent text-muted-foreground"}`}>
            <button
              type="button"
              role="tab"
              aria-selected={item.id === tab?.id}
              tabIndex={item.id === tab?.id ? 0 : -1}
              className="px-3 font-mono text-[11px] focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              translate="no"
              onClick={() => onSelect(item.id)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                event.preventDefault();
                const index = tabs.findIndex((entry) => entry.id === item.id);
                const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : (index - 1 + tabs.length) % tabs.length;
                const target = tabs[next];
                if (!target) return;
                onSelect(target.id);
                event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
              }}
            >
              {item.title}
            </button>
            <button
              type="button"
              className="pr-2 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              aria-label={`Close ${item.title}`}
              onClick={() => onClose(item.id)}
            >
              ×
            </button>
          </div>
        ))}
        <span className="ml-auto pr-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Read only</span>
      </div>
      <div className="prentice-code min-h-0 min-w-0 flex-1 overflow-hidden">
        {tab?.mode === "file" && !tab.binary ? <CodeView path={tab.path} value={tab.body} /> : null}
        {tab?.mode === "file" && tab.binary ? <p className="p-6 text-sm text-muted-foreground">This file is binary or too large to show.</p> : null}
        {tab?.mode === "diff" ? <DiffView patch={tab.body} /> : null}
      </div>
    </aside>
  );
}

function AccountMenu({
  providers,
  pending,
  confirmDisconnect,
  onConfirm,
  onConnect,
  onDisconnect,
}: {
  providers: ProviderView[];
  pending: boolean;
  confirmDisconnect: string | null;
  onConfirm: (id: string | null) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  return (
    <div>
      {providers.filter((provider) => provider.id !== "fixture").map((provider) => (
        <div key={provider.id} className="border-b border-border py-3 last:border-0">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium" translate="no">
              {provider.capabilities.displayName}
            </p>
            <p className="text-xs text-muted-foreground">{provider.connected ? "Connected" : "Not connected"}</p>
          </div>
          {provider.login === "pending" ? <p className="mt-1 text-xs text-primary">{linkify(provider.message || "Opening the official sign-in page.")}</p> : null}
          {provider.login === "failed" ? <p className="mt-1 text-xs text-destructive">{provider.message}</p> : null}
          {confirmDisconnect === provider.id ? (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-xs text-pretty">Disconnect {provider.capabilities.displayName} on this computer?</p>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="destructive" disabled={pending} data-confirm-disconnect onClick={() => onDisconnect(provider.id)}>
                  {pending ? "Disconnecting…" : "Disconnect"}
                </Button>
                <Button type="button" size="sm" variant="outline" onClick={() => onConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={pending || provider.login === "pending"} aria-busy={provider.login === "pending"} onClick={() => onConnect(provider.id)}>
                {provider.login === "pending" ? "Connecting…" : provider.connected ? "Reconnect" : "Connect Account"}
              </Button>
              {provider.connected ? (
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => onConfirm(provider.id)}>
                  Disconnect
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function useDesktop(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(min-width: 960px)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(min-width: 960px)").matches,
    () => true,
  );
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function linkify(message: string) {
  const url = message.match(/https:\/\/\S+/)?.[0];
  if (!url) return message;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="underline">
      {message}
    </a>
  );
}
