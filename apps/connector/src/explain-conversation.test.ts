// Legacy-path regressions; semantic-tutor tests exercise the default independent-review path.
process.env.GROQ_REVIEW_MODEL="disabled";
import { afterEach, expect, it, vi } from "vitest";
import { assembleUnderstand, startExplainSession, type EvidencePacket, type LearningConcept } from "@prentice/domain";
import { openDatabase, migrate } from "./db.js";
import { Store } from "./store.js";
import { answerExplain, beginExplain, discussTask, explainView, skipExplain } from "./session.js";
import { setLearningEndpoint } from "./learning.js";
import { createApp } from "./server.js";
import { disconnectedAccounts } from "./accounts.js";

const nativeFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = nativeFetch; setLearningEndpoint(null); vi.restoreAllMocks(); });
const lesson: LearningConcept = { title:"Validation and state safety", explanation:"Validate before saving.", mechanism:"Rejecting input before writing preserves existing state.", tradeoff:"Client checks improve feedback; a server needs its own checks.", transfer:"What if a caller bypasses the form?", question:"Why validate before saving, and what happens if validation fails?", expectedPoints:["validation happens before modifying state", "rejection preserves the existing value"], grounding:"inference", basis:[{id:"a",kind:"agent-stated",text:"The agent reports rejecting bad input before saving."}] };
function fixture() {
  const db = openDatabase(":memory:"); migrate(db); const store = new Store(db);
  const project = store.upsertProject("/tmp/synthetic-learning", "Synthetic");
  const task = store.insertTask(project.id,"PRIVATE ORIGINAL TASK"); store.updateTask(task.id,{status:"completed",provider_id:"fixture"});
  const packet: EvidencePacket = {taskId:task.id,prompt:task.prompt,projectName:"Synthetic",files:[],symbols:[],activity:[{evidenceId:"a",title:"Agent",kind:"assistant",source:"agent",detail:lesson.basis[0]!.text}],tests:null,unparsedLanguages:[],unparsedFiles:[]};
  store.savePacket(task.id,packet);
  const other = {...lesson,title:"Independent server checks",question:"Why must a server validate input independently?"};
  store.saveUnderstand(task.id,{...assembleUnderstand(packet),learning:{available:true,message:"Ready",explanation:"Concepts",concepts:[lesson,other]}});
  store.saveExplain(task.id,startExplainSession(packet,"moderate",[],[lesson,other]));
  setLearningEndpoint({cloudUrl:"http://127.0.0.1:4740",token:"synthetic"});
  return {store,task,project,db};
}
function model(result: unknown) { globalThis.fetch = vi.fn(async () => Response.json({result})) as typeof fetch; }
const wrong = {intent:"answer",understood:false,text:"What happens to the existing value when input is invalid?",hint:"Consider the order of operations."};
const discussion = {intent:"discuss",understood:false,text:"In general, validation runs first so a rejected value never reaches the write. Try tracing an invalid value."};
const correct = {intent:"answer",understood:true,text:"Yes. Rejection stops the write and preserves the previous value."};

it("keeps every answer visible, stays conversational after repeated misses, and resumes checks", async () => {
  const {store,task,project} = fixture();
  model(wrong);
  await answerExplain(store,task.id,"It saves anything.","miss-1");
  await answerExplain(store,task.id,"It writes the invalid value then checks it.","miss-2");
  expect(store.getExplain(task.id)?.phase).toBe("asking");
  const originalId = store.getExplain(task.id)!.current!.id;
  model(discussion);
  await answerExplain(store,task.id,"Can you give an example?","help-1");
  await discussTask(store,task.id,"Why not validate after the write?","help-2");
  expect(store.getExplain(task.id)).toMatchObject({phase:"asking",attempts:0,current:{id:originalId}});
  model(wrong);
  for(let i=0;i<5;i++) await answerExplain(store,task.id,"I think invalid values are written first.",`repeat-${i}`);
  expect(store.getExplain(task.id)).toMatchObject({phase:"asking",current:{id:originalId}});
  expect(store.getExplain(task.id)!.attempts).toBeLessThanOrEqual(3);
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
  model(correct);
  const next = await answerExplain(store,task.id,"Input is checked before the write. If rejected, execution stops and the old value remains.","clarify");
  expect(next).toMatchObject({phase:"asking",questionNumber:1,current:{id:originalId}});
  expect(next?.turns?.at(-1)?.assessment).toMatchObject({status:"provisional",tentative:"understood"});
  expect(next?.turns).toHaveLength(10);
  expect(next?.turns?.every(turn => turn.message && turn.response)).toBe(true);
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
  const moved=await answerExplain(store,task.id,"Next concept","explicit-next","next");
  expect(moved?.questionNumber).toBe(2);
  expect(JSON.stringify(next)).not.toContain("expectedPoints");
  expect(JSON.stringify(next)).not.toContain("evaluatedAnswer");
});

it("reviews a specified earlier answer using its actual reasoning without consuming the next question", async () => {
  const {store,task} = fixture();
  model(wrong);
  await answerExplain(store,task.id,"Validation runs before writing, so invalid input leaves the old value intact.","first");
  model(correct);
  await answerExplain(store,task.id,"A failed check stops execution before any state write; existing state survives unchanged.","second");
  await answerExplain(store,task.id,"Next concept","explicit-next","next");
  const nextId=store.getExplain(task.id)!.current!.id;
  globalThis.fetch=vi.fn(async (_url,init) => {
    const body=JSON.parse(String(init?.body));
    expect(body.action).toBe("tutor");
    expect(body.previous.answer).toContain("stops execution");
    expect(body.reviews[0]).toMatchObject({id:"first",answer:expect.stringContaining("old value intact")});
    expect(body.history).toHaveLength(3);
    expect(String(init?.body)).not.toContain("PRIVATE ORIGINAL TASK");
    return Response.json({result:{intent:"review",reviewTurnId:"first",understood:true,text:"Your first answer was correct: it already explained that rejection preserves state. My earlier evaluation missed that."}});
  }) as typeof fetch;
  const reviewed=await answerExplain(store,task.id,"My first answer was actually correct.","dispute");
  expect(reviewed).toMatchObject({phase:"asking",questionNumber:2,current:{id:nextId}});
  expect(reviewed?.turns?.at(-1)?.response).toContain("first answer was correct");
  expect(reviewed?.turns?.at(-1)?.questionId).toBe(store.getExplain(task.id)!.asked[0]!.id);
});

it("does not reward disagreement alone, and can conclude then keep discussing", async () => {
  const {store,task,project}=fixture();
  model(wrong); await answerExplain(store,task.id,"validateName", "bad");
  model({intent:"review",understood:true,text:"Let's reconsider the answer."});
  await answerExplain(store,task.id,"Correct!", "demand");
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
  await answerExplain(store,task.id,"Move on", "next-1","next");
  const done=await answerExplain(store,task.id,"Finish this check", "next-2","next");
  expect(done?.phase).toBe("done");
  model(discussion);
  const after=await answerExplain(store,task.id,"Can we discuss server-side validation?", "after");
  expect(after?.phase).toBe("done");
  expect(after?.turns?.at(-1)).toMatchObject({message:"Can we discuss server-side validation?",status:"replied"});
});

it("saves pending messages before inference, survives retry/reload, and deduplicates concurrent sends", async () => {
  const {store,task,db}=fixture();
  let release!: () => void;
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const fetchMock=vi.fn(async()=>{await wait;return Response.json({result:discussion});});globalThis.fetch=fetchMock as typeof fetch;
  const one=answerExplain(store,task.id,"Why this order?","same");
  const duplicate=answerExplain(store,task.id,"Why this order?","same");
  await vi.waitFor(()=>expect(store.getExplain(task.id)?.turns?.[0]?.status).toBe("pending"));
  expect(explainView(new Store(db).getExplain(task.id))?.turns?.[0]?.message).toBe("Why this order?");
  release();await Promise.all([one,duplicate]);expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(store.getExplain(task.id)?.turns).toHaveLength(1);
  globalThis.fetch=vi.fn(async()=>{throw new Error("network down");}) as typeof fetch;
  await answerExplain(store,task.id,"What if data is empty?","retry");
  expect(store.getExplain(task.id)?.turns?.at(-1)?.status).toBe("failed");
  model(discussion);
  const retried=await answerExplain(new Store(db),task.id,"What if data is empty?","retry");
  expect(retried?.turns).toHaveLength(2);expect(retried?.turns?.at(-1)?.status).toBe("replied");
  expect(retried?.learningMessage).toBeNull();
});

it("preserves both concurrent messages and never undoes Skip with a late evaluation", async () => {
  const {store,task}=fixture();
  model(discussion);
  await Promise.all([answerExplain(store,task.id,"Explain the order", "one"),answerExplain(store,task.id,"Give another example", "two")]);
  expect(store.getExplain(task.id)?.turns?.map(t=>t.id)).toEqual(["one","two"]);
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});
  globalThis.fetch=vi.fn(async()=>{await wait;return Response.json({result:correct});}) as typeof fetch;
  const late=answerExplain(store,task.id,"Checks run before writes so rejection preserves the old value.","late");
  await vi.waitFor(()=>expect(store.getExplain(task.id)?.turns?.at(-1)?.status).toBe("pending"));
  skipExplain(store,task.id);release();await late;
  expect(store.getExplain(task.id)?.phase).toBe("skipped");
  expect(store.getExplain(task.id)?.turns?.at(-1)?.status).toBe("replied");
});

it("returns the persisted transcript through the real HTTP routes and relaunches without losing it", async()=>{
  const {store,task,db}=fixture();model(wrong);
  const create=()=>createApp({store:new Store(db),token:"test-token",allowedOrigins:["http://localhost:3000"],accounts:disconnectedAccounts(),allowFixture:true});
  let app=create();const headers={authorization:"Bearer test-token",origin:"http://localhost:3000","content-type":"application/json"};
  const post=(action:string,body:unknown)=>app.request(`/v1/tasks/${task.id}/explain-back/${action}`,{method:"POST",headers,body:JSON.stringify(body)});
  await post("answer",{answer:"It saves first",messageId:"http-1"});
  await post("answer",{answer:"The write always happens first",messageId:"http-2"});
  model(discussion);const response=await post("discuss",{question:"Can you help me revisit this?",messageId:"http-3"});
  expect(response.status).toBe(200);expect(await response.json()).toMatchObject({explain:{phase:"asking",turns:expect.arrayContaining([expect.objectContaining({id:"http-3",response:discussion.text})])}});
  app=create();const restored=await app.request(`/v1/tasks/${task.id}`,{headers});
  expect(await restored.json()).toMatchObject({task:{explain:{turns:expect.arrayContaining([expect.objectContaining({message:"Can you help me revisit this?"})])}}});
  model(correct);await post("answer",{answer:"Validation precedes writing, and a rejected input stops the update so the old value remains.",messageId:"http-4"});
  await post("answer",{answer:"Next concept",messageId:"http-next",action:"next"});
  expect(store.getExplain(task.id)?.initialAsked).toBe(2);
});

it("does not count a failed review as a new attempt and retries an old failure against its original question", async()=>{
  const {store,task}=fixture();model(wrong);
  await answerExplain(store,task.id,"Invalid input gets written first.","wrong");
  model({intent:"review",understood:false,text:"The saved answer still puts the write before validation."});
  await answerExplain(store,task.id,"But wasn't that correct?","review");
  expect(store.getExplain(task.id)).toMatchObject({phase:"asking",attempts:0});
  expect(store.getExplain(task.id)?.turns?.at(-1)?.hint).toBeNull();
  globalThis.fetch=vi.fn(async()=>Response.json({}, {status:503})) as typeof fetch;
  const oldQuestion=store.getExplain(task.id)!.current!.id;
  await answerExplain(store,task.id,"Input is checked before the write. Rejection stops it so the previous value survives.","old-failed");
  model(correct);await answerExplain(store,task.id,"Reject bad input before writing, so the old value remains unchanged.","new-correct");
  await answerExplain(store,task.id,"Next concept","explicit-next","next");
  const newQuestion=store.getExplain(task.id)!.current!.id;expect(newQuestion).not.toBe(oldQuestion);
  globalThis.fetch=vi.fn(async(_url,init)=>{expect(JSON.parse(String(init?.body)).current.prompt).toBe(lesson.question);return Response.json({result:correct});}) as typeof fetch;
  const retried=await answerExplain(store,task.id,"Input is checked before the write. Rejection stops it so the previous value survives.","old-failed");
  expect(retried?.current?.id).toBe(newQuestion);expect(retried?.questionNumber).toBe(2);
});

it("bounds dialogue context, rejects malformed replies, and keeps redacted retries usable", async()=>{
  const {store,task}=fixture();model(discussion);
  for(let i=0;i<9;i++) await answerExplain(store,task.id,`Explain this example ${i}?`,`h${i}`);
  globalThis.fetch=vi.fn(async(_url,init)=>{const body=JSON.parse(String(init?.body));expect(body.history).toHaveLength(6);expect(String(init?.body)).not.toContain('PRIVATE ORIGINAL TASK');return Response.json({result:{intent:'answer',text:'Missing semantic judgment'}});}) as typeof fetch;
  await answerExplain(store,task.id,"What about validation?","malformed");
  expect(store.getExplain(task.id)?.turns?.at(-1)?.status).toBe("failed");
  model(discussion);await answerExplain(store,task.id,"What about validation?","malformed");
  expect(store.getExplain(task.id)?.turns?.at(-1)?.status).toBe("replied");
});

it("can retry a redacted message without losing it or duplicating the transcript",async()=>{
  const {store,task}=fixture();
  const message="Can you explain this example with sk-synthetic123456789?";
  globalThis.fetch=vi.fn(async()=>Response.json({}, {status:503})) as typeof fetch;
  await answerExplain(store,task.id,message,"redacted");
  expect(store.getExplain(task.id)?.turns?.[0]?.message).not.toContain("sk-synthetic");
  model(discussion);const retry=await answerExplain(store,task.id,message,"redacted");
  expect(retry?.turns).toHaveLength(1);expect(retry?.turns?.[0]?.status).toBe("replied");
});

it("does not silently move on because of a model intent error or grade a retired recall check",async()=>{
  const {store,task,project}=fixture();
  const current=store.getExplain(task.id)!.current!.id;
  model({intent:"continue",understood:false,text:"Let's move on."});
  const unchanged=await answerExplain(store,task.id,"I am not ready to move on. Please explain more.","keep-going");
  expect(unchanged?.current?.id).toBe(current);
  expect(unchanged?.turns?.at(-1)?.response).toContain("choose to practise");
  const state=store.getExplain(task.id)!;const legacy={...state.current!,grounding:"observed" as const,prompt:"Which function was added?",expectedPoints:["validateName"]};
  store.saveExplain(task.id,{...state,asked:[legacy],candidates:[legacy],current:legacy});
  model(correct);const retired=await answerExplain(store,task.id,"validateName was the function added in this file.","legacy");
  expect(retired?.phase).toBe("unavailable");expect(retired?.turns?.at(-1)?.assessed).toBe(false);
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
});

it("keeps prior messages when an unavailable lesson becomes ready",async()=>{
  const {store,task}=fixture();
  store.saveDecision(task.id,{complexity:"moderate"} as Parameters<Store["saveDecision"]>[1]);
  const state=store.getExplain(task.id)!;
  store.saveExplain(task.id,{...state,phase:"unavailable",current:null,asked:[],candidates:[],learningMessage:"Not ready"});
  model(discussion);await answerExplain(store,task.id,"Can we discuss validation while we wait?","waiting");
  const ready=await beginExplain(store,task.id);
  expect(ready?.phase).toBe("asking");expect(ready?.turns?.[0]?.message).toContain("while we wait");
  expect(ready?.turns?.[0]?.response).toBe(discussion.text);
});

it("cannot establish mastery from a reply that invents an unrecorded repository path",async()=>{
  const {store,task,project}=fixture();
  model({intent:"answer",understood:true,text:"Correct: private/unknown.ts validates the input first."});
  const reply=await answerExplain(store,task.id,"Check the input before writing so rejected input leaves the previous value unchanged.","unknown-path");
  expect(reply?.turns?.at(-1)?.assessed).toBe(false);
  expect(reply?.turns?.at(-1)?.response).toContain("not recorded");
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
});

it("keeps actual hints on discussion turns and supplies the visible coaching history for another hint", async () => {
  const {store,task}=fixture();
  model(wrong);
  await answerExplain(store,task.id,"It writes the invalid value first.","partial");
  const priorState=store.getExplain(task.id)!;store.saveExplain(task.id,{...priorState,attempts:1,hint:wrong.hint});
  const questionId=store.getExplain(task.id)!.current!.id;
  model({intent:"discuss",text:"Sure, here's a hint to guide you toward a complete answer.",hint:"Imagine the old name is Ada. A blank input fails the check: should Ada still be stored?"});
  const hint=await answerExplain(store,task.id,"i need more hint","hint");
  expect(hint?.turns?.at(-1)?.hint).toContain("Ada");
  expect(store.getExplain(task.id)).toMatchObject({attempts:1,current:{id:questionId}});
  globalThis.fetch=vi.fn(async(_url,init)=>{
    const sent=JSON.parse(String(init?.body));
    expect(sent.coaching).toMatchObject({attempts:1,hint:wrong.hint});
    expect(sent.history.at(-1)).toMatchObject({question:lesson.question,hint:expect.stringContaining("Ada"),assessed:false});
    return Response.json({result:{intent:"discuss",text:"Trace the failure branch: if it stops execution, can the write after it run?",hint:""}});
  }) as typeof fetch;
  await answerExplain(store,task.id,"another hint please","another");
  model(correct);
  const resumed=await answerExplain(store,task.id,"The check runs before the write. Rejection stops execution, so Ada stays stored.","resume");
  expect(resumed?.questionNumber).toBe(1);
  expect(resumed?.turns?.at(-1)?.assessment?.status).toBe("provisional");
  expect((await answerExplain(store,task.id,"Next concept","explicit-next","next"))?.questionNumber).toBe(2);
});

it("checks hint prose against the same evidence boundary as the main reply", async () => {
  const {store,task}=fixture();
  model({intent:"discuss",text:"Consider the state update.",hint:"Read private/unknown.ts to see the answer."});
  const result=await answerExplain(store,task.id,"Can you give me a hint?","bad-hint");
  expect(result?.turns?.at(-1)?.response).toContain("not recorded");
  expect(result?.turns?.at(-1)?.hint).toBeNull();
});

it.each([
  ['hint','discuss','Can I have a hint?'], ['another hint','discuss','Another hint please.'],
  ['term','discuss','What does validation mean?'], ['direct explanation','teach','Please explain the whole concept.'],
  ['worked example','teach','Show me a worked example.'], ['simplification','teach','Explain that more simply.'],
  ['still confused','teach',"I still don't understand."], ['acknowledgment','discuss','I understand, thanks.'],
] as const)('handles %s without grading it',async(_label,intent,message)=>{
  const {store,task,project}=fixture();
  model({intent,text:'Imagine Ada is already stored. An invalid blank value fails the check before the write, so Ada stays stored.',hint:''});
  const result=await answerExplain(store,task.id,message,'help');
  expect(result?.phase).toBe(intent==='teach'?'taught':'asking');
  expect(store.getExplain(task.id)?.attempts).toBe(0);
  expect(result?.turns?.[0]).toMatchObject({message,status:'replied',assessed:false});
  expect(result?.feedback).toEqual({understood:[],unclear:[]});
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
});

it('persists a fresh teaching body returned separately from its introduction without grading it',async()=>{
 const {store,task,project}=fixture();
 const teaching="try { validate(''); console.log('accepted'); } catch (error) { console.log('rejected'); }\nThe throw skips the accepted line and transfers control to catch.";
 model({intent:'teach',text:'Here is a general JavaScript example.',teaching});
 const view=await answerExplain(store,task.id,'Show a general try/catch example.','separate-teaching');
 expect(view?.turns?.at(-1)).toMatchObject({response:'Here is a general JavaScript example.',teaching,assessed:false});
 expect(store.getExplain(task.id)).toMatchObject({phase:'taught',teaching,attempts:0});
 expect(store.getExplain(task.id)?.turns?.at(-1)?.teaching).toBe(teaching);
 expect(store.demonstratedConcepts(project.id)).toEqual([]);
});

it('lets the learner discuss teaching, opt into practice, change their mind, and continue with provisional practice',async()=>{
  const {store,task}=fixture();const id=store.getExplain(task.id)!.current!.id;
  model({intent:'teach',text:'A rejected value stops before the write, leaving the previous stored value intact.'});
  await answerExplain(store,task.id,'Explain it directly please.','teach');
  expect(store.getExplain(task.id)).toMatchObject({phase:'taught',attempts:0,current:{id}});
  model(discussion);await answerExplain(store,task.id,'So is that like stopping a bank transfer before changing the balance?','follow-up');
  expect(store.getExplain(task.id)?.phase).toBe('taught');
  await answerExplain(store,task.id,'I want to practise.','practice','practice');
  expect(store.getExplain(task.id)).toMatchObject({phase:'asking',attempts:0,current:{id}});
  model({intent:'teach',text:'Suppose the saved name is Ada and the replacement is blank. The check rejects it, so Ada remains.'});
  await answerExplain(store,task.id,'Actually, show an example first.','change-mind');
  expect(store.getExplain(task.id)?.phase).toBe('taught');
  model(correct);await answerExplain(store,task.id,'Check the input before writing. If it fails, the write never runs, so the existing stored value survives.','voluntary');
  expect(store.getExplain(task.id)).toMatchObject({phase:'taught',initialAsked:1,attempts:0});
  expect(store.getExplain(task.id)?.turns?.filter(t=>t.assessed)).toHaveLength(0);
  expect(store.getExplain(task.id)?.turns?.filter(t=>t.assessment?.status==='provisional')).toHaveLength(1);
  expect((await answerExplain(store,task.id,'Next concept','next','next'))?.questionNumber).toBe(2);
});

it('distinguishes finishing the entire session from moving on or skipping one question, even when AI is down',async()=>{
  const {store,task}=fixture();const call=vi.fn(async()=>Response.json({}, {status:503}));globalThis.fetch=call as typeof fetch;
  await answerExplain(store,task.id,'Explain it please.','failed');
  const finished=await answerExplain(store,task.id,'Finish this learning session','finish','finish');
  expect(finished?.phase).toBe('done');expect(finished?.questionNumber).toBe(1);
  expect(finished?.feedback).toEqual({understood:[],unclear:[]});
  expect(finished?.unpractised).toHaveLength(2);expect(call).toHaveBeenCalledTimes(1);
  await answerExplain(store,task.id,'Finish this learning session','finish','finish');
  expect(store.getExplain(task.id)?.turns).toHaveLength(2);
  const first=store.getExplain(task.id)!.asked[0]!.id;
  await answerExplain(store,task.id,'Revisit the first concept','reopen','revisit',undefined,first);
  expect(store.getExplain(task.id)).toMatchObject({phase:'taught',current:{id:first},attempts:0});
  await answerExplain(store,task.id,'Next concept','next','next');
  expect(store.getExplain(task.id)?.initialAsked).toBe(2);
  const skipped=await answerExplain(store,task.id,'Skip this question','skip-one','skip');
  expect(skipped?.phase).toBe('done');expect(skipped?.feedback.unclear).toEqual([]);
  // Retrying earlier failed teaching does not reopen the finished check.
  model({intent:'teach',text:'Validation rejects the blank input before the write, so Ada stays stored.'});
  const retry=await answerExplain(store,task.id,'Explain it please.','failed');
  expect(retry?.phase).toBe('done');expect(retry?.turns).toHaveLength(5);
});

it('restores the interrupted topic and its attempts after a temporary revisit',async()=>{
  const {store,task}=fixture();const first=store.getExplain(task.id)!.current!.id;
  model(correct);await answerExplain(store,task.id,'Check before the write; rejection stops the update and preserves the old value.','first-proof');
  await answerExplain(store,task.id,'Next concept','explicit-next','next');
  const second=store.getExplain(task.id)!.current!.id;
  model(wrong);await answerExplain(store,task.id,'The client can always be trusted.','second-miss');
  const prior=store.getExplain(task.id)!;store.saveExplain(task.id,{...prior,attempts:1,hint:wrong.hint});
  model({intent:'revisit',questionId:first,text:'Let us revisit validation: a failed check stops before the write.'});
  await answerExplain(store,task.id,'Go back to validation for a moment.','revisit');
  expect(store.getExplain(task.id)).toMatchObject({phase:'taught',current:{id:first},attempts:0,returnTo:second});
  await answerExplain(store,task.id,'Back to the next concept','return','next');
  expect(store.getExplain(task.id)).toMatchObject({phase:'asking',current:{id:second},attempts:1,hint:wrong.hint,returnTo:null});
  expect(store.getExplain(task.id)?.asked).toHaveLength(2);
});

it('binds queued messages to the topic visible at submission instead of grading the unseen next question',async()=>{
  const {store,task}=fixture();const first=store.getExplain(task.id)!.current!.id;
  let release!:()=>void;const wait=new Promise<void>(resolve=>{release=resolve;});let calls=0;
  globalThis.fetch=vi.fn(async(_url,init)=>{
    expect(JSON.parse(String(init?.body)).current.id).toBe(first);
    if(++calls===1){await wait;return Response.json({result:correct});}
    return Response.json({result:wrong});
  }) as typeof fetch;
  const one=answerExplain(store,task.id,'Check before writing; a failed check stops the update and preserves the old value.','one');
  const two=answerExplain(store,task.id,'Wait, I think it writes first.','two');
  await vi.waitFor(()=>expect(store.getExplain(task.id)?.turns?.[0]?.status).toBe('pending'));release();await Promise.all([one,two]);
  expect(store.getExplain(task.id)).toMatchObject({initialAsked:1,attempts:0,phase:'asking'});
  expect(store.getExplain(task.id)?.current?.id).toBe(first);
  expect(store.getExplain(task.id)?.turns?.map(t=>t.questionId)).toEqual([first,first]);
});

it('preserves existing mastery when an unsupported review is inconclusive',async()=>{
  const {store,task,project}=fixture();
  model(correct);await answerExplain(store,task.id,'Check before writing so rejection stops the update and preserves existing state.','proof');
  expect(store.demonstratedConcepts(project.id)).toEqual([]);
  const legacy=store.getExplain(task.id)!;store.saveExplain(task.id,{...legacy,feedback:{...legacy.feedback,understood:[lesson.title]}});store.demonstrate(project.id,lesson.title);
  model({intent:'review',reviewTurnId:'proof',understood:false,text:'I overstated the earlier evaluation; that explanation did not establish the required reasoning.'});
  await answerExplain(store,task.id,'Please review my first explanation; I meant writing occurs before the check.','retract');
  expect(store.getExplain(task.id)?.feedback.understood).toContain(lesson.title);
  expect(store.demonstratedConcepts(project.id)).toContain(lesson.title);
  // Another task's independently demonstrated concept must survive a correction here.
  const other=store.insertTask(project.id,'Other synthetic task');
  const state=store.getExplain(task.id)!;store.saveExplain(other.id,{...state,feedback:{understood:[lesson.title],unclear:[]}});store.demonstrate(project.id,lesson.title);
  model({intent:'review',reviewTurnId:'proof',understood:true,text:'The first explanation did establish the necessary cause and effect.'});
  await answerExplain(store,task.id,'The check happens first and rejects invalid input before any write, preserving the old value.','restore');
  model({intent:'review',reviewTurnId:'proof',understood:false,text:'The remaining causal gap still needs explanation.'});
  await answerExplain(store,task.id,'Please reassess that earlier answer.','again');
  expect(store.getExplain(task.id)?.feedback.understood).toContain(lesson.title);
  expect(store.demonstratedConcepts(project.id)).toContain(lesson.title);
});

it.each(['low','moderate','high'] as const)('keeps a coherent HTTP lifecycle for %s complexity',async(complexity)=>{
  const {store,task,db}=fixture();
  const lessons=Array.from({length:4},(_,i)=>({...lesson,title:`Concept ${i+1}`,question:`Why validate input at boundary ${i+1} before writing?`}));
  store.saveExplain(task.id,startExplainSession(store.getPacket(task.id)!,complexity,[],lessons));
  const count=complexity==='low'?1:complexity==='moderate'?2:4;
  expect(store.getExplain(task.id)?.candidates).toHaveLength(count);
  const app=createApp({store:new Store(db),token:'test-token',allowedOrigins:['http://localhost:3000'],accounts:disconnectedAccounts(),allowFixture:true});
  const headers={authorization:'Bearer test-token',origin:'http://localhost:3000','content-type':'application/json'};
  const post=async(answer:string,id:string,action?:string)=>{const r=await app.request(`/v1/tasks/${task.id}/explain-back/answer`,{method:'POST',headers,body:JSON.stringify({answer,messageId:id,action})});expect(r.status).toBe(200);return (await r.json() as any).explain;};
  model({intent:'teach',text:'An invalid value fails before the write. The old value remains because that write never executes.'});
  expect((await post('Explain this concept first.','teach')).phase).toBe('taught');
  for(let i=0;i<count;i++){
    await post('Let me practise.','practice-'+i,'practice');model(correct);
    const practiced=await post('Checks happen before writing. Rejection stops execution, so the previous stored value remains.','answer-'+i);
    expect(practiced.turns.at(-1)).toMatchObject({assessed:false,assessment:{status:'provisional'}});
    await post('Next concept','next-'+i,'next');
  }
  const saved=await app.request(`/v1/tasks/${task.id}`,{headers});const restored=(await saved.json() as any).task.explain;
  expect(restored.phase).toBe('done');expect(restored.feedback.understood).toHaveLength(0);expect(restored.practisedProvisionally).toHaveLength(count);expect(restored.unpractised).toEqual([]);
  expect(restored.turns).toHaveLength(1+3*count);expect(JSON.stringify(restored)).not.toContain('expectedPoints');
  model(discussion);expect((await post('How would this apply to a bank transfer?','after')).phase).toBe('done');
});

it('never consumes an attempt if a malformed tutor grades a clear help request',async()=>{
 const {store,task}=fixture();model(wrong);
 const result=await answerExplain(store,task.id,'i need more hint','misroute');
 expect(result?.turns?.[0]).toMatchObject({status:'failed',assessed:false});
 expect(store.getExplain(task.id)).toMatchObject({phase:'asking',attempts:0,feedback:{understood:[],unclear:[]}});
 model({intent:'teach',text:'A failed check stops before the write. Existing state stays intact.'});
 const retry=await answerExplain(store,task.id,'i need more hint','misroute');
 expect(retry?.turns).toHaveLength(1);expect(retry?.phase).toBe('taught');
});

it('persists a typed technical-consistency failure without grading, leaking reviewer prose, or blocking navigation',async()=>{
 const {store,task}=fixture();
 globalThis.fetch=vi.fn(async()=>Response.json({error:{code:'TEACHING_UNRELIABLE',message:'PRIVATE REVIEW DETAILS'}},{status:503})) as typeof fetch;
 let view=await answerExplain(store,task.id,'Explain the concept directly.','semantic-failure');
 expect(view?.turns?.at(-1)).toMatchObject({id:'semantic-failure',status:'failed',assessed:false,response:expect.stringContaining('could not verify the technical consistency')});
 expect(JSON.stringify(view)).not.toContain('PRIVATE REVIEW DETAILS');
 expect(store.getExplain(task.id)?.attempts).toBe(0);expect(view?.feedback.understood).toEqual([]);
 expect(view?.phase).toBe('asking');
 await answerExplain(store,task.id,'Finish this learning session','finish-after-semantic','finish');
 model({intent:'teach',understood:false,text:'Validation runs before the write; rejection stops execution, preserving the previous value.',hint:''});
 view=await answerExplain(store,task.id,'Explain the concept directly.','semantic-failure');
 expect(view?.phase).toBe('done');expect(view?.turns?.filter(turn=>turn.id==='semantic-failure')).toHaveLength(1);
 expect(view?.turns?.find(turn=>turn.id==='semantic-failure')?.status).toBe('replied');
});

it('does not expose an unrecognized cloud error as a trusted technical failure',async()=>{
 const {store,task}=fixture();
 globalThis.fetch=vi.fn(async()=>Response.json({error:{code:'UNKNOWN',message:'Invented and unsafe claim'}},{status:503})) as typeof fetch;
 const view=await answerExplain(store,task.id,'Can you explain this?','unknown-error');
 expect(view?.turns?.at(-1)?.status).toBe('failed');expect(JSON.stringify(view)).not.toContain('Invented and unsafe claim');
});

it('keeps repeated provisional attempts conversational and uses fresh requested teaching',async()=>{
 const {store,task}=fixture();const state=store.getExplain(task.id)!;
 const current={...state.current!,teaching:'UNREVIEWED OLD LESSON'};
 store.saveExplain(task.id,{...state,current,candidates:state.candidates.map(q=>q.id===current.id?current:q),asked:[current]});
 model(wrong);await answerExplain(store,task.id,'It saves first and checks later.','miss-1');
 model({...wrong,teaching:'The check runs before saving; a rejected value cannot reach the write, preserving the old value.'});
 const practiced=await answerExplain(store,task.id,'It always saves before rejecting bad input.','miss-2');
 expect(practiced?.phase).toBe('asking');expect(store.getExplain(task.id)?.attempts).toBe(0);
 model({intent:'teach',text:'The check runs before saving; a rejected value cannot reach the write, preserving the old value.'});
 const view=await answerExplain(store,task.id,'Please explain this directly.','fresh-teach');
 expect(view?.phase).toBe('taught');expect(view?.turns?.at(-1)?.response).toContain('cannot reach the write');
 expect(view?.turns?.at(-1)?.response).not.toContain('UNREVIEWED');
 const revisit=await answerExplain(store,task.id,'Revisit this topic','local-revisit','revisit',undefined,current.id);
 expect(revisit?.turns?.at(-1)?.response).not.toContain('UNREVIEWED OLD LESSON');
});

it('runs grounded teaching through cloud HTTP, connector persistence and explicit learning navigation',async()=>{
 const {createHttpApp}=await import('../../cloud/src/http.js');
 const {explainEvidence}=await import('./learning.js');
 const {store,task,project,db}=fixture();const packet=store.getPacket(task.id)!;
 packet.activity[0]!.detail='The agent reports adding an outbox relay that sends committed intents.';store.savePacket(task.id,packet);
 const savedKey=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='synthetic-only';
 const cloud=createHttpApp({deviceForToken:async()=>({id:'synthetic',userId:'u'})} as any);
 let route={mode:'feedback',units:['outbox.order','outbox.retry'],verdict:'consistent',quote:'',reviewTurnId:null,intent:'answer',questionId:null,text:''};
 const sent:any[]=[];
 globalThis.fetch=vi.fn(async(url,init)=>{
  if(String(url).includes('/v1/learning'))return cloud.request('/v1/learning',init as any);
  const request=JSON.parse(String(init?.body));const context=JSON.parse(request.messages[1].content);sent.push(context);
  expect(String(init?.body)).not.toContain('PRIVATE ORIGINAL TASK');
  const json=context.action==='explain'?{concepts:[{title:'Transactional outbox',question:'Why commit before sending?',basisIds:['a']}]}:route;
  return Response.json({choices:[{message:{content:JSON.stringify(json)}}]});
 }) as typeof fetch;
 try {
  const artifact=await explainEvidence(packet,assembleUnderstand(packet));const concepts=artifact.learning!.concepts!;
  expect(concepts[0].support?.kind).toBe('source-backed');store.saveUnderstand(task.id,artifact);store.saveExplain(task.id,startExplainSession(packet,'moderate',[],[concepts[0],lesson]));
  const id=store.getExplain(task.id)!.current!.id;
  let view=await answerExplain(store,task.id,'The sender charges the external API before committing intent, so the transaction can undo the charge.','bad-approval');
  expect(view?.turns?.at(-1)).toMatchObject({assessed:false,understood:false,assessment:{status:'provisional'},support:{kind:'source-backed',scope:'general'}});
  expect(view?.turns?.at(-1)?.response).toContain('relay sends only after that commit');
  expect(store.getExplain(task.id)).toMatchObject({attempts:0,current:{id}});expect(store.demonstratedConcepts(project.id)).toEqual([]);
  route={...route,mode:'hint',units:['outbox.retry'],intent:'discuss'};
  view=await answerExplain(store,task.id,'Another hint please.','hint-1');const firstHint=view?.turns?.at(-1)?.response;
  view=await answerExplain(store,task.id,'More hint please.','hint-2');expect(view?.turns?.at(-1)?.response).not.toBe(firstHint);
  expect(sent.at(-1).history.at(-1).support).toMatchObject({mode:'hint',unitIds:['outbox.retry']});
  route={...route,mode:'example',units:['outbox.order'],intent:'teach'};
  view=await answerExplain(store,task.id,'Give a worked example.','example');expect(view?.phase).toBe('taught');expect(view?.turns?.at(-1)?.response).toContain('receiver effects: 1');
  route={...route,mode:'discuss',units:['outbox.retry'],intent:'discuss'};
  view=await answerExplain(store,task.id,'Does a sender crash erase the receiver key?','followup');expect(view?.turns?.at(-1)?.response).toContain('does not erase that receiver record');
  route={...route,mode:'review',intent:'review',reviewTurnId:'bad-approval' as any};
  view=await answerExplain(store,task.id,'I meant committing happens first; review my initial answer.','review');
  expect(view?.turns?.at(-1)).toMatchObject({reviewOf:'bad-approval',assessment:{status:'provisional'}});
  await answerExplain(store,task.id,'Practise this concept','practice','practice');expect(store.getExplain(task.id)?.phase).toBe('asking');
  await answerExplain(store,task.id,'Next concept','next','next');expect(store.getExplain(task.id)?.current?.id).not.toBe(id);
  await answerExplain(store,task.id,'Revisit outbox','revisit','revisit',undefined,id);expect(store.getExplain(task.id)?.returnTo).toBeTruthy();
  await answerExplain(store,task.id,'Return to the next concept','return','next');
  await answerExplain(store,task.id,'Finish this session','finish','finish');
  route={...route,mode:'discuss',intent:'discuss',reviewTurnId:null};
  view=await answerExplain(store,task.id,'Why can an outbox retry duplicate delivery?','after');expect(view?.phase).toBe('done');
  const restored=new Store(db).getExplain(task.id)!;expect(restored.turns?.every(t=>t.status==='replied'&&t.message&&t.response)).toBe(true);expect(restored.turns?.[0].assessment?.status).toBe('provisional');expect(restored.feedback.understood).toEqual([]);
 } finally {if(savedKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=savedKey;}
});

const boundedGood="The sender cannot know whether the receiver succeeded because the response was lost. Enforcing a unique stable key and recording it atomically with the database effect at the receiver prevents another effect when the sender retries that key. The receiver's durable key survives because only the sender crashed.";
const boundedBad="A sender crash erases the receiver's durable key.";
async function eligibleFixture(unitId='outbox.retry'){
 const {ASSESSMENT_SPECS,ASSESSABLE_TEACHING_REVISION}=await import('@prentice/domain');
 const f=fixture();const spec=ASSESSMENT_SPECS.find(s=>s.id===unitId)!;
 const supported:LearningConcept={...lesson,title:'Receiver deduplication on retry',question:spec.question,expectedPoints:spec.criteria,support:{kind:'source-backed',scope:'general',revision:ASSESSABLE_TEACHING_REVISION,unitIds:[spec.id],sources:spec.sources.map((url,i)=>({id:'source-'+i,title:'Maintained source',url,reviewedOn:'2026-10-12'}))}};
 f.store.saveExplain(f.task.id,startExplainSession(f.store.getPacket(f.task.id)!,'moderate',[],[supported,lesson]));
 return {...f,supported};
}
it('awards eligible mastery, persists the rule evidence locally, and advances without trusting the model judgment',async()=>{
 const {store,task,project,db,supported}=await eligibleFixture();
 model({...correct,understood:false,text:'Source-backed teaching.',support:supported.support});
 const view=await answerExplain(store,task.id,boundedGood,'eligible');
 expect(view).toMatchObject({phase:'asking',questionNumber:2});
 expect(view?.turns?.at(-1)).toMatchObject({assessed:true,understood:true,assessment:{status:'assessed',outcome:'understood',method:'bounded-rules'}});
 expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
 expect(store.getExplain(task.id)?.turns?.at(-1)?.assessment).toHaveProperty('evidence');
 expect(view?.turns?.at(-1)?.assessment).not.toHaveProperty('evidence');
 expect(new Store(db).getExplain(task.id)?.feedback.understood).toContain(supported.title);
 expect((await answerExplain(store,task.id,boundedGood,'eligible'))?.turns?.filter(t=>t.id==='eligible')).toHaveLength(1);
});
it('keeps ambiguous answers and forged assessment certificates provisional',async()=>{
 const {store,task,project,supported}=await eligibleFixture();
 model({...correct,support:supported.support,assessment:{status:'assessed',method:'bounded-rules',outcome:'understood'}});
 const view=await answerExplain(store,task.id,boundedGood+' Our implementation guarantees no duplicates.','unknown-claim');
 expect(view?.turns?.at(-1)).toMatchObject({assessed:false,understood:false,assessment:{status:'provisional'}});
 expect(store.getExplain(task.id)).toMatchObject({initialAsked:1,attempts:0});expect(store.demonstratedConcepts(project.id)).toEqual([]);
 model({...correct,support:{...supported.support,revision:'unvalidated'}});await answerExplain(store,task.id,boundedGood,'stale-response');
 expect(store.getExplain(task.id)?.feedback.understood).toEqual([]);
});
it('preserves demonstrated understanding through provisional and contradictory clarifications',async()=>{
 const {store,task,project,supported}=await eligibleFixture();model({...correct,support:supported.support});
 await answerExplain(store,task.id,boundedGood,'proof');const current=store.getExplain(task.id)!.current!.id;
 model({intent:'review',reviewTurnId:'proof',understood:false,text:'Uncertain review.',support:supported.support});
 await answerExplain(store,task.id,'I meant: '+boundedBad,'inconclusive');
 expect(store.getExplain(task.id)?.feedback.understood).toContain(supported.title);expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
 expect(store.getExplain(task.id)?.turns?.at(-1)?.assessment?.status).toBe('provisional');expect(store.getExplain(task.id)?.current?.id).toBe(current);
 await answerExplain(store,task.id,'My first answer was actually correct.','review-correct');
 expect(store.getExplain(task.id)?.turns?.at(-1)).toMatchObject({assessed:true,understood:true});
});
it('retracts an earlier incorrect judgment only after a reliable reassessment of the saved answer',async()=>{
 const {store,task,project,supported}=await eligibleFixture();model({...correct,support:supported.support});
 await answerExplain(store,task.id,boundedBad,'old-wrong');
 const state=store.getExplain(task.id)!;
 // Simulate an older model falsely awarding this exact answer; no new rule pass is fabricated.
 store.saveExplain(task.id,{...state,feedback:{understood:[supported.title],unclear:[]},turns:state.turns!.map(t=>({...t,assessed:true,understood:true,assessment:undefined}))});store.demonstrate(project.id,supported.title);
 model({intent:'review',reviewTurnId:'old-wrong',understood:true,text:'The model still thinks this is correct.',support:supported.support});
 await answerExplain(store,task.id,'Please review my first answer.','reassess');
 expect(store.getExplain(task.id)?.turns?.at(-1)).toMatchObject({assessed:true,understood:false,assessment:{status:'assessed',outcome:'incorrect'}});
 expect(store.getExplain(task.id)?.feedback.understood).not.toContain(supported.title);expect(store.demonstratedConcepts(project.id)).not.toContain(supported.title);
 const other=store.insertTask(project.id,'Independent proof');store.saveExplain(other.id,{...state,feedback:{understood:[supported.title],unclear:[]}});store.demonstrate(project.id,supported.title);
 const now=store.getExplain(task.id)!;store.saveExplain(task.id,{...now,feedback:{...now.feedback,understood:[supported.title]}});
 await answerExplain(store,task.id,'Please review my first answer.','reassess-again');
 expect(store.getExplain(task.id)?.feedback.understood).not.toContain(supported.title);expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
});
it('uses reliable repeated misses for coaching without turning subsequent help into an assessment',async()=>{
 const {store,task,supported}=await eligibleFixture();model({...correct,support:supported.support,understood:true,teaching:'A lost response does not erase the receiver record.'});
 await answerExplain(store,task.id,boundedBad,'miss-1');await answerExplain(store,task.id,boundedBad,'miss-2');
 expect(store.getExplain(task.id)).toMatchObject({phase:'taught',attempts:2});
 model({...discussion,support:supported.support});await answerExplain(store,task.id,'Can you give me another hint?','help');
 expect(store.getExplain(task.id)).toMatchObject({phase:'taught',attempts:2});expect(store.getExplain(task.id)?.turns?.at(-1)?.assessed).toBe(false);
});

it('carries eligible assessment through real cloud HTTP and preserves a later valid proof when reviewing an older wrong answer',async()=>{
 const {createHttpApp}=await import('../../cloud/src/http.js');const {store,task,project,supported}=await eligibleFixture();
 const savedKey=process.env.GROQ_API_KEY;process.env.GROQ_API_KEY='synthetic';
 const cloud=createHttpApp({deviceForToken:async()=>({id:'synthetic',userId:'u'})} as any);
 let route={mode:'feedback',intent:'answer',units:['outbox.retry'],verdict:'consistent',quote:'',reviewTurnId:null as string|null,questionId:null,text:''};
 globalThis.fetch=vi.fn(async(url,init)=>{
  if(String(url).includes('/v1/learning'))return cloud.request('/v1/learning',init as any);
  const context=JSON.parse(JSON.parse(String(init?.body)).messages[1].content);
  expect(context.current.support??context.reviews[0]?.support).toMatchObject({scope:'general'});
  expect(context.history.every((h:any)=>!h.assessment?.evidence)).toBe(true);
  expect(String(init?.body)).not.toContain('PRIVATE ORIGINAL TASK');
  return Response.json({choices:[{message:{content:JSON.stringify(route)}}]});
 }) as typeof fetch;
 try{
  expect(explainView(store.getExplain(task.id))?.current?.assessmentEligible).toBe(true);
  await answerExplain(store,task.id,boundedBad,'wrong');expect(store.getExplain(task.id)?.attempts).toBe(1);
  route={...route,verdict:'gap'};
  const passed=await answerExplain(store,task.id,boundedGood,'proof');expect(passed?.questionNumber).toBe(2);expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
  const current=store.getExplain(task.id)!.current!.id;
  route={...route,mode:'review',intent:'review',reviewTurnId:'wrong',verdict:'consistent'};
  const reviewed=await answerExplain(store,task.id,'Please review my first answer.','review');
  expect(reviewed?.turns?.at(-1)).toMatchObject({assessed:true,understood:false,assessment:{status:'assessed',outcome:'incorrect'}});
  expect(store.getExplain(task.id)?.current?.id).toBe(current);expect(store.getExplain(task.id)?.attempts).toBe(0);
  expect(store.getExplain(task.id)?.feedback.understood).toContain(supported.title);expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
 }finally{if(savedKey===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=savedKey;}
});

it('keeps queued eligible assessments on the submitted topic and cannot award mastery after Skip',async()=>{
 const {store,task,project,supported}=await eligibleFixture();const first=store.getExplain(task.id)!.current!.id;
 let release!:()=>void;const waiting=new Promise<void>(r=>{release=r;});let calls=0;
 globalThis.fetch=vi.fn(async()=>{if(++calls===1)await waiting;return Response.json({result:{...correct,support:supported.support}});}) as typeof fetch;
 const one=answerExplain(store,task.id,boundedGood,'one');const two=answerExplain(store,task.id,boundedBad,'two');
 await vi.waitFor(()=>expect(store.getExplain(task.id)?.turns?.[0]?.status).toBe('pending'));release();await Promise.all([one,two]);
 expect(store.getExplain(task.id)).toMatchObject({initialAsked:2,attempts:0});expect(store.getExplain(task.id)?.turns?.map(t=>t.questionId)).toEqual([first,first]);expect(store.demonstratedConcepts(project.id)).toContain(supported.title);
 const other=await eligibleFixture();let unblock!:()=>void;const late=new Promise<void>(r=>{unblock=r;});
 globalThis.fetch=vi.fn(async()=>{await late;return Response.json({result:{...correct,support:other.supported.support}});}) as typeof fetch;
 const pending=answerExplain(other.store,other.task.id,boundedGood,'late');await vi.waitFor(()=>expect(other.store.getExplain(other.task.id)?.turns?.[0]?.status).toBe('pending'));
 skipExplain(other.store,other.task.id);unblock();await pending;
 expect(other.store.getExplain(other.task.id)?.phase).toBe('skipped');expect(other.store.demonstratedConcepts(other.project.id)).toEqual([]);
});

it('can assess a short explicit misconception without confusing it with an incomplete answer',async()=>{
 const {store,task,supported}=await eligibleFixture('cookie.csrf');model({...correct,support:supported.support});
 await answerExplain(store,task.id,'Requiring POST alone prevents CSRF.','short-misconception');
 expect(store.getExplain(task.id)?.turns?.at(-1)).toMatchObject({assessed:true,understood:false,assessment:{status:'assessed',outcome:'incorrect'}});expect(store.getExplain(task.id)?.attempts).toBe(1);
});

async function semanticFixture(){
 const f=fixture();const packet=f.store.getPacket(f.task.id)!;
 const subject={...lesson,title:'TypeScript runtime boundary',question:'Why does a TypeScript assertion not validate an API response?',expectedPoints:['Explain static checks versus runtime input']};
 f.store.saveExplain(f.task.id,startExplainSession(packet,'moderate',[],[subject,{...lesson,title:'Next concept'}]));return {...f,subject};
}
const semanticGood='The assertion is erased when JavaScript is emitted, so incoming JSON still needs a runtime check.';
async function semanticReply(f:Awaited<ReturnType<typeof semanticFixture>>,answer:string,outcome='understood',reviewOf?:string){
 const {assessmentBinding,KNOWLEDGE,KNOWLEDGE_REVISION}=await import('@prentice/domain');
 const q=f.store.getExplain(f.task.id)!.asked[0]!;const ref=KNOWLEDGE.find(r=>r.id==='types')!;
 return {intent:reviewOf?'review':'answer',reviewTurnId:reviewOf,understood:outcome==='understood',text:'The response distinguishes the static annotation from the actual runtime payload.',hint:'What code inspects the received values?',teaching:'Types are erased; validate the actual payload.',support:{kind:'source-backed',scope:'general',revision:KNOWLEDGE_REVISION,unitIds:['types'],sources:[{id:'types',title:'TypeScript',url:ref.source,reviewedOn:'2026-10-16'}]},assessment:{status:'assessed',method:'source-review',revision:KNOWLEDGE_REVISION,unitId:'general-concept',outcome,reason:'Source-grounded independent review.',proof:{binding:await assessmentBinding(q,answer),models:['openai/gpt-oss-120b','qwen/qwen3.8-27b'],criteria:[{criterion:'Distinguishes static type erasure from runtime validation',state:outcome==='incorrect'?'contradicted':'met',quote:answer.split('\n')[0],sourceId:'types',sourceQuote:ref.principle},...(outcome==='partial'?[{criterion:'Explains remaining runtime validation of untrusted data',state:'missing',quote:'',sourceId:'types',sourceQuote:ref.principle}]:[])]}}};
}
it('records new-topic semantic mastery, advances and persists while keeping proof quotes local',async()=>{
 const f=await semanticFixture();model(await semanticReply(f,semanticGood));const result=await answerExplain(f.store,f.task.id,semanticGood,'semantic-pass');
 expect(result?.questionNumber).toBe(2);expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);
 expect(f.store.getExplain(f.task.id)?.turns?.[0]?.assessment).toMatchObject({status:'assessed',method:'source-review',outcome:'understood'});
 expect((result?.turns?.[0]?.assessment as any).proof).toBeUndefined();expect((result?.turns?.[0]?.assessment as any).evidence).toBeUndefined();
 expect(new Store(f.db).getExplain(f.task.id)?.feedback.understood).toContain(f.subject.title);
 const current=f.store.getExplain(f.task.id)!.current!.id;model({intent:'review',reviewTurnId:'semantic-pass',understood:false,text:'This review is inconclusive.',assessment:{status:'provisional',tentative:'uncertain',reason:'Missing context'}});
 await answerExplain(f.store,f.task.id,'To clarify: maybe the assertion also checks JSON?','ambiguous-review');expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);expect(f.store.getExplain(f.task.id)?.current?.id).toBe(current);
});
it('counts partial/incorrect semantic attempts, keeps help conversational, then accepts a genuine explanation',async()=>{
 const f=await semanticFixture();const partial='The assertion is erased when JavaScript is emitted.';
 model(await semanticReply(f,partial,'partial'));await answerExplain(f.store,f.task.id,partial,'partial');expect(f.store.getExplain(f.task.id)).toMatchObject({phase:'asking',attempts:1});expect(f.store.demonstratedConcepts(f.project.id)).toEqual([]);
 const bad='The assertion validates all JSON at runtime.';model(await semanticReply(f,bad,'incorrect'));await answerExplain(f.store,f.task.id,bad,'wrong');expect(f.store.getExplain(f.task.id)).toMatchObject({phase:'taught',attempts:2});
 model(discussion);await answerExplain(f.store,f.task.id,'Another hint please','hint');expect(f.store.getExplain(f.task.id)).toMatchObject({phase:'taught',attempts:2});
 model(await semanticReply(f,semanticGood));await answerExplain(f.store,f.task.id,semanticGood,'genuine');expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);
 const sent:any[]=[];globalThis.fetch=vi.fn(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));return Response.json({result:discussion});}) as typeof fetch;
 await answerExplain(f.store,f.task.id,'What about input from another client?','followup');expect(JSON.stringify(sent)).not.toContain('PRIVATE ORIGINAL TASK');expect(sent[0].history.every((h:any)=>!h.assessment?.proof&&!h.assessment?.evidence)).toBe(true);
});
it('rejects a semantic certificate for another answer or without matching typed source support',async()=>{
 const f=await semanticFixture();const reply=await semanticReply(f,semanticGood);model(reply);
 await answerExplain(f.store,f.task.id,'The assertion checks JSON automatically.','mismatch');expect(f.store.getExplain(f.task.id)?.attempts).toBe(0);expect(f.store.demonstratedConcepts(f.project.id)).toEqual([]);
 model({...reply,support:undefined});await answerExplain(f.store,f.task.id,semanticGood,'missing-source');expect(f.store.demonstratedConcepts(f.project.id)).toEqual([]);
});
it('retracts a false historical new-topic judgment only after a bound, source-grounded reassessment',async()=>{
 const f=await semanticFixture();const bad='The assertion validates all JSON at runtime.';model({intent:'answer',understood:true,text:'A legacy false approval.'});await answerExplain(f.store,f.task.id,bad,'historical');
 const state=f.store.getExplain(f.task.id)!;f.store.saveExplain(f.task.id,{...state,feedback:{understood:[f.subject.title],unclear:[]},turns:state.turns!.map(t=>({...t,assessed:true,understood:true}))});f.store.demonstrate(f.project.id,f.subject.title);
 const review='Please review my first answer.';model(await semanticReply(f,`${bad}\n${review}`,'incorrect','historical'));await answerExplain(f.store,f.task.id,review,'reassessment');expect(f.store.demonstratedConcepts(f.project.id)).not.toContain(f.subject.title);
});

it('runs the default cloud/connector teaching flow through HTTP with independent blind grading and private local evidence',async()=>{
 const f=await semanticFixture();const {createHttpApp}=await import('../../cloud/src/http.js');const {KNOWLEDGE}=await import('@prentice/domain');
 const cloud=createHttpApp({deviceForToken:async()=>({id:'synthetic',userId:'u'})} as any);
 const priorKey=process.env.GROQ_API_KEY,priorModel=process.env.GROQ_MODEL,priorReview=process.env.GROQ_REVIEW_MODEL;
 process.env.GROQ_API_KEY='synthetic';process.env.GROQ_MODEL='openai/gpt-oss-120b';process.env.GROQ_REVIEW_MODEL='qwen/qwen3.8-27b';
 let mode='wrong';const requests:any[]=[];
 globalThis.fetch=vi.fn(async(url,init)=>{
  if(String(url).includes('/v1/learning'))return cloud.request('/v1/learning',init as any);
  const req=JSON.parse(String(init?.body)),c=JSON.parse(req.messages[1].content);requests.push(req);
  expect(String(init?.body)).not.toContain('PRIVATE ORIGINAL TASK');
  let result:any;
  if(req.model==='openai/gpt-oss-120b')result={evaluation:{outcome:mode==='hint'?'unassessed':mode==='good'?'understood':'incorrect',reason:'Explains the runtime trust boundary.',criteria:mode==='hint'?[]:[{criterion:'Distinguishes erased types from runtime checks',state:mode==='good'?'met':'contradicted',quote:c.message,sourceId:'types',sourceQuote:KNOWLEDGE.find(r=>r.id==='types')!.principle}]},intent:mode==='hint'?'discuss':'answer',understood:mode==='good',text:mode==='hint'?'Imagine the JSON contains a string where you expect a number: which runtime code would reject it?':'The distinction is whether emitted JavaScript checks the actual value.',hint:mode==='good'?'':'What examines the real value after compilation?',teaching:mode==='wrong'?'Type annotations are erased. Check external input with runtime validation.':'',reviewTurnId:null,questionId:null};
  else if(c.latestExchange)result={safe:true,coverage:true,reason:'The explanation stays within the source boundary.'};
  else result={safeTeaching:true,coverage:true,outcome:mode==='hint'?'unassessed':mode==='good'?'understood':'incorrect',reason:'Independent source-grounded reasoning.',criteria:mode==='hint'?[]:[{criterion:'Distinguishes erased types from runtime checks',state:mode==='good'?'met':'contradicted',quote:c.evaluatedAnswer,sourceId:'types',sourceQuote:KNOWLEDGE.find(r=>r.id==='types')!.principle}],feedback:'',hint:''};
  return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});
 }) as typeof fetch;
 try{
  await answerExplain(f.store,f.task.id,'A type assertion checks JSON at runtime.','one');
  await answerExplain(f.store,f.task.id,'The assertion rejects malformed JSON at runtime.','two');
  expect(f.store.getExplain(f.task.id)).toMatchObject({phase:'taught',attempts:2});
  mode='hint';await answerExplain(f.store,f.task.id,'Give another hint please','help');expect(f.store.getExplain(f.task.id)?.attempts).toBe(2);
  mode='good';const passed=await answerExplain(f.store,f.task.id,semanticGood,'pass');expect(passed?.questionNumber).toBe(2);expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);
  expect(requests.filter(r=>r.messages[0].content.startsWith('You are an independent')).every(r=>JSON.parse(r.messages[1].content).candidate===undefined||JSON.parse(r.messages[1].content).purpose==='discuss')).toBe(true);
  expect((passed?.turns?.at(-1)?.assessment as any).proof).toBeUndefined();expect(new Store(f.db).getExplain(f.task.id)?.turns?.at(-1)?.assessment).toHaveProperty('proof');
 }finally{
  for(const [name,value] of [['GROQ_API_KEY',priorKey],['GROQ_MODEL',priorModel],['GROQ_REVIEW_MODEL',priorReview]])if(value===undefined)delete process.env[name!];else process.env[name!]=value;
 }
});

it('preserves existing mastery on a partial review, including a later pass that reconciles the judgment ledger',async()=>{
 const f=await semanticFixture();model(await semanticReply(f,semanticGood));await answerExplain(f.store,f.task.id,semanticGood,'proof');
 const review='Please review my first answer.';
 model(await semanticReply(f,`${semanticGood}\n${review}`,'partial','proof'));await answerExplain(f.store,f.task.id,review,'partial-review');
 expect(f.store.getExplain(f.task.id)?.turns?.at(-1)?.assessment).toMatchObject({status:'assessed',outcome:'partial'});expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);expect(f.store.getExplain(f.task.id)?.feedback.understood).toContain(f.subject.title);
 model(await semanticReply(f,`${semanticGood}\n${review}`,'understood','proof'));await answerExplain(f.store,f.task.id,review,'reconfirmed');expect(f.store.demonstratedConcepts(f.project.id)).toContain(f.subject.title);
});

it('retains the local no-credit guard for a copied rubric even with an optimistic semantic certificate',async()=>{
 const f=await semanticFixture();const text=f.store.getExplain(f.task.id)!.current!.expectedPoints.join(' ');model(await semanticReply(f,text));
 await answerExplain(f.store,f.task.id,text,'copied');expect(f.store.demonstratedConcepts(f.project.id)).toEqual([]);expect(f.store.getExplain(f.task.id)?.attempts).toBe(0);
});

it('retains the actual first answer for an explicit review beyond the bounded recent window',async()=>{
 const {store,task}=fixture();model(wrong);
 for(let i=0;i<8;i++)await answerExplain(store,task.id,`My explanation attempt number ${i} says invalid input is written before checking.`,`old-${i}`);
 let body:any;
 globalThis.fetch=vi.fn(async(_url,init)=>{body=JSON.parse(String(init?.body));return Response.json({result:{intent:'review',reviewTurnId:'old-0',understood:false,text:'This review remains inconclusive.',assessment:{status:'provisional',tentative:'uncertain',reason:'Insufficient assessment evidence.'}}});}) as typeof fetch;
 await answerExplain(store,task.id,'Please review my first answer.','review-oldest');
 expect(body.reviews).toHaveLength(6);expect(body.reviews[0]).toMatchObject({id:'old-0',first:true,answer:expect.stringContaining('number 0')});expect(body.history).toHaveLength(6);
 expect(JSON.stringify(body)).not.toContain('PRIVATE ORIGINAL TASK');expect(store.getExplain(task.id)?.turns?.at(-1)?.reviewOf).toBe('old-0');
});
