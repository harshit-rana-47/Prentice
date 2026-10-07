import type { EvidencePacket, ExplainQuestion, UnderstandArtifact } from "@prentice/domain";

const UNAVAILABLE = "The Learning AI is unavailable. Prentice is showing the recorded evidence and will not ask a coding agent to teach instead.";

interface LearningEndpoint {
  cloudUrl: string;
  token: string;
}

let endpoint: LearningEndpoint | null = null;
/** The cloud gives Groq 30 seconds; the connector waits a little longer, then says the Learning AI is unavailable. */
export const LEARNING_TIMEOUT_MS = 40_000;

/** The paired computer asks Prentice to teach. The Groq key stays on the cloud. */
export function setLearningEndpoint(next: LearningEndpoint | null): void {
  endpoint = next;
}

export function learningStatus(): { ok: true } | { ok: false; message: string } {
  if (!endpoint) return { ok: false, message: UNAVAILABLE };
  return { ok: true };
}

export async function explainEvidence(packet: EvidencePacket, artifact: UnderstandArtifact): Promise<UnderstandArtifact> {
  const summary = evidenceSummary(packet);
  const result = await ask("explain", { evidence: summary });
  if (!result.ok) return { ...artifact, learning: { available: false, message: result.message, explanation: null } };
  const raw = explanationSections(result.json, summary);
  // A sentence naming a path Prentice never recorded is dropped; the rest of the explanation stays.
  const keep = (line: string) => !mentionsUnknownPath(line, packet, summary);
  const sections = raw
    ? { observed: raw.observed.filter(keep), agentStated: raw.agentStated.filter(keep), notRecorded: raw.notRecorded.filter(keep) }
    : null;
  if (!sections || sections.observed.length + sections.agentStated.length + sections.notRecorded.length === 0) {
    return {
      ...artifact,
      learning: {
        available: false,
        message: "The Learning AI response was not used because it was not grounded in the recorded evidence.",
        explanation: null,
      },
    };
  }
  return { ...artifact, learning: { available: true, message: "Explained from the recorded evidence.", explanation: renderSections(sections) } };
}

export interface ExplanationSections {
  observed: string[];
  agentStated: string[];
  notRecorded: string[];
}

/**
 * Reads the Learning AI's sections and enforces the evidence boundary: a sentence offered as observed that relies
 * on a fact found only in what the agent said is moved to Agent stated. The model cannot promote agent claims.
 */
export function explanationSections(value: unknown, summary: EvidenceSummary): ExplanationSections | null {
  const record = objectRecord(value);
  if (!record) return null;
  const list = (key: string) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  const observed: string[] = [];
  const agentStated = list("agentStated");
  for (const sentence of list("observed")) {
    if (reliesOnAgentOnly(sentence, summary)) agentStated.push(sentence);
    else observed.push(sentence);
  }
  const notRecorded = list("notRecorded");
  if (observed.length + agentStated.length + notRecorded.length === 0) {
    const legacy = stringField(value, "explanation");
    if (!legacy) return null;
    return reliesOnAgentOnly(legacy, summary) ? { observed: [], agentStated: [legacy], notRecorded: [] } : { observed: [legacy], agentStated: [], notRecorded: [] };
  }
  return { observed, agentStated, notRecorded };
}

function renderSections(sections: ExplanationSections): string {
  const parts: string[] = [];
  if (sections.observed.length) parts.push(`Observed\n${sections.observed.map((line) => `- ${line}`).join("\n")}`);
  if (sections.agentStated.length) parts.push(`Agent stated\n${sections.agentStated.map((line) => `- ${line}`).join("\n")}`);
  if (sections.notRecorded.length) parts.push(`Not recorded\n${sections.notRecorded.map((line) => `- ${line}`).join("\n")}`);
  return parts.join("\n\n");
}

/**
 * True when the sentence contains a specific detail (a quoted or code span, a comparison such as `8 !== 2`, or a
 * number) that appears in the agent's statements but nowhere in what Prentice observed.
 */
export function reliesOnAgentOnly(sentence: string, summary: EvidenceSummary): boolean {
  const observedText = JSON.stringify(summary.observed).toLowerCase();
  const agentText = summary.agentStated.map((item) => item.text).join("\n").toLowerCase();
  if (!agentText) return false;
  const tokens = new Set<string>();
  for (const match of sentence.matchAll(/`([^`]{2,80})`|"([^"]{2,80})"|\u201c([^\u201d]{2,80})\u201d/g)) tokens.add((match[1] ?? match[2] ?? match[3] ?? "").trim());
  for (const match of sentence.matchAll(/-?\d+(?:\.\d+)?\s*(?:!==|===|!=|==|<=|>=|<|>)\s*-?\d+(?:\.\d+)?/g)) tokens.add(match[0]);
  for (const match of sentence.matchAll(/\b\d{1,}(?:\.\d+)?\b/g)) tokens.add(match[0]);
  for (const token of tokens) {
    const needle = token.toLowerCase();
    if (!needle) continue;
    if (agentText.includes(needle) && !observedText.includes(needle)) return true;
  }
  return false;
}

export async function phraseQuestion(packet: EvidencePacket, question: ExplainQuestion): Promise<string | null> {
  const result = await ask("phrase", { evidence: evidenceSummary(packet), fact: question.expectedPoints, prompt: question.prompt });
  if (!result.ok) return null;
  const text = stringField(result.json, "question");
  if (!text || leaks(text, question)) return question.prompt;
  return text;
}

export async function judgeLearningAnswer(
  packet: EvidencePacket,
  question: ExplainQuestion,
  answer: string,
): Promise<{ ok: true; understood: boolean; feedback: string; hint: string } | { ok: false; message: string }> {
  const result = await ask("judge", {
    evidence: evidenceSummary(packet),
    fact: question.expectedPoints,
    prompt: question.prompt,
    answer,
  });
  if (!result.ok) return result;
  const record = objectRecord(result.json);
  if (!record || typeof record.understood !== "boolean") {
    return { ok: false, message: "The Learning AI could not judge that answer." };
  }
  return {
    ok: true,
    understood: record.understood,
    feedback: typeof record.feedback === "string" ? record.feedback : "That does not match the recorded change yet.",
    hint: typeof record.hint === "string" ? record.hint : "Look at the recorded diff and say what it shows.",
  };
}

export async function discussLearning(
  packet: EvidencePacket,
  question: string,
): Promise<{ kind: "observed" | "agent-stated" | "general" | "unrecorded"; text: string } | { ok: false; message: string }> {
  const summary = evidenceSummary(packet);
  const result = await ask("discuss", { evidence: summary, question });
  if (!result.ok) return result;
  const record = objectRecord(result.json);
  const kind = record?.kind;
  const text = typeof record?.text === "string" ? record.text : "";
  if ((kind !== "observed" && kind !== "agent-stated" && kind !== "general" && kind !== "unrecorded") || !text) {
    return { ok: false, message: "The Learning AI could not answer that question." };
  }
  if (kind !== "general" && mentionsUnknownPath(text, packet, summary)) {
    return { kind: "unrecorded", text: "That was not recorded for this task. Prentice will not guess about the repository." };
  }
  if (kind === "observed" && reliesOnAgentOnly(text, summary)) return { kind: "agent-stated", text };
  return { kind, text };
}

export const learningUnavailableMessage = UNAVAILABLE;

async function ask(
  action: "explain" | "phrase" | "judge" | "discuss",
  payload: Record<string, unknown>,
): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  if (!endpoint) return { ok: false, message: UNAVAILABLE };
  let cloud: URL;
  try {
    cloud = new URL("/v1/learning", endpoint.cloudUrl);
    const local = cloud.hostname === "127.0.0.1" || cloud.hostname === "localhost";
    if (!local && cloud.protocol !== "https:") return { ok: false, message: UNAVAILABLE };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
  try {
    const response = await fetch(cloud, {
      signal: AbortSignal.timeout(LEARNING_TIMEOUT_MS),
      method: "POST",
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
      body: JSON.stringify({ action, ...payload }),
    });
    if (!response.ok) return { ok: false, message: UNAVAILABLE };
    const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
    if (!body || body.result === undefined) return { ok: false, message: UNAVAILABLE };
    return { ok: true, json: body.result };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
}

/** Caps on what leaves this computer for the Learning AI. */
export const LEARNING_LIMITS = { agentStatements: 6, agentStatementChars: 600, agentTotalChars: 3_000, failureOutputChars: 1_500 };

export interface EvidenceSummary {
  /** Established by Prentice: git, Tree-sitter, recorded commands, exit codes, and failure output. */
  observed: {
    files: Array<{ path: string; change: string; additions: number; deletions: number }>;
    symbols: Array<{ path: string; name: string; kind: string; change: string }>;
    commands: Array<{ command?: string; exitCode?: number | null; failureOutput?: { source: "command-output"; text: string; truncated: boolean } }>;
    tests: { passed: number; failed: number; source: "test-runner-output" } | null;
    sessionFailures: string[];
    unparsedFiles: string[];
  };
  /** Reported by the coding agent. Never evidence of what happened; always attributed to the agent. */
  agentStated: Array<{ label: "Agent stated"; text: string; truncated: boolean }>;
}

/**
 * The bounded summary the connector sends to the Prentice cloud. It never contains the original prompt,
 * file contents, or diffs. Agent messages are capped and labelled as Agent stated.
 */
export function evidenceSummary(packet: EvidencePacket): EvidenceSummary {
  const agentStated: EvidenceSummary["agentStated"] = [];
  let total = 0;
  for (const item of packet.activity) {
    if (item.kind !== "assistant" || !item.detail) continue;
    if (agentStated.length >= LEARNING_LIMITS.agentStatements || total >= LEARNING_LIMITS.agentTotalChars) break;
    const room = Math.min(LEARNING_LIMITS.agentStatementChars, LEARNING_LIMITS.agentTotalChars - total);
    const text = item.detail.length > room ? `${item.detail.slice(0, room)}…` : item.detail;
    total += text.length;
    agentStated.push({ label: "Agent stated", text, truncated: text.length < item.detail.length });
  }
  return {
    observed: {
      files: packet.files.map((file) => ({ path: file.path, change: file.change, additions: file.additions, deletions: file.deletions })),
      symbols: packet.symbols.map((symbol) => ({ path: symbol.path, name: symbol.name, kind: symbol.kind, change: symbol.change })),
      commands: packet.activity
        .filter((item) => item.kind === "command.finished")
        .map((item) => ({
          command: item.command,
          exitCode: item.exitCode,
          ...(item.output && item.exitCode !== 0
            ? {
                failureOutput: {
                  source: "command-output" as const,
                  text: item.output.text.slice(-LEARNING_LIMITS.failureOutputChars),
                  truncated: item.output.truncated || item.output.text.length > LEARNING_LIMITS.failureOutputChars,
                },
              }
            : {}),
        })),
      tests: packet.tests ? { passed: packet.tests.passed, failed: packet.tests.failed, source: "test-runner-output" } : null,
      sessionFailures: packet.activity.filter((item) => item.kind === "session.failed").map((item) => item.detail ?? "").filter(Boolean),
      unparsedFiles: packet.unparsedFiles,
    },
    agentStated,
  };
}

/** A path counts as known when git changed it or it appears in what Prentice observed, such as failure output. */
export function mentionsUnknownPath(text: string, packet: EvidencePacket, summary: EvidenceSummary = evidenceSummary(packet)): boolean {
  const known = new Set(packet.files.map((file) => file.path));
  const observedText = JSON.stringify(summary.observed);
  const paths = text.match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? [];
  return paths.some(
    (path) =>
      path.includes("/") &&
      !known.has(path) &&
      !packet.files.some((file) => file.path.endsWith(path)) &&
      !observedText.includes(path),
  );
}

function leaks(text: string, question: ExplainQuestion): boolean {
  const lower = text.toLowerCase();
  return question.expectedPoints.some((point) => point.length > 2 && lower.includes(point.toLowerCase()));
}

function stringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}
