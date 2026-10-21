import {KNOWLEDGE, KNOWLEDGE_REVISION} from './knowledge.js';
import type {PracticeAssessment} from './types.js';
const record=(v:unknown):Record<string,any>=>v&&typeof v==='object'?v as Record<string,any>:{};
/** Bind the cloud review to the local question and complete evaluated answer, not
 * a matching quote or a positive boolean. No repository/task prompt is included. */
export async function assessmentBinding(question:unknown,answer:string){
 const q=record(question);
 const payload=JSON.stringify([KNOWLEDGE_REVISION,q.prompt,q.expectedPoints??q.criteria??[],answer]);
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload))),b=>b.toString(16).padStart(2,'0')).join('');
}
export async function validateSourceAssessment(value:unknown,question:unknown,answer:string):Promise<Extract<PracticeAssessment,{method:'source-review'}>|null>{
 const a=record(value),p=record(a.proof),q=record(question);
 if(q.grounding!=='inference'||typeof q.prompt!=='string'||!answer.trim()||answer.length>8000||a.status!=='assessed'||a.method!=='source-review'||a.revision!==KNOWLEDGE_REVISION||a.unitId!=='general-concept'||!['understood','partial','incorrect'].includes(a.outcome)||typeof a.reason!=='string'||!a.reason.trim()||a.reason.length>1200)return null;
 if(!Array.isArray(p.models)||p.models.length!==2||p.models.some((m:unknown)=>typeof m!=='string'||!m||m.length>100)||p.models[0]===p.models[1]||p.binding!==await assessmentBinding(q,answer)||!Array.isArray(p.criteria)||!p.criteria.length||p.criteria.length>6)return null;
 for(const c of p.criteria){
  const source=KNOWLEDGE.find(s=>s.id===c?.sourceId);
  if(!source||typeof c.criterion!=='string'||c.criterion.length<12||c.criterion.length>600||!['met','missing','contradicted'].includes(c.state)||typeof c.sourceQuote!=='string'||c.sourceQuote.length<20||!source.principle.includes(c.sourceQuote)||typeof c.quote!=='string'||c.quote.length>1200)return null;
  if(c.state==='missing'?c.quote!==''&& !answer.includes(c.quote):c.quote.trim().length<8||!answer.includes(c.quote))return null;
 }
 const states=p.criteria.map((c:any)=>c.state);
 if(a.outcome==='understood'&&states.some((s:string)=>s!=='met')||a.outcome==='partial'&&(!states.includes('met')||!states.includes('missing')||states.includes('contradicted'))||a.outcome==='incorrect'&&!states.includes('contradicted'))return null;
 // Evidence is reconstructed, not accepted from the remote certificate.
 return {...a,evidence:p.criteria.filter((c:any)=>c.quote).map((c:any)=>({quote:c.quote,criteria:[c.criterion]}))} as Extract<PracticeAssessment,{method:'source-review'}>;
}
