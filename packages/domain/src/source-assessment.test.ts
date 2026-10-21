import {expect,it} from 'vitest';
import {KNOWLEDGE,KNOWLEDGE_REVISION,knowledgeFor} from './knowledge.js';
import {assessmentBinding,validateSourceAssessment} from './source-assessment.js';
const q={prompt:'Why does a TypeScript assertion not validate an API response?',criteria:['Explain static checks versus runtime input'],grounding:'inference'};
const answer='The assertion disappears when JavaScript is emitted, so the incoming JSON still needs a runtime check.';
async function certificate(){return {status:'assessed',method:'source-review',revision:KNOWLEDGE_REVISION,unitId:'general-concept',outcome:'understood',reason:'Explains erasure and the remaining trust boundary.',proof:{binding:await assessmentBinding(q,answer),models:['openai/gpt-oss-120b','qwen/qwen3.8-27b'],criteria:[{criterion:'Explains the erased annotation and remaining runtime boundary',state:'met',quote:answer,sourceId:'types',sourceQuote:KNOWLEDGE.find(r=>r.id==='types')!.principle}]}};}
it('accepts varied language without a per-question grammar, bound to the complete local answer',async()=>{
 expect(await validateSourceAssessment(await certificate(),q,answer)).toMatchObject({outcome:'understood'});
 expect(await validateSourceAssessment(await certificate(),q,answer+' But it validates JSON automatically.')).toBeNull();
 expect(await validateSourceAssessment(await certificate(),{...q,prompt:'What happens after a rollback?'},answer)).toBeNull();
});
it('fails closed for forged sources, missing criteria, self review, missing quote and outcome mismatch',async()=>{
 for(const change of [(c:any)=>c.proof.models.fill('same'),(c:any)=>c.proof.criteria=[],(c:any)=>c.proof.criteria[0].sourceId='fabricated',(c:any)=>c.proof.criteria[0].sourceQuote='A model invented this source statement.',(c:any)=>c.proof.criteria[0].quote='Not in the learner answer',(c:any)=>c.proof.criteria[0].state='missing',(c:any)=>c.revision='old']){
 const c=await certificate();change(c);expect(await validateSourceAssessment(c,q,answer)).toBeNull();
 }
});
it('distinguishes partial reasoning from an explicit misconception',async()=>{
 const c=await certificate();c.outcome='partial';c.proof.criteria.push({...c.proof.criteria[0],criterion:'Explains why malformed external input remains untrusted',state:'missing',quote:''});
 expect(await validateSourceAssessment(c,q,answer)).toMatchObject({outcome:'partial'});
 c.outcome='incorrect';expect(await validateSourceAssessment(c,q,answer)).toBeNull();
 c.proof.criteria[0].state='contradicted';expect(await validateSourceAssessment(c,q,answer)).toMatchObject({outcome:'incorrect'});
});
it('retrieves general sources across topics, not a predefined question list',()=>{
 for(const text of ['HTTP cache no-cache ETag','SQL injection bound parameters','Promise.all rejects','Postgres index costs','TypeScript runtime validation','retry backoff jitter','transaction serializable isolation','HttpOnly CSRF','authorization server','cancel child process'])expect(knowledgeFor(text).length).toBeGreaterThan(0);
 expect(knowledgeFor('How do virtual nodes rebalance a consistent hashing ring?')).toEqual([]);
 expect(knowledgeFor('Could XSS still perform actions with an HttpOnly cookie?').find(r=>r.id==='csrf')?.principle).toContain('XSS can undermine CSRF defenses');
 expect(knowledgeFor({question:'How do virtual nodes balance a consistent hashing ring?',answer:'Several virtual nodes per physical server spread ownership around the ring; hot keys can still skew load.'})).toEqual([]);
 expect(knowledgeFor('Check resource ownership before allowing access').some(r=>r.id==='authorization')).toBe(true);
});
