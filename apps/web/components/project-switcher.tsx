"use client";

import { useEffect, useRef, type RefObject } from "react";
import { Folder } from "lucide-react";

export interface LibraryConversation {
  id: string;
  title: string;
  updatedAt: string;
  current: boolean;
  running: boolean;
}

export interface LibraryProject {
  id: string;
  name: string;
  path: string;
  current: boolean;
  conversations: LibraryConversation[];
}

export function ProjectNavigation({
  projects,
  open,
  buttonRef,
  onOpenChange,
  onSelectProject,
  onSelectConversation,
  onNewChat,
  onChooseFolder,
  choosing,
}: {
  projects: LibraryProject[];
  open: boolean;
  buttonRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onSelectProject: (project: LibraryProject) => void;
  onSelectConversation: (project: LibraryProject, conversationId: string) => void;
  onNewChat: () => void;
  onChooseFolder: () => void;
  choosing: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const ordered = [...projects].sort((a, b) => Number(b.current) - Number(a.current));
  const current = ordered.find((project) => project.current) ?? null;

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector<HTMLElement>("button")?.focus();
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (panel.current?.contains(target) || buttonRef.current?.contains(target)) return;
      onOpenChange(false);
    }
    function onKey(event: KeyboardEvent) {
      const items = [...(panel.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [])];
      if (event.key === "Tab" && items.length > 0) {
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
        buttonRef.current?.focus();
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "ArrowDown" ? items[index + 1] : items[index - 1];
      next?.focus();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onOpenChange, buttonRef]);

  if (!open) return null;

  return (
    <div
      ref={panel}
      id="project-switcher"
      role="dialog"
      aria-label="Projects and conversations"
      className="prentice-rise absolute top-0 bottom-0 left-11 z-40 flex w-[220px] max-[960px]:w-[min(17.5rem,calc(100vw-2.75rem))] flex-col overflow-hidden border-r border-border bg-sidebar shadow-[16px_0_40px_-28px_rgb(36_24_15/0.45)]"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2.5">
        <p className="text-sm text-muted-foreground">Repositories</p>
        {current ? (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-xs text-foreground transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            onClick={onNewChat}
          >
            New Chat
          </button>
        ) : null}
      </div>
      <div className="px-3 pb-2">
        <button
          type="button"
          className="w-full rounded-md bg-primary px-2 py-1.5 text-xs text-primary-foreground transition-[transform,background-color] duration-150 hover:-translate-y-px focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:translate-y-px disabled:opacity-50"
          disabled={choosing}
          onClick={onChooseFolder}
        >
          {choosing ? "Opening…" : "Choose Folder"}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain pb-3">
        {ordered.length === 0 ? (
          <p className="px-3 text-sm text-muted-foreground">No projects on this computer yet.</p>
        ) : (
          ordered.map((project) => (
            <section key={project.id} className="mt-1">
              <button
                type="button"
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                translate="no"
                onClick={() => onSelectProject(project)}
              >
                <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{project.name}</span>
              </button>
              {project.conversations.length === 0 ? (
                <p className="px-9 py-1 text-xs text-muted-foreground">No conversations yet</p>
              ) : (
                project.conversations.map((conversation) => (
                  <button
                    key={conversation.id}
                    type="button"
                    aria-current={conversation.current ? "true" : undefined}
                    title={conversation.title}
                    className={`mx-2 flex w-[calc(100%-1rem)] min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${conversation.current ? "bg-sidebar-accent text-foreground" : "text-muted-foreground"}`}
                    onClick={() => onSelectConversation(project, conversation.id)}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${conversation.running ? "prentice-live bg-primary" : "bg-current opacity-60"}`}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{conversation.title}</span>
                    {conversation.running ? <span className="sr-only">Working</span> : null}
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{relativeTime(conversation.updatedAt)}</span>
                  </button>
                ))
              )}
            </section>
          ))
        )}
      </div>
    </div>
  );
}

function relativeTime(value: string): string {
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return "";
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  const weeks = Math.round(days / 7);
  if (weeks < 5) return `${weeks}w`;
  const months = Math.round(days / 30);
  return `${months}mo`;
}
