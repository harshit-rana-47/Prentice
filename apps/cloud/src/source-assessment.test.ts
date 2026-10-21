// Legacy-path regressions; semantic-tutor tests exercise the default independent-review path.
process.env.GROQ_REVIEW_MODEL="disabled";
import {afterEach,expect,it,vi} from 'vitest';
import {ASSESSMENT_SPECS,ASSESSABLE_TEACHING_REVISION} from '@prentice/domain';
import {completeLearning} from './learning.js';
const native=globalThis.fetch,key=process.env.GROQ_API_KEY;
afterEach(()=>{globalThis.fetch=native;if(key===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=key;});
const good="The sender does not know if the receiver succeeded because the response was lost. Enforcing a unique stable key and recording it atomically with the database effect at the receiver prevents another effect when the sender retries that key. The receiver's durable key remains because only the sender crashed.";
function question(){const s=ASSESSMENT_SPECS.find(s=>s.id==='outbox.retry')!;return {prompt:s.question,criteria:s.criteria,grounding:'inference',support:{kind:'source-backed',scope:'general',revision:ASSESSABLE_TEACHING_REVISION,unitIds:[s.id],sources:s.sources.map(url=>({url}))}};}
function route(mode='feedback',reviewTurnId:string|null=null,verdict='consistent'){process.env.GROQ_API_KEY='synthetic';globalThis.fetch=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({mode,intent:mode==='review'?'review':'answer',units:['outbox.retry'],verdict,quote:'',reviewTurnId,questionId:null,text:''})}}]})) as typeof fetch;}
it('awards eligible understanding from the actual explanation, regardless of the model verdict',async()=>{
 route('feedback',null,'gap');const q=question();const result=await completeLearning({action:'tutor',evidence:{facts:[],agentStated:[]},current:q,message:good});
 expect(result).toMatchObject({ok:true,json:{understood:true,assessment:{status:'assessed',outcome:'understood',method:'bounded-rules'}}});
 expect((result as any).json.text).toContain('criteria for this question');expect((result as any).json.text).not.toContain('assessment remains provisional');
});
it('overrules a false positive and keeps ambiguous, incomplete and unsupported answers provisional',async()=>{
 for(const [message,status] of [["A sender crash erases the receiver's durable key.",'assessed'],['Maybe the receiver succeeded.','provisional'],[good+' Our implementation guarantees no duplicates.','provisional']] as const){
  route();const result=await completeLearning({action:'tutor',evidence:{facts:[],agentStated:[]},current:question(),message});
  expect(result).toMatchObject({ok:true,json:{understood:false,assessment:{status}}});
  if(status==='assessed')expect((result as any).json.assessment.outcome).toBe('incorrect');
 }
 route();expect(await completeLearning({action:'tutor',evidence:{facts:[],agentStated:[]},current:{...question(),criteria:['Mention a key']},message:good})).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
});
it('does not assess an incomplete review excerpt as if it were the full saved answer',async()=>{
 route('review','old');expect(await completeLearning({action:'tutor',evidence:{facts:[],agentStated:[]},current:question(),reviews:[{...question(),id:'old',answer:good,answerTruncated:true}],message:'My first answer was actually correct.'})).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
});

it('keeps a covered topic without a tested assessment spec provisional',async()=>{
 const {sourceLessonDraft}=await import('./source-teaching.js');
 const c=sourceLessonDraft({concepts:[{title:'SameSite Strict and Lax',question:'Compare SameSite modes',basisIds:['f']}]},{facts:[{id:'f'}]})!.json.concepts[0];
 process.env.GROQ_API_KEY='synthetic';globalThis.fetch=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({mode:'feedback',intent:'answer',units:['cookie.samesite'],verdict:'consistent',quote:'',reviewTurnId:null,questionId:null,text:''})}}]})) as typeof fetch;
 const result=await completeLearning({action:'tutor',evidence:{facts:[]},current:{prompt:c.question,criteria:c.expectedPoints,support:c.support,grounding:'inference'},message:'Strict excludes cross-site GET, while explicit Lax allows top-level safe-method navigation.'});
 expect(result).toMatchObject({ok:true,json:{understood:false,support:{kind:'source-backed'},assessment:{status:'provisional'}}});
});
