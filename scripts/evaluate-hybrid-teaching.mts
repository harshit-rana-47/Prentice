/** Opt-in actual-model observations. Synthetic bounded context only; never a correctness certificate.
 * node --env-file=.env --import tsx scripts/evaluate-hybrid-teaching.mts /tmp/hybrid-teaching.json
 * Resume preserves observations (including failures) rather than retrying until a pass.
 */
import {createHash} from 'node:crypto';
import {UNITS,SOURCE_REVISION} from '../apps/cloud/src/source-teaching.ts';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {completeLearning} from '../apps/cloud/src/learning.ts';
import {readGroqConfig} from '../apps/cloud/src/groq.ts';
const output=process.argv[2];if(!output)throw Error('Provide an output path.');
const cfg=readGroqConfig();if(!cfg.ok)throw Error('Learning provider unavailable.');
const fixtures=JSON.parse(readFileSync(new URL('../apps/cloud/src/__fixtures__/teaching-regressions.json',import.meta.url),'utf8'));
const topics=[
 {id:'outbox',question:fixtures[0].request.current.prompt,followup:'The receiver recorded M atomically with its effect. Does the sender crashing erase M and cause a second charge?',answer:'The sender commits the business row and intent first. It may send twice if the response is lost. Receiver enforcement with a stable key must prevent another effect.'},
 {id:'cookies',question:fixtures[1].request.current.prompt,followup:'Keep SameSite=Strict fixed: will a cross-site top-level GET send it? Are HttpOnly and POST-only endpoints enough to prevent CSRF?',answer:'HttpOnly stops cookie reads, not all XSS actions. Strict excludes cross-site GETs too. Appropriate server CSRF defenses are still needed.'},
 {id:'interruption',question:'Does AbortController cancellation prove all descendants stopped or undo committed writes?',followup:'What if a grandchild escapes the POSIX process group? Can a thread be substituted for that child process?',answer:'An abort requests cancellation only where wired. Descendants need mechanism-specific containment and exit checks. Committed writes stay committed.'},
 {id:'authorization',question:'Why do client controls not establish server authorization?',followup:'If CORS is restrictive and a Stop button is hidden, can a client still send the API request? Does authentication prove ownership of the job?',answer:'The caller can construct a request outside the UI. The server must authorize the action and job resource; being authenticated is not enough.'},
];
const onlyArg=process.argv.find(a=>a.startsWith('--only='));const only=onlyArg?new RegExp(onlyArg.slice(7)):null;
const records:any[]=existsSync(output)?JSON.parse(readFileSync(output,'utf8')).records:[];
let traces:any[]=[];const native=globalThis.fetch;let last=0;
globalThis.fetch=async(input,init)=>{
 const request=JSON.parse(String(init?.body));const r=await native(input,init);const raw=await r.clone().text();let data:any;try{data=JSON.parse(raw);}catch{}
 const content=data?.choices?.[0]?.message?.content;let value:any;try{value=JSON.parse(content);}catch{}
 traces.push({stage:request.messages[0].content.startsWith("You are Prentice's technical teaching reviewer.")?'review':JSON.parse(request.messages[1].content).revision?'repair':'generation',status:r.status,result:value,usage:data?.usage,error:!r.ok?raw.replaceAll(cfg.config.apiKey,'[redacted]').replace(/org_[a-z0-9]+/g,'[organization]').slice(0,1600):undefined});return r;
};
async function run(label:string,request:Record<string,unknown>){
 const prior=records.find(r=>r.label===label);if(prior){console.log(label,'retained');return prior.result;}
 if(only&&!only.test(label))return {ok:false,message:'Not selected'};
 if(last){const delay=40_000-(Date.now()-last);if(delay>0)await new Promise(r=>setTimeout(r,delay));}last=Date.now();traces=[];
 const result=await completeLearning(request);records.push({label,recordedAt:new Date().toISOString(),sourceRevision:SOURCE_REVISION,sourceDigest:createHash('sha256').update(JSON.stringify(UNITS)).digest('hex'),request,result,traces});
 writeFileSync(output,JSON.stringify({model:cfg.config.model,provenance:'Actual Groq generation/routing with synthetic bounded lessons. Source-backed text is deterministically rendered from maintained references; inspect response relevance and consistency manually. Provisional feedback is not verified understanding.',records},null,2));
 console.log(label,result.ok?'replied':'withheld',traces.map(t=>`${t.stage}:${t.status}`).join(','));
 if(traces.some(t=>/per day/i.test(t.error??'')))throw Error('Daily quota exhausted; remaining observations not run.');
 return result;
}
const histories=new Map<string,any[]>(topics.map(t=>[t.id,[]]));
// First check the two highest-priority failures, with the exact bad example as prior dialogue.
for(const [i,topic] of topics.slice(0,2).entries()){
 const history=[{message:'Give a worked example.',reply:fixtures[i].candidate.text,replyTruncated:false}];
 const result=await run(`${topic.id}:correct-prior-error`,{...fixtures[i].request,history,message:i===0?'Your example says the receiver recorded the key, then says a sender crash erases it. Correct that contradiction and the send order.':'Correct the cookie example. Keep Strict and Lax separate and explain whether POST-only or HttpOnly is sufficient CSRF protection.'});
 if(result.ok)histories.get(topic.id)!.push({message:'Correct the prior example.',reply:result.json.text?.slice(0,1200),replyTruncated:result.json.text?.length>1200,support:result.json.support});
}
for(const stage of ['example','followup','hint','another-hint','answer'] as const){
 if(stage==='hint') {
  await run('uncovered:explain',{action:'tutor',evidence:{facts:[],agentStated:[]},current:{concept:'Consistent hashing',prompt:'Why use virtual nodes?',criteria:['Reason about uneven key distribution.']},message:'Explain why virtual nodes help and give a small example.'});
  await run('uncovered:practice',{action:'tutor',evidence:{facts:[],agentStated:[]},current:{concept:'Consistent hashing',prompt:'Why use virtual nodes?',criteria:['Reason about uneven key distribution.']},message:'Virtual nodes spread each physical server around the ring, so the random gaps average out across servers and reduce load imbalance.'});
 }
 for(const topic of topics){
 const history=histories.get(topic.id)!;const message=stage==='example'?'Give a worked example with explicit assumptions and failure state.':stage==='followup'?topic.followup:stage==='hint'?'Give me a concrete hint.':stage==='another-hint'?'Another hint please, different from the last one.':topic.answer;
 const result=await run(`${topic.id}:${stage}`,{action:'tutor',evidence:{facts:[{id:'f',text:'Added worker.ts (+10 / -0).'}],agentStated:[]},current:{id:topic.id,concept:topic.id,prompt:topic.question,criteria:['Explain the mechanism and boundary, including failure cases.'],grounding:'inference'},phase:'asking',history:history.slice(-6),message});
 if(result.ok)history.push({message,reply:result.json.text?.slice(0,1200),replyTruncated:result.json.text?.length>1200,support:result.json.support,assessment:result.json.assessment});
}}

console.log('Saved observations:',output);globalThis.fetch=native;
