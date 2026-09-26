import type { EvidencePacket, ExplainQuestion, UnderstandArtifact } from "@prentice/domain";
import { groqJson, readGroqConfig, type GroqConfig } from "./groq.js";

const UNAVAILABLE = "The Learning AI is unavailable. Prentice is showing the recorded evidence and will not ask a coding agent to teach instead.";

export function learningStatus(): { ok: true; config: GroqConfig } | { ok: false; message: string } {
  return readGroqConfig();
}

export async function explainEvidence(packet: EvidencePacket, artifact: UnderstandArtifact): Promise<UnderstandArtifact> {
  const config = readGroqConfig();
  if (!config.ok) {
    return { ...artifact, learning: { available: false, message: config.message, explanation: null } };
  }
  const result = await groqJson(
    config.config,
    "You explain a coding task from recorded evidence only. Do not invent files, reasons, or results that are not in the evidence. Return JSON {\"explanation\": string}. The explanation must separate what was observed from what the agent stated. If the evidence does not say why a change was made, say that it was not recorded.",
    JSON.stringify(packetSummary(packet)),
  );
  if (!result.ok) return { ...artifact, learning: { available: false, message: result.message, explanation: null } };
  const explanation = stringField(result.json, "explanation");
  if (!explanation || mentionsUnknownPath(explanation, packet)) {
    return {
      ...artifact,
      learning: {
        available: false,
        message: "The Learning AI response was not used because it was not grounded in the recorded evidence.",
        explanation: null,
      },
    };
  }
  return { ...artifact, learning: { available: true, message: "Explained from the recorded evidence.", explanation } };
}

export async function phraseQuestion(packet: EvidencePacket, question: ExplainQuestion): Promise<string | null> {
  const config = readGroqConfig();
  if (!config.ok) return null;
  const result = await groqJson(
    config.config,
    "Write one explain-back question about the recorded fact. Do not include the expected answer. Return JSON {\"question\": string}. Stay on this fact. Do not invent other repository facts.",
    JSON.stringify({ evidence: packetSummary(packet), fact: question.expectedPoints, prompt: question.prompt }),
  );
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
  const config = readGroqConfig();
  if (!config.ok) return config;
  const result = await groqJson(
    config.config,
    "Judge whether the learner's answer shows they understand the recorded fact. Meaning matters more than exact wording. If they do not, feedback and hint must not reveal the expected answer. Return JSON {\"understood\": boolean, \"feedback\": string, \"hint\": string}. Do not invent repository facts.",
    JSON.stringify({ evidence: packetSummary(packet), fact: question.expectedPoints, question: question.prompt, answer }),
  );
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
): Promise<{ kind: "observed" | "general" | "unrecorded"; text: string } | { ok: false; message: string }> {
  const config = readGroqConfig();
  if (!config.ok) return { ok: false, message: config.message };
  const result = await groqJson(
    config.config,
    "Answer a learner's follow-up. If the question is about this task, use only the evidence and set kind to \"observed\". If it is a general concept, set kind to \"general\" and say it is general teaching, not an extra repository fact. If the task did not record it, set kind to \"unrecorded\" and do not guess. Return JSON {\"kind\": \"observed\"|\"general\"|\"unrecorded\", \"text\": string}.",
    JSON.stringify({ evidence: packetSummary(packet), question }),
  );
  if (!result.ok) return result;
  const record = objectRecord(result.json);
  const kind = record?.kind;
  const text = typeof record?.text === "string" ? record.text : "";
  if ((kind !== "observed" && kind !== "general" && kind !== "unrecorded") || !text) {
    return { ok: false, message: "The Learning AI could not answer that question." };
  }
  if (kind !== "general" && mentionsUnknownPath(text, packet)) {
    return { kind: "unrecorded", text: "That was not recorded for this task. Prentice will not guess about the repository." };
  }
  return { kind, text };
}

export const learningUnavailableMessage = UNAVAILABLE;

function packetSummary(packet: EvidencePacket) {
  return {
    files: packet.files.map((file) => ({ path: file.path, change: file.change, additions: file.additions, deletions: file.deletions })),
    symbols: packet.symbols.map((symbol) => ({ path: symbol.path, name: symbol.name, kind: symbol.kind, change: symbol.change })),
    commands: packet.activity
      .filter((item) => item.kind === "command.finished")
      .map((item) => ({ command: item.command, exitCode: item.exitCode })),
    tests: packet.tests,
    agentNotes: packet.activity.filter((item) => item.kind === "assistant").map((item) => item.detail).filter(Boolean),
    failures: packet.activity.filter((item) => item.kind === "session.failed").map((item) => item.detail).filter(Boolean),
    unparsedFiles: packet.unparsedFiles,
  };
}

function mentionsUnknownPath(text: string, packet: EvidencePacket): boolean {
  const known = new Set(packet.files.map((file) => file.path));
  const paths = text.match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? [];
  return paths.some((path) => path.includes("/") && !known.has(path) && !packet.files.some((file) => file.path.endsWith(path)));
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
