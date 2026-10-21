/** Opt-in actual-model quality observations, NOT deterministic pass/fail tests.
 * Run: node --env-file=.env --import tsx scripts/evaluate-teaching.mts /tmp/teaching-evaluation.json
 * --resume preserves successful observations; --pace spaces pending scenarios by 65s.
 * --no-rate-retry records a rate failure once instead of retrying the whole exchange.
 * Uses synthetic bounded context only. Never writes credentials or request headers.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { completeLearning } from '../apps/cloud/src/learning.ts';
import { readGroqConfig } from '../apps/cloud/src/groq.ts';
const output=process.argv[2]; if(!output) throw Error('Provide a local output JSON path.');
const config=readGroqConfig();if(!config.ok) throw Error('Configured Learning AI unavailable.');
const nativeFetch=globalThis.fetch;
let traces:unknown[]=[];
const replayArg=process.argv.find(arg=>arg.startsWith('--replay='));
let injectedDraft:unknown=null;
globalThis.fetch=async(input,init)=>{
 const request=JSON.parse(String(init?.body));
 const isReview=request.messages[0].content.startsWith("You are Prentice's technical teaching reviewer.");
 const payload=JSON.parse(request.messages[1].content);
 const inject=injectedDraft!==null&&!isReview&&!payload.revision;
 const response=inject?Response.json({choices:[{message:{content:JSON.stringify(injectedDraft)}}]}):await nativeFetch(input,init);
 const rawResponse=await response.clone().text();
 const result=(()=>{try{return JSON.parse(rawResponse);}catch{return null;}})();
 const content=result?.choices?.[0]?.message?.content;
 traces.push({stage:inject?'injected-prior-draft':isReview?'review':payload.revision?'repair':'draft',status:response.status,result:content?JSON.parse(content):null,usage:result?.usage,providerErrorCode:result?.error?.code,providerErrorType:result?.error?.type,providerErrorBody:!response.ok?rawResponse.replaceAll(config.config.apiKey,'[redacted]').replace(/org_[a-z0-9]+/g,'[organization]').slice(0,2400):undefined,providerErrorMessage:typeof result?.error?.message==='string'?result.error.message.replaceAll(config.config.apiKey,'[redacted]').replace(/org_[a-z0-9]+/g,'[organization]').slice(0,1600):undefined,limitType:result?.error?.message?.match(/(?:tokens|requests) per (?:minute|day)/i)?.[0],retryAfter:response.headers.get('retry-after')});
 return response;
};
const topics=[
 {name:'outbox',question:'Why can a transactional outbox still deliver duplicate messages, and what must the receiver do?',criteria:['local business state and intent commit before relay sends','retry may duplicate delivery; receiver coordinates durable deduplication with its effect'],teaching:'General concept: local business data and intent are committed together, then a relay sends. Receiver idempotency is separate.',answer:'The sender commits business state and send intent together before delivery. It may deliver twice if acknowledgement is lost. The receiver must durably deduplicate the same operation with its effect.',followup:'In your example the receiver already recorded the key with its effect. If the sender crashes before its acknowledgement record, does that erase the receiver key and cause another charge?'},
 {name:'authentication',question:'How does a cookie session persist, and what do HttpOnly and SameSite protect?',criteria:['matching cookie automatically accompanies later requests; server validates session','HttpOnly restricts script reads; SameSite limits cross-site sending, and CSRF needs appropriate server defenses'],teaching:'General cookie-session concept; the actual repository storage method and cookie flags are not established by the available evidence.',answer:'The browser sends a matching session cookie later and the server checks the session. HttpOnly blocks script reads but not CSRF or all XSS actions. SameSite limits cross-site sending; appropriate CSRF defenses still matter.',followup:'So is our implementation definitely protected from CSRF because auth.ts exists? If an XSS script cannot read an HttpOnly cookie, can it still send actions as the user?'},
 {name:'transactions',question:'What does a database transaction make atomic, and what happens to an external email on rollback?',criteria:['participating database writes commit or roll back together','arbitrary external effects are outside a local transaction'],teaching:'General database transactions cover participating database changes, not uncoordinated remote effects.',answer:'The participating database writes commit together or roll back. An email already sent is outside that local transaction, so rollback does not unsend it. Concurrent correctness also depends on isolation and constraints.',followup:'If the email API succeeded but its response was lost and the transaction rolled back, is it safe to retry blindly? Does atomicity imply serializable isolation?'},
 {name:'interruption',question:'What can cancelling a process guarantee about its descendants and committed writes?',criteria:['signal/abort requests do not prove every descendant exited','already committed or remote effects are not undone'],teaching:'General process cancellation is a request; containment and exit verification depend on mechanism and platform. Recorded code-call presence alone proves neither.',answer:'Sending an abort or signal requests cancellation. It does not prove descendants exited; containment and exit checks depend on the mechanism. Already committed writes and external effects are not undone.',followup:'Does seeing AbortController.abort() in the repository prove all grandchildren stopped on every platform? Is hiding the Stop control sufficient to enforce server permission?'},
];
const maxAttempts=process.argv.includes('--no-rate-retry')?1:4;
let lastAttemptAt=process.argv.includes('--pace')?Date.now():0;
const records:any[]=process.argv.includes('--resume')?JSON.parse(readFileSync(output,'utf8')).records:[];
const persist=()=>writeFileSync(output,JSON.stringify({model:config.config.model,provenance:'Actual Groq calls with synthetic bounded technical lessons. Verdicts are same-model reviews, not independent factual proof. Inspect complete exchanges manually against cited reference principles.',records},null,2)+'\n');
async function run(body:Record<string,unknown>,label:string){
 const saved=records.findLast(r=>r.label===label&&r.result.ok&&!r.invalidatedByManualReview);if(saved){console.log(label,'restored prior successful observation');return saved.result;}
 for(let attempt=0;attempt<maxAttempts;attempt++){
  if(process.argv.includes('--pace')&&lastAttemptAt){const delay=65_000-(Date.now()-lastAttemptAt);if(delay>0){console.log('Pacing pending scenario for provider capacity');await new Promise(r=>setTimeout(r,delay));}}
  lastAttemptAt=Date.now();
  traces=[];const started=Date.now();const result=await completeLearning(body);
  const record={label,request:body,result,elapsedMs:Date.now()-started,traces};records.push(record);persist();
  console.log(label,result.ok?'released':'withheld',`${traces.length} calls`,`${record.elapsedMs}ms`);
  if(!result.ok&&traces.some((t:any)=>t.limitType?.includes('per day'))) throw Error('Daily provider quota exhausted; remaining live scenarios were not evaluated. Captured results are saved.');
  if(!result.ok&&traces.some((t:any)=>t.status===429)&&attempt<maxAttempts-1){console.log('Waiting for provider capacity');await new Promise(r=>setTimeout(r,55000));continue;}
  return result;
 }
 throw Error('No result');
}
if(!replayArg) for(const topic of topics){
 const history:unknown[]=[];
 const current={id:topic.name,concept:topic.name,prompt:topic.question,criteria:topic.criteria,teaching:topic.teaching,grounding:'inference'};
 const evidence={facts:[{id:'f',text:`Added ${topic.name==='authentication'?'auth.ts':'worker.ts'} (+20 / -0).`}],observed:{symbols:[],commands:[],tests:null},agentStated:[{id:'a',label:'Agent stated',text:`The agent reports working on ${topic.name}. Runtime guarantees were not recorded.`}]};
 for(const [stage,message] of [['answer',topic.answer],['hint','Can you give me a useful hint about the main failure case?'],['explain','Please explain this concept directly and correct any earlier false premise.'],['example','Give a worked example. Keep component state, event order, and the crash case explicit.'],['followup',topic.followup]]){
  const result=await run({action:'tutor',evidence,current,topics:[current],phase:stage==='answer'||stage==='hint'?'asking':'taught',history:history.slice(-6),message},`${topic.name}:${stage}`);
  if(result.ok){const reply=result.json as any;history.push({message,reply:reply.text?.slice(0,1200),...(reply.text?.length>1200?{replyTruncated:true}:{}),hint:reply.hint?.slice(0,1500),assessed:reply.intent==='answer',understood:reply.understood});}
 }
}
// The exact prior contradictory worked example becomes untrusted prior teaching.
const previous=JSON.parse(readFileSync(new URL('../apps/cloud/src/__fixtures__/outbox-prior-explanation.json',import.meta.url),'utf8'));
if(!replayArg) await run({action:'tutor',evidence:{facts:[],agentStated:[]},current:{prompt:topics[0].question,concept:'outbox',criteria:topics[0].criteria,teaching:topics[0].teaching},phase:'taught',history:[{message:'Give a worked example.',reply:previous}],message:'Your example first says the API recorded the key atomically with the charge, then says a sender crash means the API has no key. Which is correct? Please correct the explanation and order.'},'prior-real-contradiction:correction');
if(replayArg){
 const regressions=JSON.parse(readFileSync(replayArg.slice('--replay='.length),'utf8'));
 for(const regression of regressions){injectedDraft=regression.candidate;await run(regression.request,`replay:${regression.label}`);}
 injectedDraft=null;
}
await run({action:'explain',evidence:{scope:{complexity:'high',maxConcepts:1,categories:['architecture']},facts:[{id:'f',text:'Added worker.ts (+20 / -0).'}],agentStated:[{id:'a',label:'Agent stated',text:'The agent reports committing business data and an outbox intent in one local transaction, then a separate relay sends and records delivery status. No receiver-side idempotency verification was recorded.'}],outcome:'completed',attribution:'available'}},'initial-lesson:outbox');
globalThis.fetch=nativeFetch;
console.log('Saved live observations:',output);
