import { createRequire } from "node:module";
import { extname } from "node:path";
import type { SymbolChange } from "@prentice/domain";
import { log } from "./log.js";

type SyntaxNode = {
  type: string;
  text: string;
  childCount: number;
  child(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
};

type ParserInstance = {
  setLanguage(language: unknown): void;
  parse(source: string): { rootNode: SyntaxNode };
};

type ParserConstructor = new () => ParserInstance;

interface TreeSitterModule {
  default: ParserConstructor;
}

let parsers: {
  typescript: ParserInstance;
  tsx: ParserInstance;
  javascript: ParserInstance;
} | null = null;

let loadFailed = false;

async function loadParsers(): Promise<typeof parsers> {
  if (parsers || loadFailed) return parsers;
  try {
    const require = createRequire(import.meta.url);
    const TreeSitter = require("tree-sitter") as TreeSitterModule["default"];
    const typescript = require("tree-sitter-typescript") as { typescript: unknown; tsx: unknown };
    const javascript = require("tree-sitter-javascript") as unknown;
    const make = (language: unknown) => {
      const parser = new TreeSitter();
      parser.setLanguage(language);
      return parser;
    };
    parsers = {
      typescript: make(typescript.typescript),
      tsx: make(typescript.tsx),
      javascript: make(javascript),
    };
    return parsers;
  } catch (error) {
    loadFailed = true;
    log("warn", "Tree-sitter failed to load. TypeScript and JavaScript files will stay at file level.", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

export async function extractSymbolChanges(
  path: string,
  nextSource: string | null,
  previousSource: string | null,
): Promise<{ symbols: SymbolChange[]; parsed: boolean }> {
  const language = languageFor(path);
  if (!language) return { symbols: [], parsed: false };
  const loaded = await loadParsers();
  if (!loaded) return { symbols: [], parsed: false };
  const parser = loaded[language];
  const before = previousSource === null ? new Set<string>() : names(parser.parse(previousSource).rootNode);
  const after = nextSource === null ? new Set<string>() : names(parser.parse(nextSource).rootNode);
  const symbols: SymbolChange[] = [];
  for (const entry of after) {
    if (!before.has(entry)) {
      const [kind, name] = splitEntry(entry);
      symbols.push({
        evidenceId: `sym:${path}:${name}`,
        path,
        name,
        kind,
        change: "added",
      });
    }
  }
  for (const entry of before) {
    if (!after.has(entry)) {
      const [kind, name] = splitEntry(entry);
      symbols.push({
        evidenceId: `sym:${path}:${name}:removed`,
        path,
        name,
        kind,
        change: "deleted",
      });
    }
  }
  return { symbols, parsed: true };
}

function languageFor(path: string): "typescript" | "tsx" | "javascript" | null {
  const extension = extname(path);
  if (extension === ".tsx") return "tsx";
  if (extension === ".ts") return "typescript";
  if (extension === ".jsx" || extension === ".js" || extension === ".mjs" || extension === ".cjs") return "javascript";
  return null;
}

function names(node: SyntaxNode): Set<string> {
  const found = new Set<string>();
  walk(node, found);
  return found;
}

function walk(node: SyntaxNode, found: Set<string>): void {
  if (node.type === "function_declaration" || node.type === "class_declaration" || node.type === "method_definition") {
    const name = node.childForFieldName("name")?.text;
    if (name) found.add(`${kindFor(node.type)}:${name}`);
  }
  if (node.type === "variable_declarator") {
    const name = node.childForFieldName("name")?.text;
    const value = node.childForFieldName("value");
    if (name && value && (value.type === "arrow_function" || value.type === "function" || value.type === "function_expression")) {
      found.add(`function:${name}`);
    }
  }
  for (let index = 0; index < node.childCount; index += 1) {
    const child = node.child(index);
    if (child) walk(child, found);
  }
}

function kindFor(type: string): SymbolChange["kind"] {
  if (type === "class_declaration") return "class";
  if (type === "method_definition") return "method";
  if (type === "function_declaration") return "function";
  return "other";
}

function splitEntry(entry: string): [SymbolChange["kind"], string] {
  const [kind, name] = entry.split(":");
  if (kind === "class" || kind === "method" || kind === "function") return [kind, name ?? entry];
  return ["other", name ?? entry];
}

export function isParsedLanguage(path: string): boolean {
  return languageFor(path) !== null;
}

// Only these operation names can leave the local parser. No expressions, literals,
// comments, arguments, source excerpts or repository-defined identifiers are exported.
const LEARNING_OPERATIONS = new Set([
  "localStorage.getItem", "localStorage.setItem", "localStorage.removeItem",
  "sessionStorage.getItem", "sessionStorage.setItem", "sessionStorage.removeItem",
  "crypto.subtle.digest", "crypto.subtle.deriveBits", "crypto.subtle.deriveKey",
  "crypto.getRandomValues", "fetch", "JSON.parse", "JSON.stringify",
  "addEventListener", "preventDefault", "useState", "useEffect", "useReducer",
  "Promise.all", "Promise.allSettled", "AbortController", "URL", "Map", "Set",
]);

/** Syntactic use is evidence of an API call, never proof of its runtime behavior or security. */
export async function extractImplementationSignals(path: string, next: string | null, previous: string | null): Promise<import("@prentice/domain").ImplementationSignal[]> {
  const language = languageFor(path);
  const loaded = language ? await loadParsers() : null;
  if (!loaded || !language) return [];
  const operations = (source: string | null) => {
    const found = new Set<string>();
    if (source === null) return found;
    const visit = (node: SyntaxNode) => {
      if (node.type === "call_expression" || node.type === "new_expression") {
        const callee = node.childForFieldName(node.type === "new_expression" ? "constructor" : "function")?.text.replace(/\s/g, "");
        if (callee && LEARNING_OPERATIONS.has(callee)) found.add(callee);
        else if (callee?.endsWith(".addEventListener")) found.add("addEventListener");
        else if (callee?.endsWith(".preventDefault")) found.add("preventDefault");
      }
      if (node.type === "throw_statement") found.add("throw statement");
      if (node.type === "await_expression") found.add("await expression");
      for (let i = 0; i < node.childCount; i++) { const child = node.child(i); if (child) visit(child); }
    };
    const tree = loaded[language].parse(source);
    // A malformed file should not be promoted to a reliable structural observation.
    if ((tree.rootNode as SyntaxNode & { hasError?: boolean }).hasError) return found;
    visit(tree.rootNode);
    return found;
  };
  const before = operations(previous), after = operations(next);
  return [
    ...[...after].filter(op => !before.has(op)).map(operation => ({ evidenceId: `impl:${path}:added:${operation}`, path, operation, change: "added" as const })),
    ...[...before].filter(op => !after.has(op)).map(operation => ({ evidenceId: `impl:${path}:removed:${operation}`, path, operation, change: "removed" as const })),
  ];
}
