"use client";

import CodeMirror from "@uiw/react-codemirror";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const carbonTheme = EditorView.theme(
  {
    "&": { backgroundColor: "#1c1814", color: "#f3eadc" },
    ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "#e15a22" },
    ".cm-gutters": {
      backgroundColor: "#1c1814",
      color: "#8a7764",
      borderRight: "1px solid rgb(243 234 220 / 14%)",
      fontFamily: "var(--font-mono)",
    },
    ".cm-activeLine": { backgroundColor: "#2a241e" },
    ".cm-activeLineGutter": { backgroundColor: "#2a241e", color: "#f3eadc" },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": { backgroundColor: "#3a2e24" },
  },
  { dark: true },
);

const carbonHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#e07a4a" },
  { tag: tags.tagName, color: "#e07a4a" },
  { tag: tags.string, color: "#c4d39a" },
  { tag: tags.comment, color: "#8a7764", fontStyle: "italic" },
  { tag: tags.number, color: "#e0b06a" },
  { tag: tags.attributeName, color: "#e0b06a" },
  { tag: tags.propertyName, color: "#e0b06a" },
  { tag: tags.operator, color: "#c4b4a0" },
  { tag: tags.function(tags.variableName), color: "#f0c9a0" },
  { tag: tags.variableName, color: "#f3eadc" },
]);

export function CodeView({ path, value }: { path: string; value: string }) {
  return (
    <CodeMirror
      value={value}
      height="100%"
      theme={carbonTheme}
      editable={false}
      readOnly
      extensions={[syntaxHighlighting(carbonHighlight), ...extensionsFor(path)]}
      basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: true }}
      className="h-full max-w-full overflow-hidden text-sm [&_.cm-editor]:h-full [&_.cm-editor]:max-w-full [&_.cm-scroller]:max-w-full [&_.cm-scroller]:overflow-auto"
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
        <li key={`${index}-${line.slice(0, 24)}`} className={`px-4 whitespace-pre [content-visibility:auto] ${lineTone(line)}`}>
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
  if (line.startsWith("+")) return "bg-success/15 text-success";
  if (line.startsWith("-")) return "bg-destructive/15 text-destructive";
  return "text-foreground/80";
}

function extensionsFor(path: string): Extension[] {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return [javascript({ jsx: true, typescript: path.endsWith(".tsx") })];
  if (path.endsWith(".ts") || path.endsWith(".js") || path.endsWith(".mjs")) {
    return [javascript({ typescript: path.endsWith(".ts") })];
  }
  if (path.endsWith(".json")) return [json()];
  if (path.endsWith(".md")) return [markdown()];
  if (path.endsWith(".html") || path.endsWith(".htm")) return [html()];
  if (path.endsWith(".css")) return [css()];
  if (path.endsWith(".py")) return [python()];
  return [];
}
