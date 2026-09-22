"use client";

import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import type { Extension } from "@codemirror/state";

export function CodeView({ path, value }: { path: string; value: string }) {
  return (
    <CodeMirror
      value={value}
      height="100%"
      theme="dark"
      editable={false}
      extensions={extensionsFor(path)}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
      className="h-full text-sm [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono"
    />
  );
}

export function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) {
    return <p className="p-6 text-sm text-muted-foreground">Git did not return a diff for this path.</p>;
  }
  const lines = patch.split("\n");
  return (
    <ol className="h-full overflow-auto bg-background py-3 font-mono text-[13px] leading-6">
      {lines.map((line, index) => (
        <li key={`${index}-${line.slice(0, 24)}`} className={`px-4 whitespace-pre ${lineTone(line)}`}>
          {line || " "}
        </li>
      ))}
    </ol>
  );
}

function lineTone(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) {
    return "text-muted-foreground";
  }
  if (line.startsWith("@@")) return "text-primary";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-300";
  if (line.startsWith("-")) return "bg-destructive/10 text-red-300";
  return "text-foreground/80";
}

function extensionsFor(path: string): Extension[] {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return [javascript({ jsx: true, typescript: path.endsWith(".tsx") })];
  if (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".mjs")) {
    return [javascript({ typescript: path.endsWith(".ts") })];
  }
  if (path.endsWith(".json")) return [json()];
  if (path.endsWith(".md")) return [markdown()];
  if (path.endsWith(".css")) return [css()];
  if (path.endsWith(".py")) return [python()];
  return [];
}
