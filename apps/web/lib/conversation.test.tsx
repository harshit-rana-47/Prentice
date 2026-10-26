import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { Conversation } from "../components/conversation";
import { learningFixture } from "./conversation-fixtures";
vi.stubGlobal("React", React);

export const props = {
  earlier: [], providers: [], prompt: "", pending: false, running: false, separateConversation: false,
  canContinue: false, busyElsewhere: null, disconnected: false, repoPath: "/tmp/sample", activeFile: "index.html",
  providerOverride: "", intensityOverride: "", useProviderMax: false, changing: false,
  onPrompt: () => {}, onSend: () => {}, onStop: () => {}, onChanging: () => {}, onProvider: () => {}, onIntensity: () => {}, onMax: () => {}, onOpen: () => {}, onExplain: async () => {}, onError: () => {},
  explainError: null, hasProject: true, needsAgent: false, choosing: false, chooseError: null, recentProjects: [], onChooseFolder: () => {}, onOpenProject: () => {}, onOpenAccounts: () => {},
};
it.each(["validation", "authentication", "architecture"] as const)("renders %s as a concept lesson, not tool logs or naming trivia", kind => {
  const html = renderToStaticMarkup(<Conversation {...props} task={learningFixture(kind)} />);
  expect(html).toContain("How it works.");
  expect(html).toContain("Trade-off.");
  expect(html).toContain("Think it through.");
  expect(html).toContain("Prentice interpretation");
  expect(html).toContain("Agent stated");
  expect(html).toContain(kind === "validation" ? "file changed" : "files changed");
  expect(html).not.toContain("PRIVATE OPERATIONAL NOISE");
  expect(html).not.toContain("Running a command");
  expect(html).not.toContain("Which function");
});
it("keeps the agent's real words and warnings even when they mention internal-looking terms", () => {
  const task = learningFixture("authentication");
  task.timeline.unshift({id:"real",title:"Agent",detail:"Vendor control and sandboxing are relevant to this design.",tone:"neutral"});
  task.issues.push({id:"fail",symptom:"Command failed",evidence:"npm test"});
  task.timeline.push({id:"fail",title:"Command failed",detail:"npm test",tone:"fail",code:"COMMAND_FAILED"});
  const html = renderToStaticMarkup(<Conversation {...props} task={task} />);
  expect(html).toContain("Vendor control and sandboxing are relevant to this design.");
  expect(html).toContain("Command failed");
  expect(html).toContain("Show what was recorded");
});
it("shows an accessible working indicator without shell noise", () => {
  const task = {...learningFixture("authentication"),status:"running",understand:null,explain:null};
  const html = renderToStaticMarkup(<Conversation {...props} task={task} running />);
  expect(html).toContain('aria-label="Agent is working"');
  expect(html).not.toContain("PRIVATE OPERATIONAL NOISE");
  expect(html).not.toContain("files changed");
  expect(html).toContain("Using open file:");
});

it("renders saved learning turns and keeps a composer and next action after revisiting", () => {
  const task = learningFixture("validation");
  task.explain = { ...task.explain!, phase: "taught", teaching: "Check before writing.", turns: [
    {id:"miss",questionId:"q",prompt:"Why validate first?",message:"Write invalid input first.",status:"replied",response:"What happens to the old value?",kind:"inference",teaching:"Check before writing."},
    {id:"help",questionId:"q",prompt:null,message:"I thought my answer was correct.",status:"failed",response:"Your conversation is saved. Retry this message.",kind:"unrecorded"},
  ] };
  const html = renderToStaticMarkup(<Conversation {...props} task={task} />);
  expect(html).toContain("Write invalid input first.");
  expect(html).toContain("I thought my answer was correct.");
  expect(html).toContain("What happens to the old value?");
  expect(html).toContain("Check before writing.");
  expect(html).toContain("Talk with Prentice");
  expect(html).toContain("Next concept");
  expect(html).toContain("Retry reply");
  expect(html).not.toContain("explain-follow-up");
});
it("keeps discussion reachable when the check is completed or skipped", () => {
  for (const phase of ["done", "skipped", "unavailable"] as const) {
    const task=learningFixture("validation"); task.explain={...task.explain!,phase,current:null};
    expect(renderToStaticMarkup(<Conversation {...props} task={task} />)).toContain("Ask Prentice");
  }
});

it("shows each question once through help exchanges and shows a new question when the check advances", () => {
  const task=learningFixture("authentication");
  const prompt="How does the client maintain authentication state?";
  task.explain={...task.explain!,current:{...task.explain!.current!,prompt},turns:[
    {id:"partial",questionId:"q",prompt,message:"It uses a cookie.",status:"replied",response:"You explained persistence; consider script access.",hint:"Which cookie attribute prevents JavaScript from reading it?",kind:"inference"},
    {id:"help",questionId:"q",prompt,message:"i need more hint",status:"replied",response:"Imagine a script injected into the page.",hint:"HttpOnly blocks script access, but does it stop the browser attaching the cookie to a request?",kind:"inference"},
  ]};
  let html=renderToStaticMarkup(<Conversation {...props} task={task} />);
  expect(html.split(prompt)).toHaveLength(2);
  expect(html).toContain("HttpOnly blocks script access");
  expect(html).not.toContain("This checks the concept, not recall");
  task.explain.current={...task.explain.current!,id:"q2",prompt:"Why does the server need its own identity check?"};
  html=renderToStaticMarkup(<Conversation {...props} task={task} />);
  expect(html).toContain(task.explain.current.prompt);
  expect(html.split(prompt)).toHaveLength(2);
});

it('offers optional practice and navigation after teaching without demanding the original answer',()=>{
 const task=learningFixture('validation');
 const prompt=task.explain!.current!.prompt;
 task.explain={...task.explain!,phase:'taught',hasNext:false,current:{...task.explain!.current!,concept:'Validation'},turns:[
  {id:'teach',questionId:'q',prompt,message:'Please explain this concept directly.',status:'replied',response:'The failed check stops before the write, so the old value survives.',kind:'inference',assessed:false},
 ]};
 const html=renderToStaticMarkup(<Conversation {...props} task={task}/>);
 expect(html).toContain('Practice is optional.');expect(html).toContain('Practise explaining');expect(html).toContain('Finish learning');expect(html).not.toContain('Skip question');
 expect(html).not.toContain('Next concept');expect(html).not.toContain('This checks the concept, not recall');
 expect(html.split(prompt)).toHaveLength(2);expect(html).toContain('Ask about the explanation');
});

it('separates unpractised concepts from incorrect answers after finishing',()=>{
 const task=learningFixture('validation');task.explain={...task.explain!,phase:'done',current:null,unpractised:['Validation'],feedback:{understood:[],unclear:[]}};
 const html=renderToStaticMarkup(<Conversation {...props} task={task}/>);
 expect(html).toContain('Not yet practised: Validation');expect(html).not.toContain('Keep practicing:');expect(html).not.toContain('You can explain');
});

it('renders source links and provisional practice without turning teaching into observed proof',()=>{
 const task=learningFixture('authentication');
 const support={kind:'source-backed' as const,scope:'general' as const,revision:'test',unitIds:['cookie.csrf'],sources:[{id:'csrf',title:'OWASP: CSRF prevention',url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html',reviewedOn:'2026-10-12'}]};
 task.understand!.learning!.concepts![0]={...task.understand!.learning!.concepts![0],support,transfer:'Sources: [OWASP: CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)'};
 task.explain={...task.explain!,turns:[{id:'practice',questionId:'q',prompt:null,message:'HttpOnly prevents all CSRF.',status:'replied',kind:'inference',assessed:false,understood:false,support,assessment:{status:'provisional',tentative:'needs-work',reason:'Not independently verified'},response:'HttpOnly does not prevent CSRF. Practice feedback is provisional; this has not been marked as demonstrated understanding. Sources: [OWASP: CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)'}]};
 const html=renderToStaticMarkup(<Conversation {...props} task={task}/>);
 expect(html).toContain('project application unverified');expect(html).toContain('Practice feedback is provisional');expect(html).toContain('href="https://cheatsheetseries.owasp.org/');expect(html).toContain('rel="noopener noreferrer"');expect(html).not.toContain('You can explain');
 task.understand!.learning!.concepts![0].support={...support,kind:'provisional',sources:[],unitIds:[]};
 expect(renderToStaticMarkup(<Conversation {...props} task={task}/>)).toContain('Provisional teaching · source coverage incomplete');
});


it('shows provisional practice separately from untouched topics after finishing',()=>{
 const task=learningFixture('authentication');task.explain={...task.explain!,phase:'done',current:null,feedback:{understood:[],unclear:[]},unpractised:['CSRF'],practisedProvisionally:['Cookie session']};
 const html=renderToStaticMarkup(<Conversation {...props} task={task}/>);expect(html).toContain('Practised with provisional feedback: Cookie session');expect(html).toContain('Not yet practised: CSRF');expect(html).not.toContain('You can explain');
});

it('distinguishes assessment eligibility from provisional practice in the existing question view',()=>{
 const task=learningFixture('authentication');task.explain={...task.explain!,current:{...task.explain!.current!,assessmentEligible:true}};
 const html=renderToStaticMarkup(<Conversation {...props} task={task}/>);expect(html).toContain('maintained criteria can be assessed reliably');
 task.explain.current!.assessmentEligible=false;expect(renderToStaticMarkup(<Conversation {...props} task={task}/>)).toContain('Feedback on this question is provisional');
});

it('reports interruption separately from sending and prevents repeated stop requests', () => {
  const task = {...learningFixture('authentication'),status:'running',understand:null,explain:null};
  const html = renderToStaticMarkup(<Conversation {...props} task={task} running stopping />);
  expect(html).toContain('Stopping…');
  expect(html).not.toContain('Sending…');
  expect(html).toMatch(/disabled=""[^>]*aria-busy="true"[^>]*>Stopping/);
});


it("shows folder-loading progress instead of asking the user to choose again", () => {
  const html = renderToStaticMarkup(<Conversation {...props} task={null} hasProject={false} choosing />);
  expect(html).toContain("Opening the selected project…");
  expect(html).toContain("Loading its files and saved conversations.");
  expect(html).not.toContain(">Choose a project folder<");
});
