// Existing single-model fallback regression fixtures.
process.env.GROQ_REVIEW_MODEL="disabled";
import { afterEach, expect, it, vi } from "vitest";
import { reviewedTeaching, reviewIssues, TEACHING_UNRELIABLE } from "./teaching-review.js";
import { completeLearning } from "./learning.js";
const fetchBefore = globalThis.fetch;
const keyBefore = process.env.GROQ_API_KEY;
afterEach(() => { globalThis.fetch = fetchBefore; vi.restoreAllMocks(); if (keyBefore === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = keyBefore; });
const pass = { checks: {technical:true,evidence:true,consistency:true,assessment:true}, issues:[] };
const rejection = (claim: string, basis = "general") => ({ checks:{...pass.checks,technical:false}, issues:[{claim,basis,reason:"This guarantee does not follow; separate the components and transaction boundaries."}] });
function sequence(values: unknown[], enforceJsonMode = false) {
 const requests: Array<{system:string; context:Record<string,unknown>; signal?:AbortSignal|null}> = [];
 globalThis.fetch=vi.fn(async(_url,init)=>{
   const body=JSON.parse(String(init?.body)); requests.push({system:body.messages[0].content,context:JSON.parse(body.messages[1].content),signal:init?.signal});
   if(enforceJsonMode && body.response_format?.type === "json_object" && !body.messages.some((message:{content:string}) => /\bjson\b/i.test(message.content))) return Response.json({error:{message:"messages must contain json"}},{status:400});
   const next=values.shift(); if(next instanceof Response) return next;
   return Response.json({choices:[{message:{content:JSON.stringify(next)}}]});
 }) as typeof fetch;
 return requests;
}
const config={apiKey:"synthetic-test-key",model:"test-model"};
it.each([
 ['outbox','The outbox atomically records the external charge and local key.','The sender commits business data and intent before sending. The receiver must deduplicate its own effect.'],
 ['cookies','HttpOnly prevents CSRF and all XSS actions.','HttpOnly blocks script cookie reads; it does not stop automatic cookie sending or all XSS actions.'],
 ['transactions','ROLLBACK unsends the email.','Rollback reverses participating database changes, not an email already sent.'],
 ['retries','A lost acknowledgement means the external operation failed.','A lost acknowledgement leaves the result uncertain; retry can duplicate a successful effect.'],
 ['interruption','Aborting the request proves all grandchildren exited and undoes their writes.','Cancellation cannot undo committed writes or establish descendant exit without verification.'],
 ['authorization','Hiding the delete button authorizes only administrators.','The server must validate permissions on each protected request.'],
])('repairs a rejected %s claim and independently rechecks the replacement',async(_topic,bad,good)=>{
 const draft={intent:'teach',text:bad,hint:''}; const fixed={...draft,text:good};
 const requests=sequence([draft,rejection(bad),fixed,pass]);
 const context={evidence:{facts:[],agentStated:[]},history:[{reply:'Earlier bounded teaching.'}],message:'Please give an example.'};
 expect(await reviewedTeaching(config,'generation',context)).toEqual({ok:true,json:fixed});
 expect(requests).toHaveLength(4);expect(requests[1]?.context).toMatchObject({context,candidate:draft});
 expect(requests[2]?.context).toMatchObject({...context,revision:{response:draft}});
 expect(requests[3]?.context.candidate).toEqual(fixed);
 expect(JSON.stringify(requests[1]?.context.references)).toContain('https://');
});
it('withholds a repaired contradiction instead of releasing the more fluent draft',async()=>{
 sequence([{text:'Receiver stored key.'},rejection('Receiver stored key.'),{text:'Sender crash erases receiver key.'},rejection('Sender crash erases receiver key.','conversation')]);
 expect(await reviewedTeaching(config,'generation',{})).toMatchObject({ok:false,code:'TEACHING_UNRELIABLE',message:TEACHING_UNRELIABLE});
});
it.each([null,{}, {checks:pass.checks,issues:'none'}, {...pass,checks:{technical:true}}, {...pass,issues:[{claim:'x',basis:'invented',reason:'y'}]}])('fails closed on a malformed reviewer verdict %j',async verdict=>{
 const requests=sequence([{text:'Unchecked claim.'},verdict]);
 expect(await reviewedTeaching(config,'generation',{})).toMatchObject({ok:false,code:'TEACHING_UNRELIABLE'});expect(requests).toHaveLength(2);
});
it('does not accept approval with reported issues or false checks',()=>{
 expect(reviewIssues({...pass,checks:{...pass.checks,evidence:false}})).not.toBeNull();
 expect(reviewIssues({...pass,issues:[{claim:'Implemented Secure',basis:'repository',reason:'Only a filename is known.'}]})).not.toBeNull();
 expect(reviewIssues(pass)).toBeNull();
});
it('withholds the draft when the reviewer is unavailable',async()=>{
 sequence([{text:'Draft'},new Response('',{status:429})]);
 expect(await reviewedTeaching(config,'generation',{})).toMatchObject({ok:false,code:'TEACHING_UNRELIABLE'});
});
it('shares the overall deadline and does not release a draft when review has no time',async()=>{
 const requests=sequence([{text:'Draft'}]);vi.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(29_999);
 expect(await reviewedTeaching(config,'generation',{})).toMatchObject({ok:false,code:'TEACHING_UNRELIABLE'});expect(requests).toHaveLength(1);
});
it('reviews hints, original topic, faulty lesson criteria and prior examples together',async()=>{
 process.env.GROQ_API_KEY='synthetic-test-key';
 const context={action:'tutor',evidence:{facts:[{id:'f',text:'Added use of localStorage.setItem.'}],agentStated:[]},current:{prompt:'What does HttpOnly protect?',criteria:['HttpOnly prevents CSRF']},history:[{reply:'HttpOnly stops cookie sending.'}],message:'Another hint please'};
 const fixed={intent:'discuss',text:'I need to correct the earlier premise: HttpOnly restricts script reads, not cookie sending. Think about whether a cross-site request needs to read the cookie.',hint:''};
 const requests=sequence([{intent:'discuss',text:'Think about HttpOnly.',hint:'Because it stops cookie sending, does it prevent CSRF?'},rejection('it stops cookie sending'),fixed,pass]);
 expect(await reviewedTeaching(config,'Return JSON.',context)).toEqual({ok:true,json:fixed});
 expect(requests[1]?.context).toMatchObject({context:{current:context.current,history:context.history},candidate:{hint:expect.stringContaining('stops cookie sending')}});
});
it.each(['explain','phrase','judge','discuss'])('reviews the %s path before it seeds learning or grading',async action=>{
 process.env.GROQ_API_KEY='synthetic-test-key';const requests=sequence([{text:'Candidate'},pass]);
 expect(await completeLearning({action,evidence:{facts:[]},answer:'Reasoning',question:'Why?'})).toMatchObject({ok:true});
 expect(requests).toHaveLength(2);expect(requests[1]?.context.candidate).toEqual({text:'Candidate'});
});

it('requires fresh reviewed teaching on repeated misses rather than blindly reusing a saved lesson',async()=>{
 process.env.GROQ_API_KEY='synthetic-test-key';
 const repaired={intent:'answer',understood:false,text:'The transaction covers participating database changes.',hint:'Is the email inside the database transaction?',teaching:'Rollback reverses participating database changes. An email already sent remains an external effect.'};
 const requests=sequence([{intent:'answer',understood:false,text:'Not quite.',hint:''},repaired,pass]);
 expect(await completeLearning({action:'tutor',evidence:{facts:[]},current:{prompt:'Why validate first?',teaching:'UNCHECKED OLD LESSON'},coaching:{attempts:1},message:'A failed check writes invalid data first.'})).toMatchObject({ok:true,json:{...repaired,text:expect.stringContaining(repaired.text),assessment:{status:'provisional'}}});
 expect(requests).toHaveLength(3);expect(requests[2]?.context.candidate).toEqual(repaired);
});

it('selects references from newly introduced draft claims as well as the original topic',async()=>{
 const {relevantReferences}=await import('./teaching-review.js');
 expect(relevantReferences({message:'Explain validation.'},{text:'HttpOnly prevents CSRF.'}).map(x=>x.id)).toEqual(expect.arrayContaining(['cookies','csrf']));
 expect(relevantReferences({current:{concept:'Transactional outbox'}},{text:'Use a stable key.'}).map(x=>x.id)).toEqual(expect.arrayContaining(['outbox','transactions']));
 expect(relevantReferences({message:'Explain a linked list.'},{text:'Each node refers to the next node.'})).toEqual([]);
});

it('does not forward an oversized model draft into review or repair',async()=>{
 const requests=sequence([{text:'x'.repeat(64_001)}]);
 expect(await reviewedTeaching(config,'generation',{})).toMatchObject({ok:false,code:'TEACHING_UNRELIABLE'});expect(requests).toHaveLength(1);
});

it('reviews the displayed replacement rather than silently truncating a qualified explanation',async()=>{
 process.env.GROQ_API_KEY='synthetic-test-key';
 const fixed={intent:'teach',text:'A local transaction cannot undo an external email.',hint:''};
 const requests=sequence([{intent:'teach',text:'x'.repeat(6001)+' Only under an additional assumption.',hint:''},fixed,pass]);
 expect(await completeLearning({action:'tutor',evidence:{facts:[]},message:'Explain a linked list.'})).toMatchObject({ok:true,json:{...fixed,text:expect.stringContaining(fixed.text),support:{kind:'provisional'}}});
 expect(requests).toHaveLength(3);expect(requests[2]?.context.candidate).toEqual(fixed);
});

it('can correct an assessment based on a flawed saved rubric without treating that rubric as fact',async()=>{
 const context={action:'tutor',current:{prompt:'Does HttpOnly prevent CSRF?',criteria:['HttpOnly prevents CSRF']},message:'HttpOnly stops script reads, but the browser still sends the cookie, so it alone does not prevent CSRF.'};
 const corrected={intent:'answer',understood:true,text:'Your distinction is correct. The earlier criterion was wrong: HttpOnly restricts script reads, not automatic cookie sending.',hint:''};
 const requests=sequence([{intent:'answer',understood:false,text:'You must explain how HttpOnly prevents CSRF.',hint:''},{checks:{...pass.checks,assessment:false,technical:false},issues:[{claim:'HttpOnly prevents CSRF',basis:'assessment',reason:'The saved rubric is false; judge the actual mechanism described by the learner.'}]},corrected,pass]);
 expect(await reviewedTeaching(config,'generation',context)).toMatchObject({ok:true,json:corrected});
 expect(requests[2]?.system).toContain('Required top-level schema:');expect(requests[2]?.context.message).toBe(context.message);
});

// Simulate the provider's request validation, not a model-quality verdict.
it.each([false,true])('keeps repair requests valid under the provider JSON-mode contract (structural=%s)',async structural=>{
 const draft={text:'Bad draft'};const fixed={text:'Corrected explanation'};
 const requests=sequence(structural?[draft,fixed,pass]:[draft,rejection('Bad draft'),fixed,pass],true);
 const shapeCheck=structural?(value:unknown)=>(value as {text:string}).text==='Bad draft'?'Invalid response shape':null:undefined;
 expect(await reviewedTeaching(config,'Return JSON.',{action:'tutor',message:'Explain this.'},shapeCheck)).toEqual({ok:true,json:fixed});
 expect(requests).toHaveLength(structural?3:4);
});
