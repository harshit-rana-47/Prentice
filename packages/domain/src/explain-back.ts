import type {
  EvidencePacket,
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
  const { complexity, changedSymbols, changedFiles } = input;
  if (complexity === "low" && changedFiles <= 2 && changedSymbols <= 3) {
    return { offerSkip: true, maxInitialQuestions: 1, maxFollowUps: 1, depth: "optional" };
  }
  if (complexity === "high" || changedFiles >= 6 || changedSymbols >= 8) {
    return { offerSkip: true, maxInitialQuestions: 4, maxFollowUps: 3, depth: "deep" };
  }
  return { offerSkip: true, maxInitialQuestions: 2, maxFollowUps: 2, depth: "moderate" };
}

type EvidenceComplexity = "low" | "moderate" | "high";

export function draftCandidateQuestions(packet: EvidencePacket, policy: ExplainBackPolicy): ExplainQuestion[] {
  const questions: ExplainQuestion[] = [];
  for (const symbol of packet.symbols) {
    if (questions.length >= policy.maxInitialQuestions) break;
    questions.push({
      id: nextId(),
      prompt:
        symbol.change === "added"
          ? `Which new ${symbol.kind} was added in ${symbol.path}?`
          : `What happened to ${symbol.kind} ${symbol.name} in ${symbol.path}?`,
      concept: symbol.name,
      expectedPoints: [symbol.name, symbol.change],
      grounding: "observed",
      citations: [{ evidenceId: symbol.evidenceId, file: symbol.path, symbol: symbol.name }],
    });
  }
  if (questions.length < policy.maxInitialQuestions && packet.files.length > 0) {
    const file = packet.files[0]!;
    questions.push({
      id: nextId(),
      prompt: `What kind of change did git record for ${file.path}?`,
      concept: file.path,
      expectedPoints: [file.path.split("/").pop() ?? file.path, file.change],
      grounding: "observed",
      citations: [{ evidenceId: file.evidenceId, file: file.path }],
    });
  }
  for (const item of packet.activity) {
    if (questions.length >= policy.maxInitialQuestions) break;
    if (item.kind !== "command.finished" || item.exitCode === 0 || item.exitCode == null || !item.command) continue;
    questions.push({
      id: nextId(),
      prompt: `What did the failing command report?`,
      concept: item.command,
      expectedPoints: [item.command, String(item.exitCode)],
      grounding: "observed",
      citations: [{ evidenceId: item.evidenceId }],
    });
  }
  if (questions.length < policy.maxInitialQuestions && packet.tests) {
    questions.push({
      id: nextId(),
      prompt: "What did the test run report?",
      concept: "tests",
      expectedPoints: [`${packet.tests.failed} failed`, `${packet.tests.passed} passed`],
      grounding: "observed",
      citations: [{ evidenceId: packet.tests.evidenceId }],
    });
  }
  return questions.slice(0, policy.maxInitialQuestions);
}

export function startExplainSession(
  packet: EvidencePacket,
  complexity: EvidenceComplexity,
  knownConcepts: string[] = [],
): ExplainSessionState {
  const policy = explainBackPolicy({
    complexity,
    changedSymbols: packet.symbols.length,
    changedFiles: packet.files.length,
  });
  const candidates = preferUnfamiliar(draftCandidateQuestions(packet, policy), knownConcepts);
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
  return { ...state, phase: "skipped", current: null, hint: null };
}

export function applyExplainJudgment(
  state: ExplainSessionState,
  judgment: { understood: boolean; feedback: string; hint: string },
): ExplainSessionState {
  state = normalizeExplain(state);
  if ((state.phase !== "asking" && state.phase !== "taught") || !state.current) return state;
  if (judgment.understood) {
    const feedback = mergeFeedback(state.feedback, { understood: state.current.expectedPoints, unclear: [] }, state.current);
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
    attempts: state.attempts + 1,
    hint: state.hint ?? hint,
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
  return unfamiliar.length > 0 ? unfamiliar : questions;
}

function advance(state: ExplainSessionState, feedback: ExplainFeedback): ExplainSessionState {
  const askedIds = new Set(state.asked.map((question) => question.id));
  const remaining = state.candidates.filter((question) => !askedIds.has(question.id) && question.id !== state.current?.id);
  const shouldContinue =
    state.policy.depth !== "optional" && remaining.length > 0 && state.initialAsked < state.policy.maxInitialQuestions;
  if (!shouldContinue || !remaining[0]) {
    return { ...state, phase: "done", current: null, feedback, hint: null, teaching: null };
  }
  const next = remaining[0];
  return {
    ...state,
    phase: "asking",
    current: next,
    asked: [...state.asked, next],
    feedback,
    initialAsked: state.initialAsked + 1,
    attempts: 0,
    hint: null,
    teaching: null,
  };
}

function mergeFeedback(existing: ExplainFeedback, judged: ExplainFeedback, question: ExplainQuestion): ExplainFeedback {
  const understood = new Set(existing.understood);
  const unclear = new Set(existing.unclear);
  if (judged.unclear.length === 0) {
    understood.add(question.concept);
    unclear.delete(question.concept);
  } else {
    for (const point of judged.understood) understood.add(point);
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
  const lower = text.toLowerCase();
  return question.expectedPoints.some((point) => point.length > 2 && lower.includes(point.toLowerCase()));
}

function hintFor(question: ExplainQuestion): string {
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
