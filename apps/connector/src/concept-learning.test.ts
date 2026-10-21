import { afterEach, expect, it, vi } from "vitest";
import { assembleUnderstand, type EvidencePacket, type ExplainQuestion } from "@prentice/domain";
import { extractImplementationSignals } from "./symbols.js";
import { answerShowsReasoning, evidenceSummary, explainEvidence, judgeLearningAnswer, learningConcepts, setLearningEndpoint } from "./learning.js";
import { codingPrompt } from "./providers.js";

const packet: EvidencePacket = { taskId: "t", prompt: "PRIVATE ORIGINAL REQUEST", projectName: "sample", files: [{ evidenceId: "f", path: "auth.js", change: "added", additions: 40, deletions: 0 }], symbols: [{ evidenceId: "s", path: "auth.js", name: "signUp", kind: "function", change: "added" }], activity: [{ evidenceId: "agent-final", title: "Agent", kind: "assistant", source: "agent", detail: "I added browser-only auth. Accounts are in localStorage. This gates the UI but cannot protect private server data." }], tests: null, unparsedLanguages: [], unparsedFiles: [] };
const lesson = { title: "Client state and trust boundaries", explanation: "The agent reports storing accounts in the browser. Persistence and trust are different concerns.", mechanism: "Browser storage survives a reload, but a user can edit it with developer tools.", tradeoff: "This is simple for a demo; a server must enforce access to private resources.", transfer: "What changes if the app starts storing private documents?", basisIds: ["agent-final"], question: "Why can browser-only login gate a screen but not protect a private server resource?", expectedPoints: ["the user can modify browser state", "the server must check access independently"] };
const fetchBefore = globalThis.fetch;
afterEach(() => { globalThis.fetch = fetchBefore; setLearningEndpoint(null); vi.restoreAllMocks(); });

it("extracts allowlisted API observations without source, literals or helper names", async () => {
  const source = 'const SECRET = "PRIVATE_SOURCE"; function signUp() { localStorage.setItem("private-key", SECRET); crypto.subtle.digest("SHA-256", new Uint8Array()); }';
  const signals = await extractImplementationSignals("auth.js", source, null);
  expect(signals.map(s => s.operation)).toEqual(["localStorage.setItem", "crypto.subtle.digest"]);
  expect(JSON.stringify(signals)).not.toMatch(/PRIVATE_SOURCE|private-key|signUp|SHA-256/);
  expect(await extractImplementationSignals("auth.js", source, source)).toEqual([]);
  expect((await extractImplementationSignals("auth.js", null, source)).every(s => s.change === "removed")).toBe(true);
  expect(await extractImplementationSignals("auth.js", '// localStorage.setItem("x", "y")\nconst x = "fetch()";', null)).toEqual([]);
  expect(await extractImplementationSignals("auth.js", 'function broken( { localStorage.setItem("x", "y");', null)).toEqual([]);
});
it("preserves the exact request and supplies explicit file context to every provider's common input", () => {
  const original = 'add auth to this file\nkeep the button text "click me"';
  const sent = codingPrompt({ prompt: original, activeFile: "index.html" });
  expect(sent).toContain('"index.html"');
  expect(sent.endsWith(original)).toBe(true);
  expect(codingPrompt({ prompt: original })).toMatch(/ask which file/);
});
it("validates concept anchors, keeps attribution, and rejects fabricated anchors and naming trivia", () => {
  const summary = evidenceSummary(packet);
  const accepted = learningConcepts({ concepts: [lesson] }, summary, packet);
  expect(accepted[0]?.grounding).toBe("inference");
  expect(accepted[0]?.basis[0]).toEqual({ id: "agent-final", kind: "agent-stated", text: packet.activity[0]!.detail });
  expect(learningConcepts({ concepts: [{ ...lesson, basisIds: ["not-real"] }] }, summary, packet)).toEqual([]);
  expect(learningConcepts({ concepts: [{ ...lesson, question: "Which function was added?" }] }, summary, packet)).toEqual([]);
  expect(learningConcepts({ concepts: [{ ...lesson, expectedPoints: ["signUp", "added"] }] }, summary, packet)).toEqual([]);
  expect(learningConcepts({ concepts: [{ ...lesson, mechanism: "See secrets/unseen.ts." }] }, summary, packet)).toEqual([]);
});
it("sends only bounded evidence, never the original prompt, source, or diff, and builds a usable lesson", async () => {
  const signals = await extractImplementationSignals("auth.js", 'localStorage.setItem("PRIVATE_SOURCE", "private value");', null);
  const p = { ...packet, implementation: signals, fullDiff: "PRIVATE_FULL_DIFF", source: "PRIVATE_SOURCE" };
  const sent: string[] = [];
  globalThis.fetch = vi.fn(async (_url, init) => { sent.push(String(init?.body)); return Response.json({ result: { concepts: [lesson] } }); }) as typeof fetch;
  setLearningEndpoint({ cloudUrl: "http://127.0.0.1:4740", token: "test" });
  const result = await explainEvidence(p, assembleUnderstand(p));
  expect(result.learning?.concepts).toHaveLength(1);
  expect(sent[0]).not.toMatch(/PRIVATE_ORIGINAL|PRIVATE ORIGINAL|PRIVATE_SOURCE|PRIVATE_FULL_DIFF|private value/);
  expect(sent[0]).toContain("localStorage.setItem");
  expect(result.observed.some(c => c.text.includes("localStorage.setItem"))).toBe(true);
});
it("rejects identifier-only answers and rubric copying even when the model says understood", async () => {
  const concept = learningConcepts({ concepts: [lesson] }, evidenceSummary(packet), packet)[0]!;
  const question: ExplainQuestion = { id: "q", prompt: concept.question, concept: concept.title, expectedPoints: concept.expectedPoints, grounding: "inference", citations: [{ evidenceId: "f", file: "auth.js", symbol: "signUp" }] };
  setLearningEndpoint({ cloudUrl: "http://127.0.0.1:4740", token: "test" });
  globalThis.fetch = vi.fn(async () => Response.json({ result: { understood: true, feedback: "Correct", hint: "Consider the server" } })) as typeof fetch;
  expect(await judgeLearningAnswer(packet, question, "signUp was added in auth.js")).toMatchObject({ ok: true, understood: false });
  expect(answerShowsReasoning(question.expectedPoints.join(" "), question)).toBe(false);
  expect(await judgeLearningAnswer(packet, question, "The browser is controlled by the person using it, so the server must check the request before returning private data.")).toMatchObject({ ok: true, understood: false, assessment: {status:"provisional",tentative:"understood"} });
});

it("does not send heredoc file bodies, fenced source, symbol inventories, or an echoed original request", () => {
  const p = { ...packet, activity: [
    ...packet.activity,
    {evidenceId:"script",title:"Run",kind:"command.finished",source:"agent" as const,command:"cat >> auth.js <<'EOF'\nPRIVATE_HEREDOC_SOURCE\nEOF",exitCode:0},
    {evidenceId:"echo",title:"Agent",kind:"assistant",source:"agent" as const,detail:`${packet.prompt}\nHere is the code:\n\`\`\`js\nPRIVATE_FENCED_SOURCE\n\`\`\``},
  ] };
  const summary = evidenceSummary(p);
  const text = JSON.stringify(summary);
  expect(text).not.toMatch(/PRIVATE_HEREDOC_SOURCE|PRIVATE_FENCED_SOURCE|PRIVATE ORIGINAL REQUEST/);
  expect(summary.observed.symbols).toEqual([]);
  expect(text).not.toContain("Added function signUp");
  expect(summary.observed.commands.at(-1)?.exitCode).toBe(0);
});

it("keeps a whole-flow lesson with multiple valid evidence anchors and enforces the task-size ceiling", () => {
  const summary = evidenceSummary(packet);
  summary.facts = Array.from({length:8},(_,i)=>({id:`fact:${i}`,text:"Added use of localStorage.setItem in auth.js."}));
  summary.scope = {complexity:"low",maxConcepts:1};
  const wholeFlow = {...lesson,basisIds:summary.facts.map(f=>f.id)};
  const accepted = learningConcepts({concepts:[wholeFlow,{...wholeFlow,title:"Another concept"}]},summary,packet);
  expect(accepted).toHaveLength(1);
  expect(accepted[0]?.basis).toHaveLength(8);
});

it('preserves sourced general lessons and leaves vetted questions unchanged',async()=>{
 const {sourceLessonDraft}=await import('../../cloud/src/source-teaching.js');
 const {phraseQuestion,mentionsUnknownPath}=await import('./learning.js');
 const raw=sourceLessonDraft({concepts:[{title:'Cookies and CSRF',question:'Why is HttpOnly alone insufficient for CSRF?',basisIds:['agent-final']}]},evidenceSummary(packet))!;
 const concepts=learningConcepts(raw.json,evidenceSummary(packet),packet);
 expect(concepts).toHaveLength(1);expect(concepts[0]).toMatchObject({grounding:'inference',support:{kind:'source-backed',scope:'general'},basis:[{kind:'agent-stated'}]});
 expect(mentionsUnknownPath('Sources: https://nodejs.org/api/child_process.html',packet)).toBe(false);
 expect(mentionsUnknownPath('Read private/unknown.ts. Source: https://nodejs.org/api/child_process.html',packet)).toBe(true);
 const q={id:'q',prompt:concepts[0].question,concept:concepts[0].title,expectedPoints:concepts[0].expectedPoints,grounding:'inference' as const,citations:[],support:concepts[0].support};
 const spy=vi.fn();globalThis.fetch=spy as typeof fetch;expect(await phraseQuestion(packet,q)).toBe(q.prompt);expect(spy).not.toHaveBeenCalled();
});
