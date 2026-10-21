import type {
  EvidencePacket,
  LearningConcept,
  ExplainBackPolicy,
  ExplainDiscussion,
  ExplainFeedback,
  ExplainQuestion,
  ExplainSessionState,
} from "./types.js";

let questionCounter = 0;

export function resetQuestionIds(start = 0): void {
  questionCounter = start;
}

export function explainBackPolicy(input: {
  complexity: EvidenceComplexity;
  changedSymbols: number;
  changedFiles: number;
}): ExplainBackPolicy {
  const { complexity, changedFiles } = input;
  if (complexity === "low" && changedFiles <= 2) {
    return { offerSkip: true, maxInitialQuestions: 1, maxFollowUps: 1, depth: "optional" };
  }
  if (complexity === "high" || changedFiles >= 6) {
    return { offerSkip: true, maxInitialQuestions: 4, maxFollowUps: 3, depth: "deep" };
  }
  return { offerSkip: true, maxInitialQuestions: 2, maxFollowUps: 2, depth: "moderate" };
}

type EvidenceComplexity = "low" | "moderate" | "high";

/** Lessons, not symbol metadata, define the reasoning checks. No lesson means no trivia fallback. */
export function draftCandidateQuestions(_packet: EvidencePacket, policy: ExplainBackPolicy, concepts: LearningConcept[] = []): ExplainQuestion[] {
  return concepts.slice(0, policy.maxInitialQuestions).map(concept => ({
    id: nextId(), prompt: concept.question, concept: concept.title,
    expectedPoints: concept.expectedPoints, grounding: "inference",
    citations: concept.basis.map(item => ({ evidenceId: item.id })),
    support: concept.support,
    teaching: `${concept.explanation} ${concept.mechanism} ${concept.tradeoff} ${concept.transfer}`,
  }));
}

export function startExplainSession(
  packet: EvidencePacket,
  complexity: EvidenceComplexity,
  knownConcepts: string[] = [],
  concepts: LearningConcept[] = [],
): ExplainSessionState {
  const policy = explainBackPolicy({
    complexity,
    changedSymbols: packet.symbols.length,
    changedFiles: packet.files.length,
  });
  const candidates = preferUnfamiliar(draftCandidateQuestions(packet, policy, concepts), knownConcepts);
  const current = candidates[0] ?? null;
  return {
    phase: current ? "asking" : "done",
    policy,
    candidates,
    asked: current ? [current] : [],
    current,
    feedback: { understood: [], unclear: [] },
    followUpsAsked: 0,
    initialAsked: current ? 1 : 0,
    attempts: 0,
    hint: null,
    teaching: null,
    coach: null,
    learningMessage: null,
    discussion: [],
  };
}

export function skipExplainSession(state: ExplainSessionState): ExplainSessionState {
  return { ...rememberPractice(state), phase: "skipped", current: null, returnTo: null, hint: null, learningMessage: null };
}

/** Teaching and practice are choices; neither transition demonstrates mastery. */
export function teachExplainSession(state: ExplainSessionState): ExplainSessionState {
  if (!state.current || (state.phase !== "asking" && state.phase !== "taught")) return state;
  return { ...state, phase: "taught", teaching: state.current.teaching ?? null };
}

export function practiseExplainSession(state: ExplainSessionState): ExplainSessionState {
  if (!state.current || (state.phase !== "asking" && state.phase !== "taught")) return state;
  return { ...state, phase: "asking", learningMessage: null };
}

export function finishExplainSession(state: ExplainSessionState): ExplainSessionState {
  return { ...rememberPractice(state), phase: "done", current: null, returnTo: null, hint: null, teaching: null, learningMessage: null };
}

/** A temporary revisit preserves the interrupted concept and its attempt count. */
export function revisitExplainSession(state: ExplainSessionState, questionId: string): ExplainSessionState {
  const question = state.candidates.find(item => item.id === questionId);
  if (!question || state.phase === "unavailable") return state;
  if (state.current?.id === questionId) return teachExplainSession(state);
  const saved = rememberPractice(state);
  return openPractice({ ...saved, returnTo: state.returnTo ?? state.current?.id ?? null }, question, "taught");
}

/** Navigation needs an explicit learner request, never a model's inference from difficulty. */
export function permitsExplainNavigation(message: string, intent: "continue" | "finish" | "skip"): boolean {
  if (/\b(don't|do not|not ready to) (?:want to )?(move|go|skip|finish|end|stop)|\bnot done\b/i.test(message)) return false;
  if (intent === "finish") return /\b(finish|end|stop|quit) (?:this |the |our )?(learning|session|check|quiz)|\b(stop for now|i'?m done|i am done|that'?s enough|finish up)\b/i.test(message);
  if (intent === "skip") return /\bskip\b/i.test(message);
  return /\b(next (?:concept|question|topic)|move on|move to the next|go (?:on|ahead)|continue to the next)\b|^(?:ok(?:ay)?[, ]*)?next(?: please)?[.!]?$/i.test(message.trim());
}

/** Clear help/question forms cannot consume an answer attempt on a routing error. */
export function requestsFirstExplainReview(message:string):boolean {
  return /^(?:(?:please )?(?:review|reassess|re[- ]?evaluate) (?:my |the )?(?:first|initial) (?:answer|explanation)|my (?:first|initial) (?:answer|explanation) was (?:actually )?(?:correct|right)|was my (?:first|initial) (?:answer|explanation) (?:correct|right))[.!?]*$/i.test(message.trim());
}

export function isExplainHelpRequest(message: string): boolean {
  return /\?\s*$/.test(message) || /^(?:please[, ]+)?(?:explain|teach|show|help|give me|can you|could you|would you)\b/i.test(message.trim())
    || /^(?:what|why|how) (?:does|do|is|are|can|would|should|will|did|could)\b|^what happens (?:if|when)\b/i.test(message.trim())
    || /^(?:i (?:need|want) (?:a |an |another |more )?(?:hint|clue|example|explanation|help)|(?:i )?(?:still )?(?:don't|do not) understand|another (?:hint|example)|more hints?)/i.test(message.trim());
}

function rememberPractice(state: ExplainSessionState): ExplainSessionState {
  if (!state.current || (state.phase !== "asking" && state.phase !== "taught")) return state;
  return { ...state, practiceState: { ...state.practiceState, [state.current.id]: {
    attempts: state.attempts, phase: state.phase, hint: state.hint, teaching: state.teaching, coach: state.coach,
  } } };
}

function openPractice(state: ExplainSessionState, question: ExplainQuestion, phase?: "asking" | "taught"): ExplainSessionState {
  const saved = state.practiceState?.[question.id];
  const asked = state.asked.some(item => item.id === question.id) ? state.asked : [...state.asked, question];
  return { ...state, current: question, asked, initialAsked: asked.length,
    phase: phase ?? saved?.phase ?? "asking", attempts: saved?.attempts ?? 0,
    hint: saved?.hint ?? null, teaching: saved?.teaching ?? null, coach: saved?.coach ?? null, learningMessage: null };
}

export function applyExplainJudgment(
  state: ExplainSessionState,
  judgment: { understood: boolean; feedback: string; hint: string },
): ExplainSessionState {
  state = normalizeExplain(state);
  if ((state.phase !== "asking" && state.phase !== "taught") || !state.current) return state;
  if (judgment.understood) {
    const feedback = mergeFeedback(state.feedback, { understood: [state.current.concept], unclear: [] }, state.current);
    return advance({ ...state, coach: judgment.feedback }, feedback);
  }
  const feedback = mergeFeedback(state.feedback, { understood: [], unclear: [state.current.concept] }, state.current);
  const hint = leaksAnswer(judgment.hint, state.current) ? hintFor(state.current) : judgment.hint;
  const coach = leaksAnswer(judgment.feedback, state.current) ? "That does not match the recorded change yet." : judgment.feedback;
  if (state.phase === "asking" && state.attempts < 1) {
    return { ...state, feedback, attempts: state.attempts + 1, hint, coach, teaching: null };
  }
  return {
    ...state,
    phase: "taught",
    feedback,
    attempts: Math.min(state.attempts + 1, state.policy.maxFollowUps + 1),
    hint: hint || state.hint,
    coach,
    teaching: recordedFact(state.current),
  };
}

export function submitExplainAnswer(state: ExplainSessionState, answer: string): ExplainSessionState {
  state = {
    ...state,
    attempts: state.attempts ?? 0,
    hint: state.hint ?? null,
    teaching: state.teaching ?? null,
    coach: state.coach ?? null,
    learningMessage: state.learningMessage ?? null,
    discussion: state.discussion ?? [],
  };
  if ((state.phase !== "asking" && state.phase !== "taught") || !state.current) return state;
  const judged = judgeAnswer(state.current, answer);
  const correct = judged.unclear.length === 0;
  if (correct) {
    const feedback = mergeFeedback(state.feedback, judged, state.current);
    return advance(state, feedback);
  }
  const feedback = mergeFeedback(state.feedback, judged, state.current);
  if (state.phase === "asking" && state.attempts < 1) {
    return {
      ...state,
      feedback,
      attempts: state.attempts + 1,
      hint: hintFor(state.current),
      teaching: null,
    };
  }
  return {
    ...state,
    phase: "taught",
    feedback,
    attempts: state.attempts + 1,
    hint: state.hint ?? hintFor(state.current),
    teaching: recordedFact(state.current),
  };
}

export function discussExplain(packet: EvidencePacket, question: string, state: ExplainSessionState): ExplainSessionState {
  const discussion = [...state.discussion, discussConcept(packet, question)];
  return { ...state, discussion };
}

export function judgeAnswer(question: ExplainQuestion, answer: string): ExplainFeedback {
  // Concept checks require semantic assessment by Learning AI; keyword matching cannot award mastery.
  if (question.grounding === "inference") return { understood: [], unclear: [question.concept] };
  const normalized = answer.toLowerCase();
  const understood: string[] = [];
  const unclear: string[] = [];
  for (const point of question.expectedPoints) {
    if (pointMatches(point, normalized)) understood.push(point);
    else unclear.push(point);
  }
  if (understood.length === 0 && unclear.length === 0) unclear.push(question.concept);
  return { understood, unclear };
}

export function discussConcept(packet: EvidencePacket, question: string): ExplainDiscussion {
  const text = question.trim();
  const lower = text.toLowerCase();
  const symbol = packet.symbols.find((item) => lower.includes(item.name.toLowerCase()));
  const file = packet.files.find((item) => lower.includes(item.path.toLowerCase()) || lower.includes(basename(item.path).toLowerCase()));
  const command = packet.activity.find((item) => item.command && lower.includes(item.command.toLowerCase()));
  const asksWhy = /\bwhy\b/.test(lower) && /\bagent\b|\bchose\b|\bdecided\b/.test(lower);
  if (asksWhy) {
    return {
      question: text,
      kind: "unrecorded",
      text: "The session did not record why the agent chose this. Prentice will not invent that reason.",
    };
  }
  if (symbol) {
    const verb = symbol.change === "added" ? "added" : symbol.change === "deleted" ? "removed" : "updated";
    return {
      question: text,
      kind: "observed",
      text: `Recorded from this task: ${verb} ${symbol.kind} ${symbol.name} in ${symbol.path}.`,
    };
  }
  if (file) {
    const verb = file.change === "added" ? "added" : file.change === "deleted" ? "removed" : "modified";
    return {
      question: text,
      kind: "observed",
      text: `Recorded from this task: git ${verb} ${file.path} (+${file.additions} / -${file.deletions}).`,
    };
  }
  if (command) {
    const exit = command.exitCode == null ? "without a recorded exit code" : `with exit ${command.exitCode}`;
    return {
      question: text,
      kind: "observed",
      text: `Recorded from this task: \`${command.command}\` finished ${exit}.`,
    };
  }
  if (packet.tests && /\btest/.test(lower)) {
    return {
      question: text,
      kind: "observed",
      text: `Recorded from this task: tests reported ${packet.tests.passed} passed and ${packet.tests.failed} failed.`,
    };
  }
  const general = generalConcept(lower);
  if (general) return { question: text, kind: "general", text: general };
  return {
    question: text,
    kind: "unrecorded",
    text: "That was not recorded for this task. Prentice will not guess about the repository.",
  };
}

function preferUnfamiliar(questions: ExplainQuestion[], knownConcepts: string[]): ExplainQuestion[] {
  const known = new Set(knownConcepts.map((concept) => concept.toLowerCase()));
  const unfamiliar = questions.filter((question) => !known.has(question.concept.toLowerCase()));
  return unfamiliar;
}

/** Moving on is explicit; a discussion or failed answer never consumes another concept. */
export function continueExplainSession(state: ExplainSessionState): ExplainSessionState {
  if (!state.current || state.phase === "skipped" || state.phase === "unavailable") return state;
  // Moving on without an attempt means unassessed, not incorrect.
  return advance(state, state.feedback);
}

function advance(state: ExplainSessionState, feedback: ExplainFeedback): ExplainSessionState {
  state = rememberPractice(state);
  const returning = state.candidates.find(question => question.id === state.returnTo && question.id !== state.current?.id);
  if (returning && !feedback.understood.includes(returning.concept)) {
    return openPractice({ ...state, feedback, returnTo: null }, returning);
  }
  state = { ...state, returnTo: null };
  const askedIds = new Set(state.asked.map((question) => question.id));
  const remaining = state.candidates.filter((question) => !askedIds.has(question.id) && question.id !== state.current?.id);
  const shouldContinue =
    state.policy.depth !== "optional" && remaining.length > 0 && state.initialAsked < state.policy.maxInitialQuestions;
  if (!shouldContinue || !remaining[0]) {
    return finishExplainSession({ ...state, feedback });
  }
  const next = remaining[0];
  return openPractice({ ...state, feedback }, next);
}

function mergeFeedback(existing: ExplainFeedback, judged: ExplainFeedback, question: ExplainQuestion): ExplainFeedback {
  const understood = new Set(existing.understood);
  const unclear = new Set(existing.unclear);
  if (judged.unclear.length === 0) {
    understood.add(question.concept);
    unclear.delete(question.concept);
  } else {
    unclear.add(question.concept);
  }
  for (const point of understood) unclear.delete(point);
  return { understood: [...understood], unclear: [...unclear] };
}

function normalizeExplain(state: ExplainSessionState): ExplainSessionState {
  return {
    ...state,
    attempts: state.attempts ?? 0,
    hint: state.hint ?? null,
    teaching: state.teaching ?? null,
    coach: state.coach ?? null,
    learningMessage: state.learningMessage ?? null,
    discussion: state.discussion ?? [],
  };
}

function leaksAnswer(text: string, question: ExplainQuestion): boolean {
  // Conceptual hints need to mention the mechanism. Literal rubric overlap is
  // only meaningful for the legacy name/recall checks, not semantic teaching.
  if (question.grounding === "inference") return false;
  const lower = text.toLowerCase();
  return question.expectedPoints.some((point) => point.length > 2 && lower.includes(point.toLowerCase()));
}

function hintFor(question: ExplainQuestion): string {
  if (question.grounding === "inference") return "Trace what happens step by step. What changes, why does it change, and where does this approach stop being enough?";
  const file = question.citations[0]?.file;
  if (question.concept === "tests") return "The session recorded a test tally. Say how many passed and how many failed.";
  if (question.citations[0]?.symbol) {
    return file
      ? `Look at the diff for ${file}. Name the ${question.prompt.includes("function") ? "function" : "symbol"} that changed, and say whether it was added, changed, or removed. This hint does not contain that name.`
      : "Look at the diff. Name the symbol that changed. This hint does not contain that name.";
  }
  if (question.expectedPoints.some((point) => /^\d+$/.test(point))) {
    return "A command in this session exited non-zero. Name that command and the exit code the session recorded.";
  }
  return file
    ? `Look at the diff for ${file}. Say whether git added, modified, or removed it, and include the file name.`
    : "Look at the diff. Say whether git added, modified, or removed the file.";
}

function recordedFact(question: ExplainQuestion): string {
  if (question.grounding === "inference") return question.teaching ?? "Review the concept lesson, then explain the mechanism in your own words.";
  const file = question.citations[0]?.file;
  const symbol = question.citations[0]?.symbol;
  const change = question.expectedPoints.find((point) => ["added", "modified", "deleted", "updated"].includes(point));
  if (symbol && file) return `Recorded from this task: ${symbol} was ${change ?? "changed"} in ${file}.`;
  if (file && change) return `Recorded from this task: git ${change} ${file}.`;
  if (question.concept === "tests") return `Recorded from this task: ${question.expectedPoints.join(" and ")}.`;
  return `Recorded from this task: ${question.expectedPoints.join(", ")}.`;
}

function pointMatches(point: string, answer: string): boolean {
  const token = point.toLowerCase();
  if (token.length > 0 && answer.includes(token)) return true;
  const synonyms: Record<string, string[]> = {
    modified: ["changed", "edited", "updated"],
    updated: ["changed", "modified", "edited"],
    added: ["created", "new"],
    deleted: ["removed"],
  };
  return (synonyms[token] ?? []).some((word) => answer.includes(word));
}

function generalConcept(question: string): string | null {
  if (/\bfunction\b/.test(question)) {
    return "In general, a function is a named piece of code that can be called. This is general teaching, not an extra fact about your repository.";
  }
  if (/\bgit\b/.test(question) && /\bmodif|\bchang|\badd|\bremov|\bdelet/.test(question)) {
    return "In general, git records a file as added, modified, or removed. Whether that happened in this task is only what the diff recorded. This sentence is general teaching.";
  }
  if (/\btest\b/.test(question)) {
    return "In general, a test run reports how many checks passed and how many failed. A failing count is the recorded result, not a diagnosis. This is general teaching.";
  }
  if (/\bcommand\b/.test(question) || /\bexit\b/.test(question)) {
    return "In general, a command finishes with an exit code. Zero means the command reported success. Any other code means it reported failure. This is general teaching, not a cause.";
  }
  return null;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function nextId(): string {
  questionCounter += 1;
  return `q${questionCounter}`;
}
