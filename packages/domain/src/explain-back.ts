import type { EvidencePacket, ExplainBackPolicy, ExplainFeedback, ExplainQuestion, ExplainSessionState } from "./types.js";

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
): ExplainSessionState {
  const policy = explainBackPolicy({
    complexity,
    changedSymbols: packet.symbols.length,
    changedFiles: packet.files.length,
  });
  const candidates = draftCandidateQuestions(packet, policy);
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
  };
}

export function skipExplainSession(state: ExplainSessionState): ExplainSessionState {
  return {
    ...state,
    phase: "skipped",
    current: null,
  };
}

export function submitExplainAnswer(state: ExplainSessionState, answer: string): ExplainSessionState {
  if (state.phase !== "asking" || !state.current) return state;
  const judged = judgeAnswer(state.current, answer);
  const feedback = mergeFeedback(state.feedback, judged, state.current);
  const followUp = judged.unclear.length > 0 ? narrowerFollowUp(state.current) : null;
  if (followUp && state.followUpsAsked < state.policy.maxFollowUps) {
    return {
      ...state,
      current: followUp,
      asked: [...state.asked, followUp],
      feedback,
      followUpsAsked: state.followUpsAsked + 1,
    };
  }

  const askedIds = new Set([...state.asked.map((question) => question.id), state.current.id]);
  const remaining = state.candidates.filter((question) => !askedIds.has(question.id));
  const shouldContinue =
    state.policy.depth !== "optional" &&
    remaining.length > 0 &&
    state.initialAsked < state.policy.maxInitialQuestions;

  if (shouldContinue) {
    const next = remaining[0]!;
    return {
      ...state,
      current: next,
      asked: [...state.asked, next],
      feedback,
      initialAsked: state.initialAsked + 1,
    };
  }

  return {
    ...state,
    phase: "done",
    current: null,
    feedback,
  };
}

export function judgeAnswer(question: ExplainQuestion, answer: string): ExplainFeedback {
  const normalized = answer.toLowerCase();
  const understood: string[] = [];
  const unclear: string[] = [];
  for (const point of question.expectedPoints) {
    const token = point.toLowerCase();
    if (token.length > 0 && normalized.includes(token)) understood.push(point);
    else unclear.push(point);
  }
  if (understood.length === 0 && unclear.length === 0) {
    unclear.push(question.concept);
  }
  return { understood, unclear };
}

function mergeFeedback(
  existing: ExplainFeedback,
  judged: ExplainFeedback,
  question: ExplainQuestion,
): ExplainFeedback {
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

function narrowerFollowUp(question: ExplainQuestion): ExplainQuestion {
  const file = question.citations[0]?.file;
  const symbol = question.citations[0]?.symbol ?? question.expectedPoints[0] ?? question.concept;
  return {
    id: nextId(),
    prompt: file
      ? `Look at ${file}. The evidence names ${symbol}. What is that name?`
      : `The evidence for this change names ${symbol}. What is that name?`,
    concept: question.concept,
    expectedPoints: [symbol],
    grounding: question.grounding,
    citations: question.citations,
    followUpOf: question.id,
  };
}

function nextId(): string {
  questionCounter += 1;
  return `q${questionCounter}`;
}
