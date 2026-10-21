import type { PracticeAssessment } from './types.js';

/** Teaching and assessment are independently versioned. Changing a question/rubric
 * requires re-evaluating its bounded assessor; a source link alone never enables it. */
export const ASSESSABLE_TEACHING_REVISION = '2026-10-12.5';
export const ASSESSMENT_REVISION = '2026-10-13.1';
type Rule = { pattern: RegExp; facts?: string[]; contradicts?: string[] };
type Spec = { id: string; question: string; criteria: string[]; sources: string[]; required: string[]; rules: Rule[] };
const right = (facts: string[], pattern: RegExp): Rule => ({ facts, pattern });
const wrong = (contradicts: string[], pattern: RegExp): Rule => ({ contradicts, pattern });
/** Full-statement grammars, not keyword scores. Unrecognized clauses fail open to
 * practice but closed to assessment. These deliberately accept a narrow language. */
export const ASSESSMENT_SPECS: Spec[] = [
 {id:'outbox.order',sources:["https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html"],question:'Why commit the business change and outbox intent together before sending, and what still permits duplicate effects?',criteria:['Business data and intent commit together before relay sending','A relay retry can duplicate delivery','The receiver must enforce deduplication with its effect'],required:['atomic','order','retry','receiver'],rules:[
  right(['atomic'],/^committing (?:the )?business (?:change|state|row) and (?:the )?outbox intent together means (?:a )?rollback leaves neither committed$/),
  right(['order'],/^(?:the )?relay sends (?:the message )?only after (?:the local )?commit$/),
  right(['retry'],/^if (?:the )?response is lost,? (?:the )?relay can send (?:the )?message again$/),
  right(['receiver'],/^(?:the )?receiver must enforce (?:a )?unique stable key and atomically record it with its own database effect to prevent (?:a )?duplicate effect$/),
  wrong(['order'],/^(?:the )?relay (?:must )?send(?:s)? (?:the message )?before (?:the local )?commit$/),
  wrong(['receiver'],/^(?:an? |the )?outbox (?:alone )?guarantees exactly[- ]once (?:delivery|external effects)$/),
 ]},
 {id:'outbox.retry',sources:["https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html"],question:'If a receiver commits an effect with its key but the response is lost, what happens on retry, and what must stay true?',criteria:['The sender is uncertain after losing a response','A stable key and receiver enforcement suppress duplicate effects','A sender crash does not erase the receiver record'],required:['uncertain','receiver','survives'],rules:[
  right(['uncertain'],/^(?:the )?sender (?:cannot know whether|does not know if) (?:the )?receiver succeeded because (?:the )?response was lost$/),
  right(['receiver'],/^enforcing (?:a )?unique stable key and recording it atomically with (?:the )?database effect at (?:the )?receiver prevents another effect when (?:the )?sender retries that key$/),
  right(['survives'],/^(?:the )?receiver'?s? durable key (?:survives|remains) because only (?:the )?sender crashed$/),
  wrong(['survives'],/^(?:a |the )?sender crash (?:erases|deletes) (?:the )?receiver'?s? (?:durable )?key$/),
  wrong(['uncertain'],/^(?:a )?lost response (?:means|proves) (?:the )?receiver failed$/),
  wrong(['receiver'],/^(?:a )?stable key (?:alone )?prevents duplicate effects without receiver enforcement$/),
 ]},
 {id:'cookie.httponly',sources:["https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie"],question:'Why can an XSS script still perform actions even when a session cookie is HttpOnly?',criteria:['HttpOnly blocks script cookie reads','Eligible requests can still carry the cookie','HttpOnly does not eliminate XSS actions or CSRF'],required:['reads','requests','limits'],rules:[
  right(['reads'],/^httponly (?:stops|prevents) javascript from reading (?:the )?cookie$/),
  right(['requests'],/^(?:an )?injected same[- ]origin script can still send authenticated requests because (?:the )?browser attaches (?:the )?cookie$/),
  right(['limits'],/^(?:so )?httponly does not prevent all xss actions or csrf$/),
  wrong(['requests','limits'],/^httponly prevents csrf because (?:the )?browser will not send (?:the )?cookie$/),
  wrong(['limits'],/^httponly (?:prevents|stops) all xss actions$/),
  wrong(['reads'],/^httponly allows javascript to read (?:the )?cookie$/),
 ]},
 {id:'cookie.csrf',sources:["https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie", "https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html"],question:'Why are HttpOnly and POST-only endpoints insufficient as a complete CSRF defense?',criteria:['Ambient credentials can accompany unwanted requests','POST alone does not verify intent','Appropriate server-side token or origin defenses are needed'],required:['ambient','reads','post','defense'],rules:[
  right(['ambient','reads'],/^httponly hides (?:the )?cookie value from javascript,? but (?:the )?browser can still send (?:the )?cookie on an unwanted request$/),
  right(['post'],/^(?:an )?attacker can submit a post form too,? so post alone does not prove user intent$/),
  right(['defense'],/^(?:the )?server must validate (?:a )?csrf token or (?:a )?trusted request origin to reject (?:the )?unwanted request$/),
  wrong(['post','defense'],/^requiring post alone prevents csrf$/),
  wrong(['ambient','reads'],/^httponly prevents csrf because (?:the )?browser will not send (?:the )?cookie$/),
 ]},
 {id:'process.effects',sources:["https://nodejs.org/api/child_process.html#subprocesskillsignal", "https://www.postgresql.org/docs/current/tutorial-transactions.html"],question:'What happens to committed writes and an uncertain remote operation when a process is cancelled?',criteria:['Cancellation cannot undo committed writes','A missing response does not establish remote failure','Descendant termination must be verified separately'],required:['committed','remote','exit'],rules:[
  right(['committed'],/^(?:the )?committed writes remain because cancellation does not roll back committed transactions$/),
  right(['remote'],/^(?:the )?remote operation may have succeeded even if its response was lost$/),
  right(['exit'],/^(?:we |the server )?must verify descendant exit separately because aborting (?:the )?parent does not prove its children stopped$/),
  wrong(['committed'],/^cancellation (?:undoes|rolls back) (?:already )?committed writes$/),
  wrong(['remote'],/^(?:a )?missing response proves (?:the )?remote operation failed$/),
  wrong(['exit'],/^aborting (?:the )?parent guarantees all descendants (?:stopped|exited)$/),
 ]},
 {id:'authorization.server',sources:["https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html"],question:'Why must a server check permissions even if a protected button is hidden in the client?',criteria:['Clients can construct requests outside the UI','The server must authorize the action and resource','Authentication alone does not establish permission'],required:['bypass','check','identity'],rules:[
  right(['bypass'],/^(?:a )?client can (?:construct|send) (?:the )?(?:http |api )?request directly,? so hiding (?:the )?button does not prevent (?:the )?request$/),
  right(['check'],/^(?:the )?server must check (?:the )?caller'?s? permission for both (?:the )?action and (?:the )?resource$/),
  right(['identity'],/^authentication identifies (?:the )?caller,? but does not prove permission (?:for|to access) (?:the |that )?resource$/),
  wrong(['bypass','check'],/^hiding (?:the )?button is enough to authorize (?:the )?request$/),
  wrong(['identity'],/^being authenticated proves ownership of every resource$/),
  wrong(['check'],/^cors replaces server authorization$/),
 ]},
];
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
export function assessmentSpec(question: unknown): Spec | null {
 const q=object(question), support=object(q.support);
 if(q.grounding!=='inference'||support.kind!=='source-backed'||support.scope!=='general'||support.revision!==ASSESSABLE_TEACHING_REVISION||!Array.isArray(support.unitIds)||support.unitIds.length!==1)return null;
 const unitId=support.unitIds[0];
 const spec=ASSESSMENT_SPECS.find(s=>s.id===unitId);
 const criteria=q.expectedPoints??q.criteria;
 const refs=Array.isArray(support.sources)?support.sources.map(s=>object(s).url):[];
 return spec&&spec.sources.every(url=>refs.includes(url))&&q.prompt===spec.question&&Array.isArray(criteria)&&criteria.length===spec.criteria.length&&criteria.every((p,i)=>p===spec.criteria[i])?spec:null;
}
function provisional(reason: string): PracticeAssessment { return {status:'provisional',tentative:'uncertain',reason}; }
/** Only exact, fully covered causal statements can reach a conclusive result.
 * The grammar cannot certify arbitrary prose, project behavior, or general mastery. */
export function assessSupportedAnswer(question: unknown, answer: string): PracticeAssessment {
 const spec=assessmentSpec(question);
 if(!spec)return provisional('This question does not have a current, tested assessment specification.');
 if(!answer.trim()||answer.length>8000||/[?"“”`]/.test(answer))return provisional('The answer is ambiguous, quoted, or outside the bounded assessment scope.');
 const statements=answer.split(/[.;\n]+/).map(s=>s.trim()).filter(Boolean);
 if(!statements.length||statements.length>12)return provisional('The explanation is outside the bounded assessment scope.');
 const facts=new Set<string>(), contradictions=new Set<string>();
 const evidence:Array<{quote:string;criteria:string[]}>=[];
 for(const statement of statements){
  const normalized=statement.toLowerCase().replace(/[’‘]/g,"'").replace(/\s+/g,' ');
  const matches=spec.rules.filter(r=>r.pattern.test(normalized));
  if(matches.length!==1)return provisional('Some reasoning could not be assessed reliably. Clarify the mechanism and assumptions.');
  const rule=matches[0];for(const f of rule.facts??[])facts.add(f);for(const f of rule.contradicts??[])contradictions.add(f);
  evidence.push({quote:statement,criteria:rule.facts??rule.contradicts??[]});
 }
 if([...contradictions].some(f=>facts.has(f)))return provisional('The explanation contains conflicting claims; clarify which one you mean.');
 const outcome=contradictions.size?'incorrect':spec.required.every(f=>facts.has(f))?'understood':null;
 if(!outcome)return provisional('The explanation has not yet established all of this question’s criteria.');
 return {status:'assessed',method:'bounded-rules',revision:ASSESSMENT_REVISION,unitId:spec.id,outcome,evidence,reason:'The complete explanation matched tested source-backed criteria for this question.'};
}
/** Review the actual saved answer. A clarification may complete partial reasoning,
 * but cannot alone justify retracting a previous judgment. */
export function assessSupportedReview(question: unknown, original: string, message: string): PracticeAssessment {
 const base=assessSupportedAnswer(question,original);
 const bare=/^(?:please (?:re[- ]?evaluate|reassess|review) (?:my |the )?(?:(?:first|earlier|previous|initial) )?(?:answer|explanation)|my (?:(?:first|earlier|previous|initial) )?answer was (?:actually )?(?:right|correct)|was (?:my |that )?answer (?:right|correct))[.!?]*$/i.test(message.trim());
 if(bare)return base;
 const clarification=message.replace(/^(?:to clarify|i meant)[:,]?\s*/i,'');
 const combined=assessSupportedAnswer(question,`${original}. ${clarification}`);
 if(combined.status==='assessed'&&combined.outcome==='understood')return combined;
 if(base.status==='assessed'&&base.outcome==='incorrect'&&combined.status==='assessed'&&combined.outcome==='incorrect')return base;
 return provisional('This review is inconclusive; existing demonstrated understanding is preserved.');
}
