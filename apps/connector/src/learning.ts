import { buildObservedClaims, classifyTask, explainBackPolicy, scrubEvidence, permitsExplainNavigation, isExplainHelpRequest, requestsFirstExplainReview, assessSupportedAnswer, assessSupportedReview, assessmentSpec, validateSourceAssessment, KNOWLEDGE } from "@prentice/domain";
import type { EvidencePacket, ExplainQuestion, LearningConcept, UnderstandArtifact, ExplainSessionState, TeachingSupport, PracticeAssessment } from "@prentice/domain";

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
  const concepts = learningConcepts(result.json, summary, packet);
  // A sentence naming a path Prentice never recorded is dropped; the rest of the explanation stays.
  const keep = (line: string) => !mentionsUnknownPath(line, packet, summary);
  const sections = raw
    ? { observed: raw.observed.filter(keep), agentStated: raw.agentStated.filter(keep), notRecorded: raw.notRecorded.filter(keep), inferences: raw.inferences.filter(keep) }
    : null;
  if (!sections || sections.observed.length + sections.agentStated.length + sections.notRecorded.length + sections.inferences.length === 0) {
    return {
      ...artifact,
      learning: {
        available: false,
        message: "The Learning AI response was not used because it was not grounded in the recorded evidence.",
        explanation: null,
      },
    };
  }
  return { ...artifact, learning: { available: true, message: "Explained from the recorded evidence.", explanation: renderSections(sections), concepts } };
}

export interface ExplanationSections {
  observed: string[];
  agentStated: string[];
  notRecorded: string[];
  inferences: string[];
}

/**
 * Observed sentences are generated from typed evidence; original agent statements retain their attribution.
 * All model prose is interpretation, irrespective of the section the model chooses.
 */
export function explanationSections(value: unknown, summary: EvidenceSummary): ExplanationSections | null {
  const record = objectRecord(value);
  if (!record) return null;
  const list = (key: string) =>
    Array.isArray(record[key]) ? (record[key] as unknown[]).filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : [];
  const observed = (summary.facts ?? []).map((fact) => fact.text);
  const agentStated = summary.agentStated.map((claim) => claim.text);
  const inferences = [...list("observed"), ...list("agentStated"), ...list("inferences")].filter((sentence) => !observed.includes(sentence) && !agentStated.includes(sentence));
  const legacy = stringField(value, "explanation");
  if (legacy) inferences.push(legacy);
  const notRecorded = list("notRecorded");
  if (summary.outcome === "interrupted") notRecorded.unshift("The task was interrupted; intended completion and success were not recorded.");
  if (summary.attribution === "unavailable") notRecorded.unshift("File attribution for this turn is unavailable.");
  if (![observed, agentStated, inferences, notRecorded].some((items) => items.length)) return null;
  return { observed, agentStated, inferences, notRecorded };
}

function renderSections(sections: ExplanationSections): string {
  const parts: string[] = [];
  if (sections.observed.length) parts.push(`Observed\n${sections.observed.map((line) => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`);
  if (sections.agentStated.length) parts.push(`Agent stated\n${sections.agentStated.map((line) => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`);
  if (sections.inferences.length) parts.push(`Interpretation (Learning AI)\n${sections.inferences.map((line) => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`);
  if (sections.notRecorded.length) parts.push(`Not recorded\n${sections.notRecorded.map((line) => `- ${line.replace(/\s*\n\s*/g, " ")}`).join("\n")}`);
  return parts.join("\n\n");
}

export async function phraseQuestion(packet: EvidencePacket, question: ExplainQuestion): Promise<string | null> {
  if (question.support?.kind === "source-backed") return question.prompt;
  if (question.expectedPoints.some((point) => point.length > LEARNING_LIMITS.factChars)) return null;
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
): Promise<{ ok: true; understood: boolean; feedback: string; hint: string; assessment: PracticeAssessment } | { ok: false; message: string }> {
  if (question.expectedPoints.some((point) => point.length > LEARNING_LIMITS.factChars)) return { ok: false, message: UNAVAILABLE };
  const result = await ask("judge", {
    evidence: evidenceSummary(packet),
    fact: question.expectedPoints,
    concept: question.concept,
    teaching: question.teaching,
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
    understood: false,
    assessment: provisionalAssessment(record, answerShowsReasoning(answer, question) && !inventoryAnswer(packet, answer)),
    feedback: ( (!answerShowsReasoning(answer, question) || inventoryAnswer(packet, answer)) ? "Explain how it works or why the decision matters in your own words; naming it is not enough." : typeof record.feedback === "string" ? record.feedback : "That does not match the recorded change yet.") + " Practice feedback is provisional; this has not been marked as demonstrated understanding.",
    hint: typeof record.hint === "string" ? record.hint : "Look at the recorded diff and say what it shows.",
  };
}

export async function discussLearning(
  packet: EvidencePacket,
  question: string,
  concepts: LearningConcept[] = [],
): Promise<{ kind: "observed" | "agent-stated" | "general" | "unrecorded" | "inference"; text: string } | { ok: false; message: string }> {
  const summary = evidenceSummary(packet);
  const result = await ask("discuss", { evidence: summary, question, lessons: concepts.slice(0, 4).map(concept => ({ title: concept.title, explanation: concept.explanation.slice(0, 800), mechanism: concept.mechanism.slice(0, 800), grounding: "inference" })) });
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
  if (kind === "observed") {
    const fact = summary.facts?.find((item) => item.id === record?.factId);
    return fact ? { kind: "observed", text: fact.text } : { kind: "inference", text };
  }
  if (kind === "agent-stated") {
    const claim = summary.agentStated.find((item) => item.text === text);
    return claim ? { kind, text } : { kind: "inference", text };
  }
  return { kind, text };
}

/** A bounded dialogue window supports clarification and reviewing an actual previous answer. */
export async function converseLearning(packet: EvidencePacket, state: ExplainSessionState, message: string) {
  const allReviewable = (state.turns ?? []).filter(turn => turn.assessed || turn.assessment);
  const firstAnswer=allReviewable.find(turn=>!turn.reviewOf&&!isExplainHelpRequest(turn.message));
  let reviewable = allReviewable.slice(-6);
  if(requestsFirstExplainReview(message)&&firstAnswer)reviewable=[firstAnswer,...reviewable.filter(turn=>turn.id!==firstAnswer.id).slice(-5)];
  const originalAnswer = (turn: typeof reviewable[number]) => { const root=(state.turns??[]).find(t=>t.id===(turn.reviewOf??turn.id))??turn;return root.evaluatedAnswer??root.message; };
  let previous = reviewable.at(-1);
  let previousQuestion = state.asked.find(question => question.id === previous?.questionId) ?? null;
  const present = (question: ExplainQuestion | null) => question ? {
    id: question.id,
    prompt: question.prompt, concept: question.concept, criteria: question.expectedPoints,
    teaching: question.teaching?.slice(0, 3000), support: question.support ? {kind:question.support.kind,scope:question.support.scope,revision:question.support.revision,unitIds:question.support.unitIds.slice(0,3),sources:question.support.sources.slice(0,7).map(s=>({id:s.id,url:s.url}))} : undefined, grounding: "inference",
  } : null;
  // No task prompt or unrestricted local transcript is included in this dialogue window.
  const history = (state.turns ?? []).filter(turn => turn.status === "replied").slice(-6).map(turn => ({
    support: turn.support ? {kind:turn.support.kind,mode:turn.support.mode,unitIds:turn.support.unitIds.slice(0,3)} : undefined, assessment: turn.assessment ? turn.assessment.status==='assessed'?{status:turn.assessment.status,outcome:turn.assessment.outcome}:{status:turn.assessment.status,tentative:turn.assessment.tentative} : undefined,
    message: turn.message.slice(0, 1200), reply: turn.response?.slice(0, 1200),
    ...(turn.message.length > 1200 ? { messageTruncated: true } : {}),
    ...((turn.response?.length ?? 0) > 1200 ? { replyTruncated: true } : {}), assessed: turn.assessed, understood: turn.understood,
    question: turn.prompt?.slice(0, 1000), hint: turn.hint?.slice(0, 1500), teaching: turn.teaching?.slice(0, 3000),
  }));
  const result = await ask("tutor", {
    evidence: evidenceSummary(packet), current: present(state.current), phase: state.phase,
    topics: state.candidates.slice(0, 4).map(question => ({ ...present(question), understood: state.feedback.understood.includes(question.concept) })),
    coaching: state.current ? { attempts: state.attempts, hint: state.hint?.slice(0, 1500), revisit: state.teaching?.slice(0, 3000) } : null,
    previous: previous && previousQuestion ? { ...present(previousQuestion), answer: originalAnswer(previous).slice(0, 8000), evaluation: previous.response?.slice(0, 1200) } : null,
    reviews: reviewable.map(turn => ({ ...present(state.asked.find(question => question.id === turn.questionId) ?? null), id: turn.id, ...(turn.id===firstAnswer?.id?{first:true}:{}), answer: originalAnswer(turn).slice(0, 2000), answerTruncated:originalAnswer(turn).length>2000, evaluation: turn.response?.slice(0, 600) })),
    history, message,
  });
  if (!result.ok) return result;
  const record = objectRecord(result.json);
  const intent = record?.intent;
  const text = typeof record?.text === "string" ? record.text.trim().slice(0, 6000) : "";
  if (!["answer", "discuss", "teach", "review", "practice", "revisit", "continue", "finish", "skip"].includes(String(intent)) || !text ||
      ((intent === "answer" || intent === "review") && typeof record?.understood !== "boolean")) {
    return { ok: false as const, message: "Prentice could not complete this reply. Retry this message; your conversation is saved." };
  }
  if (intent === "answer" && isExplainHelpRequest(message)) return { ok: false as const, message: "Prentice could not answer that help request correctly. Your message is saved; retry it. No practice attempt was counted." };
  if (intent === "review" && typeof record?.reviewTurnId === "string") {
    const selected = reviewable.find(turn => turn.id === record.reviewTurnId);
    if (!selected) return { ok: false as const, message: "Prentice could not identify the answer to review. Please clarify which answer you mean." };
    previous = selected;
    previousQuestion = state.asked.find(question => question.id === selected.questionId) ?? null;
  }
  // A classification error must not silently consume a question.
  if ((intent === "continue" || intent === "finish" || intent === "skip") && !permitsExplainNavigation(message, intent)) return {
    ok: true as const, intent: "discuss" as const, target: null, understood: false, assessment: undefined, support: undefined, evaluatedAnswer: message,
    text: state.current ? "We can keep discussing this concept, or you can choose to practise explaining it." : "This check has concluded. What would you like to discuss about these concepts?", hint: "", reviewOf: undefined, revisitId: undefined,
  };
  const target = intent === "review" ? previousQuestion : state.current;
  if (intent === "revisit" && (!record?.questionId || !state.candidates.some(question => question.id === record.questionId))) {
    return { ok: false as const, message: "Which concept would you like to revisit? Your message is saved; name the concept in a new message." };
  }
  const original=previous?originalAnswer(previous):"";
  const evaluated = intent === "review" ? `${original}\n${message}` : message;
  const reasoning = Boolean(target && answerShowsReasoning(evaluated, target) && !inventoryAnswer(packet, evaluated));
  const support=readTeachingSupport(record?.support);
  let assessment:PracticeAssessment|undefined;
  if(intent==='answer'||intent==='review'){
    const sourced=await validateSourceAssessment(record?.assessment,target,evaluated);
    if(sourced&&(sourced.outcome!=='understood'||reasoning)&&support?.kind==='source-backed'&&support.revision===sourced.revision&&sourced.proof.criteria.every(c=>support.sources.some(s=>s.id===c.sourceId&&s.url===KNOWLEDGE.find(k=>k.id===c.sourceId)?.source)))assessment=sourced;
    else {
    assessment=intent==='review'?assessSupportedReview(target,original,message):assessSupportedAnswer(target,message);
    // Recompute from the full local answer and local question. Never trust a cloud
    // assessment certificate, a positive model verdict, or a truncated quote.
    const spec=assessmentSpec(target);
    if((assessment.status==='assessed'&&assessment.outcome==='understood'&&!reasoning)||support?.kind!=='source-backed'||support.revision!==target?.support?.revision||!support.unitIds.includes(spec?.id??'')||!spec?.sources.every(url=>support.sources.some(s=>s.url===url)))assessment=provisionalAssessment(record,reasoning);
    }
  }
  const understood=assessment?.status==='assessed'&&assessment.outcome==='understood';
  const hint = typeof record?.hint === "string" ? record.hint.trim().slice(0, 1500) : "";
  if (mentionsUnknownPath(`${text}\n${hint}`, packet, evidenceSummary(packet))) return {
    ok: true as const, intent: "discuss" as const, target: null, understood: false, assessment: undefined, support: undefined, evaluatedAnswer: message,
    text: "That application was not recorded for this task. We can discuss the general concept instead.", hint: "",
    reviewOf: undefined, revisitId: undefined,
  };
  const guardedText = record?.understood === true && !reasoning && (intent === "answer" || intent === "review")
    ? "Please explain the mechanism or reasoning in your own words. Naming it or agreeing does not establish understanding."
    : text;
  return {
    ok: true as const, intent: intent as "answer" | "discuss" | "teach" | "review" | "practice" | "revisit" | "continue" | "finish" | "skip", target,
    understood, assessment, support: readTeachingSupport(record?.support), evaluatedAnswer: evaluated.slice(0, 8000),
    text: assessment?.status === "provisional" && !guardedText.includes("provisional") ? `${guardedText}\n\nPractice feedback is provisional; this has not been marked as demonstrated understanding.` : guardedText,
    hint,
    teaching: typeof record?.teaching === "string" ? record.teaching.trim().slice(0, 6000) : undefined,
    reviewOf: intent === "review" ? previous?.reviewOf ?? previous?.id : undefined,
    revisitId: typeof record?.questionId === "string" ? record.questionId : state.current?.id,
  };
}

export const learningUnavailableMessage = UNAVAILABLE;

async function ask(
  action: "explain" | "phrase" | "judge" | "discuss" | "tutor",
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
      body: JSON.stringify(scrubEvidence({ action, ...payload })),
    });
    if (!response.ok) {
      // Only a typed consistency failure has a distinct public explanation.
      // Never display arbitrary provider errors or model-written review details.
      const failure = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
      return { ok: false, message: failure?.error?.code === "TEACHING_UNRELIABLE"
        ? "Prentice could not verify the technical consistency of this reply, so it was not used. Your conversation is saved; retry or ask a narrower question. No practice attempt was counted."
        : UNAVAILABLE };
    }
    const body = (await response.json().catch(() => null)) as { result?: unknown } | null;
    if (!body || body.result === undefined) return { ok: false, message: UNAVAILABLE };
    return { ok: true, json: scrubEvidence(body.result) };
  } catch {
    return { ok: false, message: UNAVAILABLE };
  }
}

/** Caps on what leaves this computer for the Learning AI. */
export const LEARNING_LIMITS = { agentStatements: 6, agentStatementChars: 1_200, agentTotalChars: 3_000, failureOutputChars: 1_500, commandChars: 1_000, factChars: 1_000 };

export interface EvidenceSummary {
  scope?: { complexity: "low" | "moderate" | "high"; maxConcepts: number; categories?: string[] };
  outcome?: EvidencePacket["outcome"];
  attribution?: EvidencePacket["attribution"];
  facts?: Array<{ id: string; text: string }>;
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
  agentStated: Array<{ id?: string; label: "Agent stated"; text: string; truncated: boolean }>;
}

/**
 * The bounded summary the connector sends to the Prentice cloud. It never contains the original prompt,
 * file contents, or diffs. Agent messages are capped and labelled as Agent stated.
 */
export function evidenceSummary(packet: EvidencePacket): EvidenceSummary {
  packet = scrubEvidence(packet);
  const agentStated: EvidenceSummary["agentStated"] = [];
  const inlineCommands = new Set(packet.activity.filter(item => item.command && hasInlineContent(item.command)).map(item => item.evidenceId));
  let total = 0;
  for (const item of packet.activity.filter(item => item.kind === "assistant" && item.detail).slice(-LEARNING_LIMITS.agentStatements).reverse()) {
    if (!item.detail) continue;
    if (agentStated.length >= LEARNING_LIMITS.agentStatements || total >= LEARNING_LIMITS.agentTotalChars) break;
    const room = Math.min(LEARNING_LIMITS.agentStatementChars, LEARNING_LIMITS.agentTotalChars - total);
    const safeDetail = (packet.prompt.trim() ? item.detail.split(packet.prompt).join("[user request omitted]") : item.detail)
      .replace(/```[\s\S]*?(?:```|$)/g, "[code block omitted]");
    const split = Math.floor((room - 20) * 0.65);
    const text = safeDetail.length > room ? `${safeDetail.slice(0, split)} …[excerpt]… ${safeDetail.slice(-(room - split - 20))}` : safeDetail;
    total += text.length;
    agentStated.push({ id: item.evidenceId, label: "Agent stated", text, truncated: text.length < item.detail.length });
  }
  agentStated.reverse();
  const classification = classifyTask(packet.prompt);
  const complexity = classification.complexity;
  const policy = explainBackPolicy({ complexity, changedFiles: packet.files.length, changedSymbols: packet.symbols.length });
  return {
    scope: { complexity, maxConcepts: policy.maxInitialQuestions, categories: classification.signals.categories },
    outcome: packet.outcome,
    attribution: packet.attribution,
    // Omit oversized facts rather than truncating their canonical text or changing their IDs.
    facts: buildObservedClaims(packet).map((fact, index) => ({ id: `fact:${index}`, text: fact.text })).filter((fact) => fact.text.length <= LEARNING_LIMITS.factChars && !/^(Added|Removed|Updated) (function|method|class|other) /i.test(fact.text) && !(fact.text.startsWith("Command ") && hasInlineContent(fact.text))).slice(0, 240),
    observed: {
      files: packet.files.slice(0, 80).map((file) => ({ path: file.path, change: file.change, additions: file.additions, deletions: file.deletions })),
      symbols: [], // A symbol inventory cannot establish behavior and encourages naming trivia. It stays local.
      commands: packet.activity
        .filter((item) => item.kind === "command.finished").slice(-30)
        .map((item) => ({
          command: inlineCommands.has(item.evidenceId) ? undefined : item.command && item.command.length > LEARNING_LIMITS.commandChars ? `${item.command.slice(0, LEARNING_LIMITS.commandChars - 1)}…` : item.command,
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
      sessionFailures: packet.activity.filter((item) => item.kind === "session.failed").map((item) => (item.detail ?? "").slice(0, LEARNING_LIMITS.failureOutputChars)).filter(Boolean),
      unparsedFiles: packet.unparsedFiles.slice(0, 80),
    },
    agentStated,
  };
}

/** A path counts as known when git changed it or it appears in what Prentice observed, such as failure output. */
export function mentionsUnknownPath(text: string, packet: EvidencePacket, summary: EvidenceSummary = evidenceSummary(packet)): boolean {
  const known = new Set(packet.files.slice(0, 80).map((file) => file.path));
  const observedText = JSON.stringify(summary.observed);
  const paths = text.replace(/\bhttps?:\/\/[^\s<>)]*/g, "").match(/[\w./-]+\.[A-Za-z0-9]+/g) ?? [];
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

/** A citation anchors a topic, not the truth of generated teaching. Model prose stays interpretation. */
export function learningConcepts(value: unknown, summary: EvidenceSummary, packet: EvidencePacket): LearningConcept[] {
  const raw = objectRecord(value)?.concepts;
  if (!Array.isArray(raw)) return [];
  const basis = new Map<string, LearningConcept["basis"][number]>();
  for (const fact of summary.facts ?? []) basis.set(fact.id, { ...fact, kind: "observed" });
  for (const claim of summary.agentStated) if (claim.id) basis.set(claim.id, { id: claim.id, text: claim.text, kind: "agent-stated" });
  const concepts: LearningConcept[] = [];
  const identifiers = new Set([...packet.symbols.map(s => s.name.toLowerCase()), ...packet.files.map(f => f.path.toLowerCase())]);
  for (const item of raw.slice(0, Math.min(4, summary.scope?.maxConcepts ?? 4))) {
    const record = objectRecord(item);
    if (!record) continue;
    const fields = ["title", "explanation", "mechanism", "tradeoff", "transfer", "question"] as const;
    if (fields.some(key => typeof record[key] !== "string" || !(record[key] as string).trim() || (record[key] as string).length > 1800)) continue;
    const refs = Array.isArray(record.basisIds) ? record.basisIds : [];
    if (!refs.length || refs.length > 12 || refs.some(id => typeof id !== "string" || !basis.has(id))) continue;
    const points = record.expectedPoints;
    if (!Array.isArray(points) || points.length < 2 || points.length > 4 || points.some(p => typeof p !== "string" || p.length > 600 || p.trim().split(/\s+/).length < 3 || identifiers.has(p.toLowerCase()))) continue;
    const strings = Object.fromEntries(fields.map(key => [key, (record[key] as string).trim().replace(/\s*\(fact:\d+\)/g, "")])) as Pick<LearningConcept, typeof fields[number]>;
    if (!/\b(how|why|what|when|predict|explain|compare|suppose|imagine)\b/i.test(strings.question)) continue;
    if (/\b(which|name|identify)\b.*\b(function|file|method|symbol)\b/i.test(strings.question)) continue;
    if (identifiers.has(strings.title.toLowerCase())) continue;
    if (Object.values(strings).some(text => mentionsUnknownPath(text, packet, summary))) continue;
    // Do not let locally known names rescue prose that invented a function's behavior from its name.
    const specificNames = packet.symbols.filter(symbol => /[a-z][A-Z_]/.test(symbol.name)).map(symbol => symbol.name);
    const citedAgentText = refs.map(id => basis.get(id as string)!).filter(item => item.kind === "agent-stated").map(item => item.text).join(" ");
    if (specificNames.some(name => Object.values(strings).some(text => text.includes(name)) && !citedAgentText.includes(name))) continue;
    if (concepts.some(c => c.title.toLowerCase() === strings.title.toLowerCase())) continue;
    concepts.push({ ...strings, expectedPoints: points as string[], grounding: "inference", support: readTeachingSupport(record.support), basis: refs.map(id => basis.get(id as string)!) });
  }
  return concepts;
}

export function answerShowsReasoning(answer: string, question: ExplainQuestion): boolean {
  const text = answer.trim().toLowerCase();
  if (question.grounding !== "inference") return true; // Legacy stored questions retain their original rubric.
  if (text.split(/\s+/).length < 6) return false;
  if (text === question.expectedPoints.join(" ").toLowerCase() || text === question.expectedPoints.join(", ").toLowerCase()) return false;
  const names = question.citations.flatMap(c => [c.file, c.symbol]).filter(Boolean) as string[];
  const withoutNames = names.reduce((s, name) => s.split(name.toLowerCase()).join(""), text);
  return withoutNames.trim().split(/\s+/).length >= 6;
}


function inventoryAnswer(packet: EvidencePacket, answer: string): boolean {
  let text = answer.toLowerCase();
  for (const name of [...packet.symbols.map(s => s.name), ...packet.files.map(f => f.path)].sort((a,b) => b.length-a.length)) text = text.split(name.toLowerCase()).join(" ");
  text = text.replace(/\b(the|a|an|and|was|were|is|in|added|modified|updated|removed|deleted|function|method|file|functions|files|new|created)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return text.length === 0;
}


/** Inline scripts and heredocs can contain whole files. Only their outcome may leave the computer. */
function hasInlineContent(command: string): boolean {
  return /<<|[\r\n]|(?:^|\s)(?:-e|--eval|-c|--command)(?:\s|=)|\b(?:echo|printf)\b|>>?/.test(command);
}

/** Model or legacy-cloud verdicts cannot self-certify an open-ended assessment. */
function provisionalAssessment(record:Record<string,unknown>|null,reasoning:boolean):PracticeAssessment{
 const supplied=objectRecord(record?.assessment);
 const tentative=reasoning?(supplied?.tentative==='understood'||supplied?.tentative==='needs-work'?supplied.tentative:record?.understood===true?'understood':record?.understood===false?'needs-work':'uncertain'):'uncertain';
 return {status:'provisional',tentative,reason:typeof supplied?.reason==='string'?supplied.reason.slice(0,1200):'Open-ended model feedback is provisional; no verified mastery or failed attempt was recorded.'};
}
function readTeachingSupport(value:unknown):TeachingSupport|undefined{
 const r=objectRecord(value);if(!r||!['source-backed','provisional'].includes(String(r.kind))||r.scope!=='general'||typeof r.revision!=='string'||r.revision.length>80||!Array.isArray(r.unitIds)||r.unitIds.length>12||r.unitIds.some(x=>typeof x!=='string'||x.length>100)||!Array.isArray(r.sources)||r.sources.length>7)return;
 const sources:TeachingSupport['sources']=[];
 for(const item of r.sources){const s=objectRecord(item);if(!s||['id','title','url','reviewedOn'].some(k=>typeof s[k]!=='string'||(s[k] as string).length>400))return;
  try{const url=new URL(s.url as string);if(url.protocol!=='https:'||!['docs.aws.amazon.com','www.postgresql.org','developer.mozilla.org','cheatsheetseries.owasp.org','nodejs.org','www.typescriptlang.org','aws.amazon.com'].includes(url.hostname))return;}catch{return;}
  sources.push({id:s.id as string,title:s.title as string,url:s.url as string,reviewedOn:s.reviewedOn as string});
 }
 if(r.kind==='source-backed'&&(!sources.length||!r.unitIds.length))return;
 return {kind:r.kind as TeachingSupport['kind'],scope:'general',revision:r.revision,unitIds:r.unitIds as string[],sources,mode:typeof r.mode==='string'?r.mode.slice(0,30):undefined};
}
