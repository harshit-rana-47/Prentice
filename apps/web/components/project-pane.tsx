"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";

export type ChangeKind = "added" | "modified" | "deleted";

export interface TreeNode {
  name: string;
  path: string;
  kind: "file" | "dir";
  children?: TreeNode[];
}

export interface WorkspaceSnapshot {
  project: { id: string; name: string; path: string };
  branch: string;
  changes: Array<{ path: string; change: ChangeKind }>;
  additions: number;
  deletions: number;
  tree: TreeNode[];
}

const rowClass =
  "flex w-full items-center gap-2 truncate py-0.5 pr-2 text-left text-xs transition-[background-color,color] duration-150 ease-[cubic-bezier(0.22,1,0.36,1)] hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none active:bg-sidebar-accent [content-visibility:auto]";

export function ProjectPane({
  open,
  activity,
  workspace,
  changes,
  files,
  query,
  onQuery,
  onOpen,
}: {
  open: boolean;
  activity: "explorer" | "search" | "changes";
  workspace: WorkspaceSnapshot | null;
  changes: Map<string, ChangeKind>;
  files: string[];
  query: string;
  onQuery: (value: string) => void;
  onOpen: (path: string, mode: "file" | "diff") => void;
}) {
  return (
    <aside
      data-open={open ? "true" : "false"}
      aria-hidden={open ? undefined : true}
      inert={!open}
      className="prentice-project flex min-h-0 w-[220px] shrink-0 flex-col overflow-hidden border-r border-border bg-sidebar"
    >
      {activity === "explorer" ? (
        <Explorer workspace={workspace} changes={changes} onOpen={(path) => onOpen(path, "file")} />
      ) : null}
      {activity === "search" ? (
        <SearchPane query={query} onQuery={onQuery} files={files} onOpen={(path) => onOpen(path, "file")} />
      ) : null}
      {activity === "changes" ? (
        <ChangesPane
          changes={workspace?.changes ?? []}
          additions={workspace?.additions ?? 0}
          deletions={workspace?.deletions ?? 0}
          onOpen={(path) => onOpen(path, "diff")}
        />
      ) : null}
    </aside>
  );
}

function Explorer({
  workspace,
  changes,
  onOpen,
}: {
  workspace: WorkspaceSnapshot | null;
  changes: Map<string, ChangeKind>;
  onOpen: (path: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="px-3 py-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Explorer</h2>
      {workspace ? (
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
          <p className="truncate px-2 py-1 text-xs font-medium" translate="no">
            {workspace.project.name}
          </p>
          <Tree nodes={workspace.tree} changes={changes} onOpen={onOpen} />
        </div>
      ) : (
        <p className="px-3 pb-3 text-xs text-pretty text-muted-foreground">Choose a folder to see its files.</p>
      )}
    </div>
  );
}

function SearchPane({
  query,
  onQuery,
  files,
  onOpen,
}: {
  query: string;
  onQuery: (value: string) => void;
  files: string[];
  onOpen: (path: string) => void;
}) {
  const visible = files.filter((file) => file.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 200);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <h2 className="px-3 py-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Search</h2>
      <div className="px-3">
        <label className="sr-only" htmlFor="file-filter">
          Filter files
        </label>
        <Input
          id="file-filter"
          name="file-filter"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Filter by file name…"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              onQuery("");
            }
          }}
        />
      </div>
      {query.trim() && visible.length === 0 ? <p className="px-3 pt-3 text-xs text-muted-foreground">No matching files.</p> : null}
      <ul className="mt-2 min-h-0 flex-1 overflow-auto">
        {visible.map((file) => (
          <li key={file}>
            <button type="button" className={`${rowClass} px-3 py-1 font-mono text-[11px]`} translate="no" onClick={() => onOpen(file)}>
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
      <h2 className="px-3 py-2 font-mono text-[10px] tracking-[0.16em] text-muted-foreground uppercase">Changes</h2>
      <p className="px-3 pb-2 text-xs text-muted-foreground tabular-nums">
        {changes.length} {changes.length === 1 ? "file" : "files"} changed
        <span className={`ml-2 ${additions > 0 ? "text-success" : ""}`}>+{additions}</span>
        <span className={`ml-2 ${deletions > 0 ? "text-destructive" : ""}`}>-{deletions}</span>
      </p>
      {changes.length === 0 ? <p className="px-3 text-xs text-muted-foreground">No changes in this repository.</p> : null}
      <ul className="min-h-0 flex-1 overflow-auto">
        {changes.map((change) => (
          <li key={change.path}>
            <button type="button" className={`${rowClass} px-3 py-1`} translate="no" onClick={() => onOpen(change.path)}>
              <span className="truncate">{change.path}</span>
              <ChangeMark kind={change.change} />
            </button>
          </li>
        ))}
      </ul>
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
              className={rowClass}
              style={{ paddingLeft: 8 + depth * 12 }}
              translate="no"
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
        className={rowClass}
        style={{ paddingLeft: 8 + depth * 12 }}
        aria-expanded={open}
        translate="no"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="text-muted-foreground" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>
        {node.name}
      </button>
      {open ? <Tree nodes={node.children ?? []} changes={changes} onOpen={onOpen} depth={depth + 1} /> : null}
    </div>
  );
}

function ChangeMark({ kind }: { kind: ChangeKind }) {
  const mark = kind === "added" ? "+" : kind === "deleted" ? "−" : "~";
  const tone = kind === "added" ? "text-success" : kind === "deleted" ? "text-destructive" : "text-muted-foreground";
  return (
    <span className={`font-mono text-[11px] ${tone}`} aria-label={kind}>
      {mark}
    </span>
  );
}

export function flatten(nodes: TreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind === "file") paths.push(node.path);
    else paths.push(...flatten(node.children ?? []));
  }
  return paths;
}
