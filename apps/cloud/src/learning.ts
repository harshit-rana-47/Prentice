import { groqJson, readGroqConfig } from "./groq.js";

const BOUNDARY =
  "The evidence has two parts. evidence.observed is what Prentice established itself: git file changes, parsed symbols, recorded commands with exit codes, and bounded failure output marked source command-output. evidence.agentStated is only what the coding agent said about its own work. Never present anything from agentStated as observed or as fact; attribute it to the agent. Do not invent files, reasons, or results.";
const EXPLAIN =
  `You explain a coding task from recorded evidence only. ${BOUNDARY} Return JSON {"observed": string[], "agentStated": string[], "notRecorded": string[]}. Put in observed only sentences supported by evidence.observed. Put anything that depends on evidence.agentStated in agentStated, phrased as what the agent said. Use notRecorded for what the evidence does not show, such as why a change was made when no reason was recorded.`;
const PHRASE =
  `Write one explain-back question about the recorded fact. ${BOUNDARY} Do not include the expected answer. Return JSON {"question": string}. Stay on this fact.`;
const JUDGE =
  `Judge whether the learner's answer shows they understand the recorded fact. ${BOUNDARY} Meaning matters more than exact wording. If they do not, feedback and hint must not reveal the expected answer. Return JSON {"understood": boolean, "feedback": string, "hint": string}.`;
const DISCUSS =
  `Answer a learner's follow-up. ${BOUNDARY} If the answer comes from evidence.observed, set kind to "observed". If it depends on what the agent said, set kind to "agent-stated" and say that the agent reported it. If it is a general concept, set kind to "general" and say it is general teaching, not a repository fact. If the task did not record it, set kind to "unrecorded" and do not guess. Return JSON {"kind": "observed"|"agent-stated"|"general"|"unrecorded", "text": string}.`;

/** Calls Groq with the summary the connector already built. This function does not write anything. */
export async function completeLearning(body: Record<string, unknown>): Promise<{ ok: true; json: unknown } | { ok: false; message: string }> {
  const config = readGroqConfig();
  if (!config.ok) return config;
  const evidence = body.evidence;
  if (!evidence || typeof evidence !== "object") {
    return { ok: false, message: "The Learning AI is unavailable. Prentice is showing the recorded evidence and will not ask a coding agent to teach instead." };
  }
  if (body.action === "explain") return groqJson(config.config, EXPLAIN, JSON.stringify(evidence));
  if (body.action === "phrase") {
    return groqJson(config.config, PHRASE, JSON.stringify({ evidence, fact: body.fact, prompt: body.prompt }));
  }
  if (body.action === "judge") {
    return groqJson(
      config.config,
      JUDGE,
      JSON.stringify({ evidence, fact: body.fact, question: body.prompt, answer: body.answer }),
    );
  }
  if (body.action === "discuss") {
    return groqJson(config.config, DISCUSS, JSON.stringify({ evidence, question: body.question }));
  }
  return { ok: false, message: "The Learning AI is unavailable. Prentice is showing the recorded evidence and will not ask a coding agent to teach instead." };
}
