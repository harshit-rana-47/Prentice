/** Fresh fixed-matrix live evaluation; all failures retained. Uses synthetic evidence only.
 * node --experimental-sqlite --env-file=.env --import tsx scripts/evaluate-explain-systematically.mts output.json
 */
import {existsSync,readFileSync,writeFileSync,mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {completeLearning} from '../apps/cloud/src/learning.ts';
import {createHttpApp} from '../apps/cloud/src/http.ts';
import {startExplainSession,assembleUnderstand} from '../packages/domain/src/index.ts';
import {openDatabase,migrate} from '../apps/connector/src/db.ts';
import {Store} from '../apps/connector/src/store.ts';
import {answerExplain} from '../apps/connector/src/session.ts';
import {setLearningEndpoint} from '../apps/connector/src/learning.ts';
const paths=['apps/cloud/src/learning.ts','apps/cloud/src/semantic-tutor.ts','apps/cloud/src/groq.ts','apps/cloud/src/source-teaching.ts','apps/cloud/src/teaching-examples.ts','packages/domain/src/source-assessment.ts','packages/domain/src/knowledge.ts','packages/domain/src/explain-back.ts','packages/domain/src/index.ts','apps/connector/src/learning.ts','apps/connector/src/session.ts'];
const digest=()=>createHash('sha256').update(paths.map(p=>readFileSync(p,'utf8')).join('\n')).digest('hex');
const codeDigest=digest();
const topics=[
 {id:'outbox',question:'A receiver commits key K and a database effect, but the response is lost and the sender crashes. What happens on retry and why?',criteria:['Explain sender uncertainty, stable-key receiver deduplication and durable state.'],good:'The missing reply leaves the sender unsure, not the receiver undone. If retries reuse K and the receiver atomically recorded K with its database effect under a unique constraint, it can return the prior result without repeating that effect. Crashing the sender does not wipe the receiver database.',bad:'The sender crash erases the receiver key, so retry must perform the effect again.'},
 {id:'cookies',question:'Does using HttpOnly cookies and requiring POST prevent CSRF? Explain the browser and server responsibilities.',criteria:['Explain cookie sending and the need for appropriate server defenses.'],good:'HttpOnly keeps scripts from reading the value, but the browser can still attach cookies to eligible requests. A malicious site can submit a POST form too. The server needs an appropriate token or trusted-origin check; SameSite provides mode-dependent protection rather than authorization.',bad:'HttpOnly means the browser cannot send the cookie with a forged POST, so POST plus HttpOnly prevents CSRF.'},
 {id:'indexes',question:'Why might adding an index speed up a lookup while making updates more expensive?',criteria:['Explain selective access and index maintenance.'],good:'The index lets the database find relevant rows without reading every row, when the query and selectivity suit it. Changing rows also means maintaining the index, so storage and write work increase. The planner may still choose a scan.',bad:'An index removes the cost of searching on writes, so it always speeds every read and every write.'},
 {id:'types',question:'Why is asserting JSON as a TypeScript type insufficient to validate an API response?',criteria:['Explain erased static types and runtime input validation.'],good:'That assertion changes what the checker believes, not the payload. The emitted JS does not run that type check, so malformed JSON can still arrive. A runtime validator must check the actual fields before the application relies on them.',bad:'The TypeScript assertion checks each property in the received JSON at runtime and rejects malformed values.'},
 {id:'caching',question:'Compare no-cache and no-store, and explain how an ETag helps reuse a response.',criteria:['Explain storage versus revalidation and conditional requests.'],good:'no-cache allows a stored response but requires validation before reuse, while no-store says not to store it. Sending If-None-Match with an ETag lets the server return 304 if unchanged, so the cached representation can be reused.',bad:'no-cache means nothing is stored, while no-store saves the response and revalidates its ETag.'},
 {id:'promises',question:'If Promise.all rejects, do the other started requests stop or lose their effects?',criteria:['Distinguish aggregate rejection from cancellation and rollback.'],good:'The combined promise rejects when an input rejects, but that is only the aggregate result. Requests already started can keep running and finish their effects; cancellation has to be separately supported and cannot undo an already completed effect.',bad:'Promise.all rolls back completed calls and automatically cancels every other request on rejection.'},
 {id:'isolation',question:'Does wrapping check-then-insert in a transaction guarantee two concurrent requests cannot both act? Explain.',criteria:['Distinguish atomicity from isolation and concurrency enforcement.'],good:'Atomicity only groups each transaction’s participating writes. Two requests can both observe absence depending on isolation. A uniqueness constraint, appropriate locking or suitable isolation must arbitrate the conflict, and failures may need whole-transaction retry.',bad:'Atomicity makes every transaction run serially, so a transaction alone removes the race.'},
 {id:'authorization',question:'Why must the server authorize a resource operation when the client hides its button?',criteria:['Explain bypassing client controls, action/resource permissions and authentication.'],good:'The client UI is optional: a caller can send the HTTP request directly or change the resource ID. The server must check that this identity may perform that action on that resource. Login identifies someone; it does not grant ownership of every resource.',bad:'Hiding the button and enabling CORS ensures authenticated users can access only resources they own.'},
 {id:'interruption',question:'What does cancelling a parent process prove about descendants and previously committed database writes?',criteria:['Distinguish cancellation from verified termination and rollback.'],good:'Cancellation requests a stop only through mechanisms that honor it. It does not prove every descendant exited; check the containment boundary and observe exit. Already committed writes remain because cancelling the process is not rolling back a committed transaction.',bad:'An abort signal rolls back committed rows and guarantees all child processes exited.'},
 {id:'sql',question:'How do parameters prevent SQL injection, and can a parameter safely choose a table name?',criteria:['Separate SQL code from data and explain identifier limits.'],good:'Bound values remain data instead of being parsed as SQL syntax. Table names are SQL structure, so normal value placeholders cannot choose them. Map permitted names to fixed SQL identifiers rather than interpolating arbitrary input.',bad:'Parameters are escaped string concatenation and can replace any SQL syntax including table names.'},
 {id:'backoff',question:'Why add backoff and jitter to retries, and does that make side effects happen exactly once?',criteria:['Explain retry load and the separate idempotency requirement.'],good:'Backoff spaces attempts and jitter spreads clients that would otherwise retry together, reducing bursts. Neither knows whether a timed-out call already succeeded, so retries still need idempotency or reconciliation for side effects.',bad:'Jitter guarantees every retry reaches the server exactly once and removes the need for idempotency.'},
 {id:'uncovered',question:'How do virtual nodes change the balance of a consistent hashing ring?',criteria:['Explain partition distribution and limits.'],good:'Placing several virtual nodes per physical server spreads ownership around the ring so random gaps average out, but hot keys can still skew load.',bad:'Virtual nodes guarantee identical load for every key distribution.'},
];
const output=process.argv[2];if(!output)throw Error('Supply an output JSON path.');
const only=new RegExp(process.argv.find(a=>a.startsWith('--only='))?.slice(7)??'.');
const interval=Number(process.argv.find(a=>a.startsWith('--interval='))?.slice(11)??65_000);
const records:any[]=existsSync(output)?JSON.parse(readFileSync(output,'utf8')).records:[];
const flowFinals:any=existsSync(output)?JSON.parse(readFileSync(output,'utf8')).flowFinals??{}:{};
const save=()=>writeFileSync(output,JSON.stringify({provenance:'Fixed-matrix actual Groq evaluation with synthetic context; each record preserves its implementation digest and actual model IDs. carriedFrom marks earlier unaffected cases, reprocessed marks deterministic replay, and superseded retains failed pre-fix observations. Flow cases use connector, cloud HTTP routing and on-disk SQLite; no browser/coding agent/hosted backend. flowFinals reopens the actual local database after replaying saved steps and any new calls.',records,flowFinals},null,2));
const native=globalThis.fetch;let traces:any[]=[],last=0;
const cloud=createHttpApp({deviceForToken:async()=>({id:'synthetic',userId:'synthetic'})} as any);
globalThis.fetch=async(url,init)=>{
 if(String(url).includes('/v1/learning'))return cloud.request('/v1/learning',init as any);
 const req=JSON.parse(String(init?.body));const started=Date.now();
 try{
  const r=await native(url,init);const body=await r.clone().json().catch(()=>null);let result;
  try{result=JSON.parse(body?.choices?.[0]?.message?.content);}catch{}
  traces.push({model:req.model,status:r.status,result,usage:body?.usage,ms:Date.now()-started,limits:Object.fromEntries([...r.headers].filter(([name])=>name.startsWith('x-ratelimit-')||name==='retry-after')),
   error:!r.ok?String(body?.error?.message??'').replaceAll(process.env.GROQ_API_KEY||'__absent__','[redacted]').replace(/org_[a-z0-9]+/g,'[organization]').slice(0,800):undefined});return r;
 }catch(error){traces.push({model:req.model,error:'Network/deadline failure',ms:Date.now()-started});throw error;}
};
async function run(label:string,expected:string,request:any,operation?:()=>Promise<any>){
 if(!only.test(label))return undefined;
 const prior=records.find(r=>r.label===label);if(prior)return prior;
 if(digest()!==codeDigest)throw Error('Implementation changed during the cohort; start a new output cohort.');
 const spacing=label.startsWith('flow-')?Math.max(interval,65_000):interval;
 if(last)for(let remaining=spacing-(Date.now()-last);remaining>0;remaining=spacing-(Date.now()-last))await new Promise(r=>setTimeout(r,Math.min(remaining,30_000)));
 if(digest()!==codeDigest)throw Error('Implementation changed during pacing; no request sent. Resume in a new process.');
 last=Date.now();traces=[];
 const result=operation?await operation():await completeLearning(request);
 const row={label,expected,codeDigest,digestFiles:paths,request,result,traces,at:new Date().toISOString()};records.push(row);
 save();
 console.log(label,JSON.stringify(result.ok===undefined?{phase:result.view?.phase,mastery:result.mastery,turn:result.view?.turns?.at(-1)}:result.ok?{intent:result.json.intent,assessment:result.json.assessment?.status,outcome:result.json.assessment?.outcome,text:result.json.text?.slice(0,140)}:result),traces.map(t=>t.status??t.error).join(','));
 if(traces.some(t=>t.status===429)){console.log('Quota limit retained; stopped without replacing the observation.');process.exit(0);}return row;
}
// Independent questions have empty history to prevent contamination by an earlier answer.
for(const t of topics.filter(t=>!['outbox','cookies'].includes(t.id))){
 for(const kind of ['good','bad'] as const)await run(`${t.id}:${kind}`,t.id==='uncovered'?'provisional; no mastery':kind==='good'?'understood':'incorrect; no mastery',{
  action:'tutor',evidence:{facts:[],agentStated:[]},current:{id:t.id,concept:t.id,prompt:t.question,criteria:t.criteria,grounding:'inference'},phase:'asking',coaching:{attempts:0},history:[],message:t[kind]});
}
for(const [id,kind,message] of [
 ['indexes','partial','An index can narrow the rows searched when it matches the lookup.'],
 ['caching','partial','no-cache allows a saved response but requires validation before reuse.'],
 ['types','ambiguous','It checks the response, or maybe just tells the compiler. I am not sure which.'],
 ['authorization','ambiguous','The checks are done there before it runs, if that is what you mean.'],
 ['promises','paraphrase','The group reports failure, but its siblings do not receive a stop order from that report. A request already in flight can finish changing the remote system; stopping or compensating it takes another mechanism.'],
 ['isolation','paraphrase','Bundling my writes does not put other callers in a single-file queue. Both can read an empty slot before either claims it. A uniqueness rule or suitable locking/isolation has to settle the collision; serialization failure means rerunning the whole unit of work.'],
] as const){const t=topics.find(t=>t.id===id)!;await run(`${id}:${kind}`,kind==='paraphrase'?'understood':`${kind}; no mastery`,{action:'tutor',evidence:{facts:[],agentStated:[]},current:{id,concept:id,prompt:t.question,criteria:t.criteria,grounding:'inference'},phase:'asking',coaching:{attempts:0},history:[],message});}

// Complete flows are deliberately stateful: wrong twice -> help -> explanation ->
// follow-up -> corrected answer -> reassessment -> follow-up -> next answer.
for(const id of ['outbox','cookies']){
 if(!only.test(`flow-${id}:`))continue;
 const t=topics.find(t=>t.id===id)!;
 const dir=mkdtempSync(join(tmpdir(),'prentice-systematic-'));const dbPath=join(dir,'flow.sqlite');
 let db=openDatabase(dbPath);migrate(db);let store=new Store(db);
 const project=store.upsertProject(dir,'Synthetic evaluation');const task=store.insertTask(project.id,'PRIVATE ORIGINAL REQUEST MUST NOT BE SENT');store.updateTask(task.id,{status:'completed',provider_id:'fixture'});
 const packet:any={taskId:task.id,prompt:task.prompt,projectName:'Synthetic',files:[],symbols:[],activity:[],tests:null,unparsedLanguages:[],unparsedFiles:[]};store.savePacket(task.id,packet);
 const lesson:any={title:id,explanation:'General technical concept, no verified project implementation.',mechanism:'Reason from the question assumptions.',tradeoff:'State the applicable limits.',transfer:'Apply to a changed assumption.',question:t.question,expectedPoints:t.criteria,grounding:'inference',basis:[]};
 const next=topics.find(t=>t.id==='types')!;const nextLesson={...lesson,title:'TypeScript runtime validation',question:next.question,expectedPoints:next.criteria};
 store.saveUnderstand(task.id,{...assembleUnderstand(packet),learning:{available:true,message:'Synthetic',explanation:'General concepts',concepts:[lesson,nextLesson]}});
 store.saveExplain(task.id,startExplainSession(packet,'moderate',[],[lesson,nextLesson]));
 setLearningEndpoint({cloudUrl:'http://127.0.0.1:4740',token:'synthetic'});
 const steps=[
  ['wrong-1',t.bad,'incorrect; no mastery'],
  ['wrong-2',id==='outbox'?'The receiver forgets K when the sender is interrupted, so retries apply the database change again.':'A POST endpoint using HttpOnly cookies is immune to CSRF because scripts cannot read that cookie.','incorrect; coaching; no mastery'],
  ['hint','I need another hint, something concrete that helps me reason about my mistake.','useful contextual hint; same question; no attempt'],
  ['example','Please explain it with a concrete example. Keep the actors, event order and assumptions consistent.','technically sound example; same question; no attempt'],
  ['followup',id==='outbox'?'Keep the receiver record already committed: if only the sender crashes, does the key disappear? And can a separate payment API be included in that local commit?':'Keep SameSite=Strict fixed. Does a cross-site top-level GET send it? Would explicit Lax change that? Does the available evidence prove our project uses either?','direct consistent answer; no invented project guarantee'],
  ['correction',`I was wrong earlier. ${t.good}`,'understood; mastery; advance'],
  ['review','Please review my first answer.','incorrect original answer; preserve later independent proof'],
  ['after-review',id==='outbox'?'Can you clarify the sender uncertainty versus the durable state at the receiver?':'Could XSS still perform actions even when JavaScript cannot read the HttpOnly cookie?','contextual follow-up; preserve mastery and current question'],
  ['next-answer',next.good,'understood; finish; retain both concepts'],
 ] as const;
 let lastView:any;
 for(const [stage,message,expected] of steps){
  const label=`flow-${id}:${stage}`;
  // On resume, replay the recorded cloud response, never silently re-call the model.
  const prior=records.find(r=>r.label===label);const savedFetch=globalThis.fetch;
  if(prior)globalThis.fetch=async(url,init)=>String(url).includes('/v1/learning')?Response.json({result:prior.reprocessed?.cloudReply??prior.result.cloudReply}):savedFetch(url,init);
  let cloudReply:any;const flowFetch=globalThis.fetch;
  globalThis.fetch=async(url,init)=>{const r=await flowFetch(url,init);if(String(url).includes('/v1/learning'))cloudReply=(await r.clone().json()).result;return r;};
  const op=async()=>{const view=await answerExplain(store,task.id,message,label);lastView=view;return {view,mastery:store.demonstratedConcepts(project.id),local:store.getExplain(task.id),cloudReply};};
  if(prior)await op();else await run(label,expected,{message,phase:store.getExplain(task.id)?.phase,current:store.getExplain(task.id)?.current},op);
  globalThis.fetch=savedFetch;
  if(stage==='correction'){db=openDatabase(dbPath);store=new Store(db);}
 }
 const reopened=new Store(openDatabase(dbPath)),state=reopened.getExplain(task.id)!;
 flowFinals[id]={codeDigest,verifiedAt:new Date().toISOString(),provenance:'SQLite reopen after saved-step replay and any new live calls; not a second set of model evaluations.',phase:state.phase,mastery:reopened.demonstratedConcepts(project.id),messages:state.turns?.map(t=>({id:t.id,status:t.status,hasMessage:Boolean(t.message),hasResponse:Boolean(t.response)})),publicProofExposed:/"(?:proof|evaluatedAnswer)"\s*:/.test(JSON.stringify(lastView)),privateProofStored:state.turns?.some(t=>t.assessment?.status==='assessed'&&t.assessment.method==='source-review'&&Boolean(t.assessment.proof))};save();
 setLearningEndpoint(null);
}
console.log(`Saved ${records.length} observations to ${output}`);
