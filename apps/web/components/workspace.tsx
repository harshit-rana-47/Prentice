"use client";

import { useEffect, useMemo, useState } from "react";
import { BookOpen, Files, GitCompare, Play, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { LearningPanel, LearningSidebar, type LearningStep } from "@/components/learning-panel";
import { CodeView, DiffView } from "@/components/code-view";
import {
  loadSession,
  readTaskStream,
  runtimeFetch,
  type DecisionView,
  type LocalSession,
  type ProviderView,
  type TaskPayload,
} from "@/lib/prentice";

type Activity = "explorer" | "search" | "changes" | "run" | "prentice";
type ChangeKind = "added" | "modified" | "deleted";

interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: TreeNode[];
}

interface WorkspaceSnapshot {
  project: { id: string; name: string; path: string };
  branch: string;
  changes: Array<{ path: string; change: ChangeKind }>;
  additions: number;
  deletions: number;
  tree: TreeNode[];
}

interface Tab {
  id: string;
  path: string;
  mode: "file" | "diff";
  title: string;
  body: string;
  binary?: boolean;
}

const INTENSITIES = ["fast", "balanced", "deep", "maximum"] as const;
const ACTIVITIES: Array<{ id: Activity; label: string; icon: typeof Files }> = [
  { id: "explorer", label: "Explorer", icon: Files },
  { id: "search", label: "Search", icon: Search },
  { id: "changes", label: "Source Control", icon: GitCompare },
  { id: "run", label: "Run / Tests", icon: Play },
  { id: "prentice", label: "Prentice", icon: BookOpen },
];

export function Workspace() {
  const [session, setSession] = useState<LocalSession | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [activity, setActivity] = useState<Activity>("explorer");
  const [workspace, setWorkspace] = useState<WorkspaceSnapshot | null>(null);
  const [providers, setProviders] = useState<ProviderView[]>([]);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [pathInput, setPathInput] = useState("");
  const [query, setQuery] = useState("");
  const [prompt, setPrompt] = useState("");
  const [task, setTask] = useState<TaskPayload | null>(null);
  const [providerOverride, setProviderOverride] = useState("");
  const [intensityOverride, setIntensityOverride] = useState("");
  const [useProviderMax, setUseProviderMax] = useState(false);
  const [changing, setChanging] = useState(false);
  const [consent, setConsent] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [panel, setPanel] = useState<"agent" | "prentice">("agent");
  const [learningStep, setLearningStep] = useState<LearningStep>("build");

  async function refresh(next = session) {
    if (!next) return;
    const [providerBody, snapshot] = await Promise.all([
      runtimeFetch<{ providers: ProviderView[] }>(next, "/v1/providers"),
      runtimeFetch<WorkspaceSnapshot>(next, "/v1/workspace").catch(() => null),
    ]);
    setProviders(providerBody.providers);
    setWorkspace(snapshot);
  }

  useEffect(() => {
    loadSession()
      .then(async (next) => {
        setSession(next);
        setOffline(null);
        await refresh(next);
      })
      .catch((reason: unknown) => setOffline(reason instanceof Error ? reason.message : "Runtime unavailable."));
  }, []);

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
    }, 1500);
    return () => clearInterval(timer);
  }, [session, task?.status]);

  useEffect(() => {
    if (!session || !task) return;
    const controller = new AbortController();
    void readTaskStream(session, task.id, setTask, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [session, task?.id]);

  useEffect(() => {
    if (!session || task?.status !== "completed") return;
    void refresh(session);
  }, [session, task?.status, task?.id]);

  const changes = useMemo(() => new Map(workspace?.changes.map((change) => [change.path, change.change]) ?? []), [workspace]);
  const files = useMemo(() => flatten(workspace?.tree ?? []), [workspace]);
  const decision = task?.decision ?? null;
  const selectedId = providerOverride || decision?.providerId || "";
  const selected = providers.find((provider) => provider.id === selectedId);
  const currentTab = tabs.find((tab) => tab.id === activeTab) ?? null;
  const running = task?.status === "running";

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
      const tab: Tab = { id, path, mode, title: `${fileName(path)} (diff)`, body: body.patch };
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

  return (
    <div className="grid h-dvh min-w-[880px] grid-cols-[44px_minmax(180px,220px)_minmax(0,1fr)_minmax(240px,320px)] grid-rows-[44px_minmax(0,1fr)_28px] overflow-hidden bg-background text-sm">
      <header className="col-span-4 flex items-center gap-4 border-b border-border px-3">
        <p className="font-serif text-base tracking-tight">Prentice</p>
        <span className="text-muted-foreground">{workspace?.project.name ?? "No project"}</span>
        <span className="text-muted-foreground">{workspace?.branch ?? ""}</span>
        <span className="text-muted-foreground">{selected ? providerLabel(selected) : "No agent"}</span>
        <span className="text-muted-foreground">{task ? statusLabel(task.status) : "Idle"}</span>
        <div className="relative ml-auto">
          <Button type="button" variant="ghost" size="sm" onClick={() => setAccountsOpen((open) => !open)}>
            Accounts
          </Button>
          {accountsOpen ? (
            <AccountMenu
              providers={providers}
              pending={pending}
              onConnect={(id) =>
                act(async () => {
                  await runtimeFetch(session!, `/v1/providers/${id}/connect`, { method: "POST" });
                  await refresh();
                })
              }
              onDisconnect={(id) =>
                act(async () => {
                  await runtimeFetch(session!, `/v1/providers/${id}`, { method: "DELETE" });
                  await refresh();
                })
              }
            />
          ) : null}
        </div>
      </header>

      <nav className="row-start-2 flex flex-col items-center gap-1 border-r border-border bg-sidebar py-2" aria-label="Activity">
        {ACTIVITIES.map((item) => {
          const Icon = item.icon;
          const selectedActivity = activity === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              title={item.label}
              className={`flex size-9 items-center justify-center rounded-md ${selectedActivity ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60"}`}
              onClick={() => {
                setActivity(item.id);
                if (item.id === "prentice") setPanel("prentice");
              }}
            >
              <Icon />
            </button>
          );
        })}
      </nav>

      <aside className="row-start-2 flex min-h-0 flex-col border-r border-border bg-sidebar">
        {activity === "explorer" ? (
            <Explorer
              workspace={workspace}
              changes={changes}
              pathInput={pathInput}
              onPathInput={setPathInput}
              onOpen={(path) => void act(() => openPath(path, "file"))}
              onOpenRepo={() =>
                act(async () => {
                  await runtimeFetch(session!, "/v1/project", { method: "POST", body: JSON.stringify({ path: pathInput }) });
                  setTabs([]);
                  setActiveTab(null);
                  setTask(null);
                  await refresh();
                })
              }
            />
        ) : null}
        {activity === "search" ? (
          <SearchPane
            query={query}
            onQuery={setQuery}
            files={files.filter((file) => file.toLowerCase().includes(query.trim().toLowerCase()))}
            onOpen={(path) => void act(() => openPath(path, "file"))}
          />
        ) : null}
          {activity === "changes" ? (
            <ChangesPane
              changes={workspace?.changes ?? []}
              additions={workspace?.additions ?? 0}
              deletions={workspace?.deletions ?? 0}
              onOpen={(path) => void act(() => openPath(path, "diff"))}
            />
          ) : null}
        {activity === "run" ? <RunPane task={task} /> : null}
        {activity === "prentice" ? (
          <LearningSidebar
            task={task}
            step={learningStep}
            onStep={(next) => {
              setLearningStep(next);
              setPanel("prentice");
            }}
          />
        ) : null}
      </aside>

      <main className="row-start-2 flex min-h-0 min-w-0 flex-col">
        <div className="flex h-9 shrink-0 items-end gap-1 overflow-x-auto border-b border-border px-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`mb-[-1px] flex h-8 items-center gap-2 rounded-t-md border border-b-0 px-3 text-xs ${tab.id === activeTab ? "border-border bg-background" : "border-transparent text-muted-foreground"}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.title}
              <span
                className="text-muted-foreground"
                onClick={(event) => {
                  event.stopPropagation();
                  setTabs((current) => current.filter((item) => item.id !== tab.id));
                  setActiveTab((current) => (current === tab.id ? null : current));
                }}
              >
                ×
              </span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1">
          {currentTab?.mode === "file" && !currentTab.binary ? <CodeView path={currentTab.path} value={currentTab.body} /> : null}
          {currentTab?.mode === "file" && currentTab.binary ? (
            <p className="p-6 text-sm text-muted-foreground">This file is binary or too large to show.</p>
          ) : null}
          {currentTab?.mode === "diff" ? <DiffView patch={currentTab.body} /> : null}
          {!currentTab ? (
            <div className="flex h-full items-center justify-center text-muted-foreground">
              {workspace ? "Open a file from the explorer." : "Open a repository to begin."}
            </div>
          ) : null}
        </div>
      </main>

      <section className="row-start-2 flex min-h-0 flex-col border-l border-border bg-card">
        <div className="flex border-b border-border">
          <button
            type="button"
            className={`px-4 py-2 text-xs ${panel === "agent" ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => setPanel("agent")}
          >
            Agent
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-xs ${panel === "prentice" ? "text-foreground" : "text-muted-foreground"}`}
            onClick={() => {
              setPanel("prentice");
              setActivity("prentice");
            }}
          >
            Prentice
          </button>
        </div>
        {panel === "prentice" ? (
          <LearningPanel
            task={task}
            session={session}
            step={learningStep}
            onStep={setLearningStep}
            onTask={setTask}
            onOpen={(path, mode) => void act(() => openPath(path, mode))}
            onReturn={() => setPanel("agent")}
            onError={setError}
          />
        ) : (
          <>
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs tracking-wide text-muted-foreground uppercase">Agent</p>
          <p className="mt-1 font-medium">{selected ? providerLabel(selected) : "Waiting for a task"}</p>
          <p className="text-xs text-muted-foreground">
            {selected?.id === "fixture"
              ? "Demo provider. No vendor call."
              : selected
                ? selected.connected
                  ? "Connected"
                  : "Not connected"
                : "Send a task and Prentice will choose an agent."}
          </p>
          {decision ? <p className="mt-2 text-xs text-muted-foreground">Execution: {labelIntensity(intensityOverride || decision.intensity)}</p> : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {task ? <p className="mb-3 text-sm">{task.prompt}</p> : <p className="text-sm text-muted-foreground">The task you send will stay here with the agent activity.</p>}
          <ol className="flex flex-col gap-2">
            {(task?.timeline ?? []).map((item, index, items) => (
              <li key={item.id} className="text-sm">
                <span className={item.tone === "fail" ? "text-destructive" : "text-primary"}>
                  {item.tone === "fail" ? "×" : item.tone === "ok" || item.tone === "change" ? "✓" : running && index === items.length - 1 ? "⟳" : "·"}
                </span>{" "}
                {item.title}
                {item.detail ? <span className="block pl-4 text-xs text-muted-foreground">{item.detail}</span> : null}
              </li>
            ))}
          </ol>
          {task?.status === "completed" && task.understand ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-4"
              onClick={() => {
                setLearningStep("understand");
                setPanel("prentice");
                setActivity("prentice");
              }}
            >
              Open Understand
            </Button>
          ) : null}
        </div>
        <div className="border-t border-border p-3">
          {decision && task?.status === "analyzed" ? (
            <RoutingCard
              decision={decision}
              providers={providers}
              changing={changing}
              providerOverride={providerOverride}
              intensityOverride={intensityOverride}
              useProviderMax={useProviderMax}
              consent={consent}
              pending={pending}
              onChanging={setChanging}
              onProvider={setProviderOverride}
              onIntensity={setIntensityOverride}
              onMax={setUseProviderMax}
              onConsent={setConsent}
              onUse={() =>
                act(async () => {
                  await runtimeFetch(session!, `/v1/tasks/${task.id}/start`, {
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
                  const next = await runtimeFetch<{ task: TaskPayload }>(session!, `/v1/tasks/${task.id}`);
                  setTask(next.task);
                })
              }
            />
          ) : null}
          <label className="mb-2 block text-xs text-muted-foreground" htmlFor="task-prompt">
            What do you want to build?
          </label>
          <Textarea
            id="task-prompt"
            value={prompt}
            disabled={running}
            placeholder="Add authentication using the existing session helpers…"
            onChange={(event) => setPrompt(event.target.value)}
            className="min-h-24 resize-none"
          />
          <div className="mt-2 flex items-center justify-end gap-2">
            {running ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => act(async () => runtimeFetch(session!, `/v1/tasks/${task!.id}/interrupt`, { method: "POST" }))}
              >
                Stop
              </Button>
            ) : null}
            <Button
              type="button"
              size="sm"
              disabled={!session || !workspace || prompt.trim().length === 0 || pending || running}
              onClick={() =>
                act(async () => {
                  const body = await runtimeFetch<{ task: TaskPayload }>(session!, "/v1/tasks/analyze", {
                    method: "POST",
                    body: JSON.stringify({ prompt }),
                  });
                  setTask(body.task);
                  setProviderOverride("");
                  setIntensityOverride("");
                  setUseProviderMax(false);
                  setConsent(false);
                  setChanging(false);
                })
              }
            >
              Send
            </Button>
          </div>
        </div>
          </>
        )}
      </section>

      <footer className="col-span-4 flex items-center gap-4 border-t border-border px-3 text-xs text-muted-foreground">
        <span>Git {workspace?.branch ?? "—"}</span>
        <span>Changes {workspace?.changes.length ?? 0}</span>
        <span>
          +{workspace?.additions ?? 0} -{workspace?.deletions ?? 0}
        </span>
        <span>Runtime {offline ? "offline" : session ? "local" : "…"}</span>
        <span>Agent {selected ? providerLabel(selected) : "—"}</span>
        {error || offline ? <span className="ml-auto text-destructive">{error || offline}</span> : null}
      </footer>
    </div>
  );
}

function Explorer({
  workspace,
  changes,
  pathInput,
  onPathInput,
  onOpen,
  onOpenRepo,
}: {
  workspace: WorkspaceSnapshot | null;
  changes: Map<string, ChangeKind>;
  pathInput: string;
  onPathInput: (value: string) => void;
  onOpen: (path: string) => void;
  onOpenRepo: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">Explorer</p>
      {workspace ? (
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
          <p className="px-2 py-1 text-xs font-medium">{workspace.project.name}</p>
          <Tree nodes={workspace.tree} changes={changes} onOpen={onOpen} />
        </div>
      ) : (
        <p className="px-3 pb-3 text-xs text-muted-foreground">No repository is open.</p>
      )}
      <div className="flex flex-col gap-2 border-t border-border p-3">
        <Input value={pathInput} placeholder="/absolute/path/to/repo" onChange={(event) => onPathInput(event.target.value)} />
        <Button type="button" size="sm" disabled={pathInput.trim().length === 0} onClick={onOpenRepo}>
          Open repository
        </Button>
      </div>
    </div>
  );
}

function Folder({
  node,
  depth,
  changes,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  changes: Map<string, ChangeKind>;
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth < 1);
  return (
    <div>
      <button
        type="button"
        className="flex w-full truncate py-0.5 pr-2 text-left text-xs hover:bg-sidebar-accent"
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="mr-1 text-muted-foreground">{open ? "▾" : "▸"}</span>
        {node.name}
      </button>
      {open ? <Tree nodes={node.children ?? []} changes={changes} onOpen={onOpen} depth={depth + 1} /> : null}
    </div>
  );
}

function Tree({ nodes, changes, onOpen, depth = 0 }: { nodes: TreeNode[]; changes: Map<string, ChangeKind>; onOpen: (path: string) => void; depth?: number }) {
  return (
    <ul>
      {nodes.map((node) => (
        <li key={node.path}>
          {node.kind === "dir" ? (
            <Folder node={node} depth={depth} changes={changes} onOpen={onOpen} />
          ) : (
            <button
              type="button"
              className="flex w-full items-center gap-2 truncate py-0.5 pr-2 text-left text-xs hover:bg-sidebar-accent"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onOpen(node.path)}
            >
              <span className="truncate">{node.name}</span>
              {changes.get(node.path) ? <ChangeMark kind={changes.get(node.path)!} /> : null}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function SearchPane({ query, onQuery, files, onOpen }: { query: string; onQuery: (value: string) => void; files: string[]; onOpen: (path: string) => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">Search</p>
      <div className="px-3">
        <Input value={query} placeholder="Filter by file name" onChange={(event) => onQuery(event.target.value)} />
      </div>
      <ul className="mt-2 min-h-0 flex-1 overflow-auto">
        {files.slice(0, 200).map((file) => (
          <li key={file}>
            <button type="button" className="w-full truncate px-3 py-1 text-left text-xs hover:bg-sidebar-accent" onClick={() => onOpen(file)}>
              {file}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ChangesPane({
  changes,
  additions,
  deletions,
  onOpen,
}: {
  changes: Array<{ path: string; change: ChangeKind }>;
  additions: number;
  deletions: number;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">Changes</p>
      <p className="px-3 pb-2 text-xs text-muted-foreground">
        {changes.length} {changes.length === 1 ? "file" : "files"} changed
        <span className="ml-2 text-emerald-400">+{additions}</span>
        <span className="ml-2 text-destructive">-{deletions}</span>
      </p>
      <ul className="min-h-0 flex-1 overflow-auto">
        {changes.map((change) => (
          <li key={change.path}>
            <button type="button" className="flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-sidebar-accent" onClick={() => onOpen(change.path)}>
              <span className="truncate">{change.path}</span>
              <ChangeMark kind={change.change} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RunPane({ task }: { task: TaskPayload | null }) {
  const commands = (task?.timeline ?? []).filter((item) => /command|test|npm |pnpm |pytest|vitest/i.test(`${item.title} ${item.detail ?? ""}`));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="px-3 py-2 text-[11px] tracking-wide text-muted-foreground uppercase">Run / Tests</p>
      {commands.length === 0 ? (
        <p className="px-3 text-xs text-muted-foreground">This task has not reported a command.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto px-3">
          {commands.map((item) => (
            <li key={item.id} className="py-1 text-xs">
              {item.title}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AccountMenu({
  providers,
  pending,
  onConnect,
  onDisconnect,
}: {
  providers: ProviderView[];
  pending: boolean;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
}) {
  return (
    <div className="absolute top-9 right-0 z-20 w-80 rounded-lg border border-border bg-popover p-3 shadow-lg">
      {providers.map((provider) => (
        <div key={provider.id} className="border-b border-border py-3 last:border-0">
          <div className="flex items-center justify-between gap-3">
            <p className="font-medium">{provider.capabilities.displayName}</p>
            <p className="text-xs text-muted-foreground">{provider.connected ? "● Connected" : "○ Not connected"}</p>
          </div>
          {provider.id === "fixture" ? <p className="mt-1 text-xs text-muted-foreground">Demo provider. Always local.</p> : null}
          {provider.login === "pending" ? <p className="mt-1 text-xs text-primary">{linkify(provider.message || "Opening the official sign-in page.")}</p> : null}
          {provider.login === "failed" ? <p className="mt-1 text-xs text-destructive">{provider.message}</p> : null}
          {provider.id === "fixture" ? null : (
            <div className="mt-2 flex gap-2">
              <Button type="button" size="sm" variant="outline" disabled={pending || provider.login === "pending"} onClick={() => onConnect(provider.id)}>
                {provider.connected ? "Reconnect" : "Connect account"}
              </Button>
              {provider.connected ? (
                <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => onDisconnect(provider.id)}>
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

function RoutingCard({
  decision,
  providers,
  changing,
  providerOverride,
  intensityOverride,
  useProviderMax,
  consent,
  pending,
  onChanging,
  onProvider,
  onIntensity,
  onMax,
  onConsent,
  onUse,
}: {
  decision: DecisionView;
  providers: ProviderView[];
  changing: boolean;
  providerOverride: string;
  intensityOverride: string;
  useProviderMax: boolean;
  consent: boolean;
  pending: boolean;
  onChanging: (value: boolean) => void;
  onProvider: (value: string) => void;
  onIntensity: (value: string) => void;
  onMax: (value: boolean) => void;
  onConsent: (value: boolean) => void;
  onUse: () => void;
}) {
  const chosen = providers.find((provider) => provider.id === (providerOverride || decision.providerId));
  const connected = providers.filter((provider) => provider.connected);
  return (
    <div className="mb-3 rounded-lg bg-muted/50 p-3">
      <p className="text-xs text-muted-foreground">Prentice chose</p>
      <p className="mt-1 font-medium">
        {chosen ? providerLabel(chosen) : decision.providerId} · {labelIntensity(intensityOverride || decision.intensity)}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{decision.why[0]}</p>
      <div className="mt-2 flex gap-2">
        <Button type="button" size="sm" disabled={!consent || pending} onClick={onUse}>
          Use
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => onChanging(!changing)}>
          Change
        </Button>
      </div>
      <label className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
        <Checkbox checked={consent} onCheckedChange={(checked) => onConsent(checked === true)} />
        This run may edit files and run commands in the open repository.
      </label>
      {changing ? (
        <div className="mt-3 flex flex-col gap-3">
          <ToggleGroup value={providerOverride ? [providerOverride] : []} onValueChange={(value) => onProvider(value[value.length - 1] ?? "")} variant="outline" size="sm">
            {connected.map((provider) => (
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
      ) : null}
    </div>
  );
}

function ChangeMark({ kind }: { kind: ChangeKind }) {
  const letter = kind === "added" ? "A" : kind === "modified" ? "M" : "D";
  const tone = kind === "added" ? "text-emerald-400" : kind === "modified" ? "text-primary" : "text-destructive";
  return <span className={`ml-auto font-mono text-[10px] ${tone}`}>{letter}</span>;
}

function providerLabel(provider: ProviderView): string {
  return provider.id === "fixture" ? "Fixture" : provider.capabilities.displayName;
}

function statusLabel(status: string): string {
  if (status === "analyzed") return "Ready";
  if (status === "running") return "Running";
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "interrupted") return "Stopped";
  return status;
}

function labelIntensity(intensity: string): string {
  return intensity.slice(0, 1).toUpperCase() + intensity.slice(1);
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function flatten(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") paths.push(node.path);
    else paths.push(...flatten(node.children ?? []));
  }
  return paths;
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
