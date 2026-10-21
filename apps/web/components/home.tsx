"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, ArrowUpRight, BookOpen, ChevronLeft, ChevronRight, FolderPlus, Pin, Search, X } from "lucide-react";
import type { HomeSnapshot, JournalEntry, SyncPayload } from "@prentice/protocol";
import { runtimeFetch, type LocalSession, type ProviderView } from "@/lib/prentice";
import type { LibraryProject } from "@/components/project-switcher";
import type { WorkspaceSnapshot } from "@/components/project-pane";
import { Button } from "@/components/ui/button";

export const agentLabel = (id: string | null) => ({ codex: "Codex", "claude-code": "Claude Code", cursor: "Cursor", fixture: "Development fixture" })[id ?? ""] ?? "Agent not recorded";
export function activityDate(at: string) { return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }); }

export function Home({ active = true, session, library, providers, workspace, computerName, disconnected, refreshKey, searchRequest, cloudOverview, onOpen, onChoose, onLinkCloud, choosing, chooseError = null, onAgents }: {
  active?: boolean;
  session: LocalSession | null; library: LibraryProject[]; providers: ProviderView[]; workspace: WorkspaceSnapshot | null;
  computerName: string | null; disconnected: boolean; refreshKey: string; searchRequest: string;
  cloudOverview?: SyncPayload | null;
  onOpen: (projectId: string, conversationId?: string, taskId?: string) => void;
  onChoose: () => void; onLinkCloud?: (projectId: string) => void; choosing: boolean; chooseError?: string | null; onAgents: () => void;
}) {
  const [data, setData] = useState<HomeSnapshot | null>(null);
  const [search, setSearch] = useState({ request: searchRequest, value: searchRequest });
  const query = search.request === searchRequest ? search.value : searchRequest;
  const [day, setDay] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "learning" | "debug" | "interrupted">("all");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pinning, setPinning] = useState<string | null>(null);
  const [showAllConversations, setShowAllConversations] = useState(false);
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [visit, setVisit] = useState<{ at: string | null; completed: number; interrupted: number } | null>(null);
  const visited = useRef(false);
  const request = useRef(0);
  const [reload, setReload] = useState(0);
  const understoodCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of cloudOverview?.concepts ?? []) if (item.state === "understood") counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
    return counts;
  }, [cloudOverview]);
  useEffect(() => { if (searchRequest) document.getElementById("journal-search")?.focus(); }, [searchRequest]);
  useEffect(() => {
    if (!active || !session || disconnected) return;
    const generation = ++request.current;
    const timer = setTimeout(() => {
      setLoading(true);
      void runtimeFetch<HomeSnapshot>(session, "/v1/home", { method: "POST", body: JSON.stringify({ query, category: filter, day: day ?? undefined, offset: 0 }) })
        .then(next => {
          if (generation !== request.current) return;
          setData(next); setError(null);
          if (!visited.current) {
            visited.current = true;
            setVisit({ at: next.lastVisit, ...next.since });
            void runtimeFetch(session, "/v1/home/visit", { method: "POST" }).catch(() => { visited.current = false; });
          }
        }).catch(reason => { if (generation === request.current) setError(reason instanceof Error ? reason.message : "Could not load your journal."); })
        .finally(() => { if (generation === request.current) setLoading(false); });
    }, query ? 180 : 0);
    return () => { clearTimeout(timer); request.current = generation + 1; };
  }, [active, session, disconnected, query, day, filter, refreshKey, reload]);
  async function loadMore() {
    if (!session || data?.nextOffset == null) return;
    const generation = request.current;
    setLoading(true);
    try {
      const next = await runtimeFetch<HomeSnapshot>(session, "/v1/home", { method: "POST", body: JSON.stringify({ query, category: filter, day: day ?? undefined, offset: data.nextOffset }) });
      if (generation === request.current) setData(current => current ? { ...next, entries: [...current.entries, ...next.entries] } : next);
    } catch (reason) { if (generation === request.current) setError(reason instanceof Error ? reason.message : "Could not load more activity."); }
    finally { if (generation === request.current) setLoading(false); }
  }
  async function pin(kind: "project" | "conversation", id: string) {
    if (!session || !data) return;
    const key = `${kind}:${id}`; setPinning(key);
    try {
      const result = await runtimeFetch<{ pins: string[] }>(session, "/v1/home/pin", { method: "POST", body: JSON.stringify({ kind, id, pinned: !data.pins.includes(key) }) });
      setData(current => current ? { ...current, pins: result.pins } : current);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not update the pin."); }
    finally { setPinning(null); }
  }
  const open = (entry: JournalEntry) => onOpen(entry.projectId, entry.conversationId, entry.id);
  const visible = data?.entries ?? [];
  const projectName = (id: string) => data?.projects.find(project => project.id === id)?.name ?? library.find(project => project.id === id)?.name ?? "Project";
  const conversations = useMemo(() => library.flatMap(project => project.conversations.map(conversation => ({ ...conversation, project }))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [library]);
  const sortedConversations = [...conversations].sort((a, b) => Number(data?.pins.includes(`conversation:${b.id}`)) - Number(data?.pins.includes(`conversation:${a.id}`)));
  const orderedProjects = [...(data?.projects ?? [])].sort((a,b) => Number(data?.pins.includes(`project:${b.id}`)) - Number(data?.pins.includes(`project:${a.id}`)));
  const latest = data?.latest;
  const pinButton = (kind: "project" | "conversation", id: string, name: string) => <button className={`pin-button ${data?.pins.includes(`${kind}:${id}`) ? "is-pinned" : ""}`} aria-label={`${data?.pins.includes(`${kind}:${id}`) ? "Unpin" : "Pin"} ${name}`} aria-pressed={data?.pins.includes(`${kind}:${id}`) ?? false} disabled={disconnected || pinning !== null} onClick={() => void pin(kind, id)}><Pin size={15} aria-hidden="true" /></button>;
  return <main id={active ? "prentice-main" : undefined} hidden={!active} style={!active ? { display: "none" } : undefined} className="home-view" aria-busy={loading}>
    <div className="home-content">
      <header className="home-heading"><div><p className="eyebrow">Your work, with a little perspective</p><h1>Back to <em>building.</em></h1></div><button className="secondary-action" aria-label="Open a project" disabled={!session || disconnected || choosing} onClick={onChoose}><FolderPlus size={16} aria-hidden="true" /> {choosing ? "Opening folder window…" : "Open a project"}</button></header>
      <div className="home-status"><span className={`status-dot ${disconnected ? "is-offline" : ""}`} /><span>{computerName ?? "This computer"} · {disconnected ? "Disconnected · showing last loaded records" : session ? "Connected" : "Connecting…"}</span><button onClick={onAgents}>{providers.length ? `${providers.filter(provider => provider.connected && provider.id !== "fixture").length} agents connected` : "Checking coding agents…"} <ArrowUpRight size={12} aria-hidden="true" /></button></div>
      {cloudOverview?.projects.length ? <section className="rounded-2xl border border-border bg-background p-5"><h2 className="font-serif text-2xl">Across your computers</h2><p className="mt-1 text-sm text-muted-foreground">Account summaries may lag local work until its connector synchronizes. Select a local checkout before coding.</p><div className="mt-3 grid gap-3 sm:grid-cols-2">{cloudOverview.projects.map(project => <div key={project.id} className="rounded-xl border border-border p-3"><strong>{project.displayName}</strong><p className="text-xs text-muted-foreground">Last activity {activityDate(project.lastActiveAt)} · {understoodCounts.get(project.id) ?? 0} concepts understood</p><button type="button" className="mt-2 underline" disabled={disconnected || choosing} onClick={() => onLinkCloud?.(project.id)}>Link local checkout</button></div>)}</div></section> : null}
      {chooseError ? <p className="home-error" role="alert">{chooseError}</p> : null}
      {error ? <div className="home-error" role="alert">{error}<Button size="sm" variant="outline" onClick={() => setReload(value => value + 1)}>Try again</Button></div> : null}
      {!data ? <div className="home-loading" role="status"><BookOpen aria-hidden="true" /><h2>{disconnected ? "Your journal stays on your computer." : "Opening your journal…"}</h2><p>{disconnected ? "Reconnect to load your projects and learning history." : "Gathering projects, conversations and recorded learning."}</p></div> : <>
        <section className="home-continue" aria-labelledby="continue-title"><div><p className="eyebrow">{latest ? "Continue where you left off" : "A place for your next idea"}</p><h2 id="continue-title">{latest ? latest.title : "Your work starts with a project."}</h2><p className="continue-focus">{latest ? latest.focus : "Open a local Git repository. Build with your own coding agent, then make sense of what changed."}</p><div className="continue-meta">{latest ? <><span>{projectName(latest.projectId)}</span><span>{agentLabel(latest.providerId)}</span><span>{activityDate(latest.at)}</span><span className={latest.status === "interrupted" ? "text-destructive" : ""}>{latest.status === "interrupted" ? "Interrupted · partial work" : latest.status}</span></> : <span>Your repository stays on this computer.</span>}</div></div><button className="continue-arrow" disabled={disconnected || choosing} aria-label={latest ? `Continue ${latest.title}` : "Choose a project folder"} onClick={() => latest ? open(latest) : onChoose()}><ArrowUpRight size={32} aria-hidden="true" /></button></section>
        {visit?.at ? <p className="since-visit">Since your last visit · {visit.completed} completed {visit.completed === 1 ? "task" : "tasks"} · {visit.interrupted} interrupted. Learning below reflects the current saved record.</p> : <p className="since-visit">Your first journal visit on this computer. Every entry comes from recorded work.</p>}
        <div className="home-columns"><div className="home-primary">
          <section className="home-section" aria-labelledby="projects-heading"><div className="section-heading"><h2 id="projects-heading">On your workbench</h2><span>{data.projects.length} {data.projects.length === 1 ? "project" : "projects"}</span></div><div className="project-index">{orderedProjects.length ? orderedProjects.map((project, index) => <article className="home-project" key={project.id}><span className="project-number">{String(index + 1).padStart(2, "0")}</span><div className="project-details"><button className="project-title" disabled={disconnected} onClick={() => onOpen(project.id)}>{project.name}<ArrowUpRight size={16} aria-hidden="true" /></button><p>{project.latest?.title ?? "No conversations yet. A fresh starting point."}</p><div className="project-meta"><span>{project.conversations} conversations</span>{project.latest ? <span>{agentLabel(project.latest.providerId)} · {activityDate(project.latest.at)}</span> : null}</div><div className="understanding-strip"><span className={project.understood.length ? "understanding-label" : "muted-label"}>{project.understood.length ? "Explained in your own words" : project.explored.length ? "Explored" : "No learning recorded yet"}</span>{project.id === workspace?.project.id ? <span>{workspace.changes.length ? `${workspace.changes.length} uncommitted files` : "Working tree clean"}</span> : null}</div>{project.latest?.observed.find(fact => /^Tests reported /.test(fact)) ? <p className="project-test">Latest task evidence · {project.latest.observed.find(fact => /^Tests reported /.test(fact))}</p> : null}{project.explored.length || project.understood.length ? <details className="project-understanding"><summary>Project understanding</summary><p>Recorded concepts, without a mastery score.</p>{project.understood.map(concept => <p key={`u:${concept}`}><span className="text-success">Explained</span> · {concept}</p>)}{project.explored.filter(concept => !project.understood.includes(concept)).map(concept => <p key={`e:${concept}`}>Explored · {concept}</p>)}</details> : null}</div>{pinButton("project", project.id, project.name)}</article>) : <p className="empty-copy">No projects opened yet. Choose a folder to put something on your workbench.</p>}</div></section>
          <section className="home-section" aria-labelledby="journal-heading"><div className="section-heading"><h2 id="journal-heading">The engineering journal</h2><span>{day ? `${day} · UTC` : "From your actual work"}</span></div>
            <div className="journal-search"><Search size={17} aria-hidden="true" /><label className="sr-only" htmlFor="journal-search">Search projects, conversations, learning and Debug</label><input id="journal-search" value={query} maxLength={200} placeholder="Find a conversation, concept or failure…" onChange={event => setSearch({ request: searchRequest, value: event.target.value })} />{query ? <button aria-label="Clear search" onClick={() => setSearch({ request: searchRequest, value: "" })}><X size={16} aria-hidden="true" /></button> : <kbd>Search</kbd>}</div>
            <div className="journal-filters" aria-label="Journal filters">{(["all", "learning", "debug", "interrupted"] as const).map(value => <button key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value === "all" ? "All work" : value === "learning" ? "Understanding" : value === "debug" ? "Debug" : "Interrupted"}</button>)}{day ? <button onClick={() => setDay(null)}>Clear date <X size={12} aria-hidden="true" /></button> : null}</div>
            {query ? <div className="search-projects">{data.projects.filter(project => project.name.toLowerCase().includes(query.toLowerCase())).map(project => <button disabled={disconnected} key={project.id} onClick={() => onOpen(project.id)}>Project · {project.name}<ArrowRight size={14} aria-hidden="true" /></button>)}</div> : null}
            <div className={`journal-list ${loading ? "is-loading" : ""}`}>{visible.length ? visible.map(entry => <article className="journal-entry" key={entry.id}><div className="journal-date"><span>{activityDate(entry.at)}</span><span className={`journal-dot ${entry.debug.length ? "has-failure" : entry.understood.length ? "has-learning" : ""}`} /></div><div><div className="journal-entry-meta">{projectName(entry.projectId)} <span>· {entry.status === "interrupted" ? "Interrupted · partial evidence" : entry.status}</span></div><button className="journal-entry-title" disabled={disconnected} onClick={() => open(entry)}>{entry.title}<ArrowUpRight size={14} aria-hidden="true" /></button>{entry.understood.length ? <p className="journal-learning">Explained · {entry.understood.join(" · ")}</p> : entry.observed.length ? <p className="journal-note">Observed · {entry.observed[0]}</p> : <p className="journal-note">{entry.focus}</p>}{entry.debug.map((issue, index) => <p className="journal-debug" key={index}>Debug · {issue.symptom}: {issue.evidence}<small>Resolution not recorded</small></p>)}{entry.unclear.length ? <p className="journal-note">Needs another look · {entry.unclear.join(" · ")}</p> : null}{entry.explainPhase ? <span className="journal-phase">Explain-back · {entry.explainPhase}</span> : null}</div></article>) : <div className="empty-copy">{query || day || filter !== "all" ? "No matching entries in this view." : "Your first task will begin the story. Understand, explanations and real failures will appear alongside the work."}</div>}</div>
            {data.nextOffset !== null ? <Button variant="outline" size="sm" disabled={loading || disconnected} onClick={() => void loadMore()}>{loading ? "Loading…" : "Load earlier entries"}</Button> : null}<p className="journal-count">{data.entries.length} of {data.total} matching tasks loaded.</p>
          </section>
        </div><aside className="home-secondary" aria-label="Learning and recent work">
          <Calendar month={month} onMonth={setMonth} days={data.calendar} selected={day} onSelect={value => { setDay(value === day ? null : value); document.getElementById("journal-heading")?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" }); }} />
          <section className="home-section"><div className="section-heading"><h2>What stayed with you</h2><BookOpen size={16} aria-hidden="true" /></div>{data.learned.length ? data.learned.map(entry => <button className="learning-memory" disabled={disconnected} key={entry.id} onClick={() => open(entry)}><span className="eyebrow">{projectName(entry.projectId)}</span><span>{entry.understood[0]}</span><small>Explained in your own words <ArrowUpRight size={12} aria-hidden="true" /></small></button>) : <p className="empty-copy">As you explain real changes, your recorded understanding will collect here.</p>}</section>
          <section className="home-section"><div className="section-heading"><h2>Worth another look</h2></div>{data.attention.length ? data.attention.map(entry => <button className="attention-entry" disabled={disconnected} key={entry.id} onClick={() => open(entry)}><span>{entry.title}</span><small>{entry.status === "interrupted" ? "Interrupted · review, then Send Again" : entry.unclear.length ? `Unclear · ${entry.unclear[0]}` : "Real failure recorded · resolution unknown"}</small><ArrowUpRight size={14} aria-hidden="true" /></button>) : <p className="empty-copy">No interrupted work, unclear explanations or Debug records to show.</p>}</section>
          <section className="home-section"><div className="section-heading"><h2>Conversations</h2><span>Pinned & recent</span></div>{sortedConversations.slice(0, showAllConversations ? undefined : 8).map(conversation => <div className="recent-conversation" key={conversation.id}><button disabled={disconnected} onClick={() => onOpen(conversation.project.id, conversation.id)}><span>{conversation.title}</span><small>{conversation.project.name} · {conversation.running ? "Running" : activityDate(conversation.updatedAt)}</small></button>{pinButton("conversation", conversation.id, conversation.title)}</div>)}{sortedConversations.length > 8 ? <button className="conversation-more" aria-expanded={showAllConversations} onClick={() => setShowAllConversations(value => !value)}>{showAllConversations ? "Show recent only" : `Show all ${sortedConversations.length} conversations`} <ArrowRight size={14} aria-hidden="true" /></button> : null}{!conversations.length ? <p className="empty-copy">Your conversations will be here when you come back.</p> : null}</section>
        </aside></div>
      </>}
      <footer className="home-footer"><span className="wordmark">Prentice<span>/</span></span><span>Made of things you actually worked on.</span></footer>
    </div>
  </main>;
}

function Calendar({ month, onMonth, days, selected, onSelect }: { month: string; onMonth: (value: string) => void; days: HomeSnapshot["calendar"]; selected: string | null; onSelect: (day: string) => void }) {
  const date = new Date(`${month}-01T12:00:00Z`);
  const shift = (amount: number) => { const next = new Date(date); next.setUTCMonth(next.getUTCMonth() + amount); onMonth(next.toISOString().slice(0, 7)); };
  const count = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  const offset = (date.getUTCDay() + 6) % 7;
  const today = new Date().toISOString().slice(0, 10);
  return <section className="activity-calendar"><div className="section-heading"><h2>{date.toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" })}</h2><div><button aria-label="Previous month" onClick={() => shift(-1)}><ChevronLeft size={16} aria-hidden="true" /></button><button aria-label="Next month" onClick={() => shift(1)}><ChevronRight size={16} aria-hidden="true" /></button></div></div><div className="calendar-grid">{["M", "T", "W", "T", "F", "S", "S"].map((name, i) => <span key={`label${i}`} className="calendar-label" aria-hidden="true">{name}</span>)}{Array.from({ length: offset }, (_, i) => <span key={`space${i}`} />)}{Array.from({ length: count }, (_, i) => {
    const day = `${month}-${String(i + 1).padStart(2, "0")}`;
    const activity = days.find(item => item.day === day);
    return <button key={day} className={`${activity ? "has-activity" : ""} ${today === day ? "is-today" : ""}`} aria-label={`${day}, ${activity ? `${activity.tasks} tasks, ${activity.learning} attached learning records, ${activity.debug} Debug records` : "no recorded activity"}`} aria-pressed={selected === day} onClick={() => onSelect(day)}><span>{i + 1}</span>{activity ? <i aria-hidden="true" /> : null}</button>;
  })}</div><p><span className="calendar-key" /> Task activity · UTC dates</p></section>;
}
