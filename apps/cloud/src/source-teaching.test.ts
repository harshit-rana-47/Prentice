// Legacy-path regressions; semantic-tutor tests exercise the default independent-review path.
process.env.GROQ_REVIEW_MODEL="disabled";
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {completeLearning} from './learning.js';
import {UNITS,SOURCES,renderSourcePlan,sourceUnits,sourceLessonDraft,sourceRouteSchema,provisionalReply,routeCandidate} from './source-teaching.js';
const native=globalThis.fetch;const key=process.env.GROQ_API_KEY;
afterEach(()=>{globalThis.fetch=native;if(key===undefined)delete process.env.GROQ_API_KEY;else process.env.GROQ_API_KEY=key;vi.restoreAllMocks();});
const context={message:'Explain it.',history:[]};
const plan=(units:string[],mode='explain',extra={})=>({sourcePlan:{units,mode,...extra}});
const fixtures:Array<{label:string;candidate:any;request:any}>=JSON.parse(readFileSync(new URL('./__fixtures__/teaching-regressions.json',import.meta.url),'utf8'));

// These are deterministic rendering/assessment tests, never model-quality approvals.
it.each(fixtures)('discards the previously approved false prose: $label',async fixture=>{
 process.env.GROQ_API_KEY='synthetic';
 globalThis.fetch=vi.fn(async()=>Response.json({choices:[{message:{content:JSON.stringify({...fixture.candidate,sourcePlan:{units:fixture.label.includes('outbox')?['outbox.order','outbox.retry']:['cookie.samesite','cookie.csrf'],mode:'example'}})}}]})) as typeof fetch;
 const result=await completeLearning({...fixture.request,message:'Give a worked example.'});
 expect(result.ok).toBe(true);if(!result.ok)return;
 const r=result.json as any;
 expect(r.support).toMatchObject({kind:'source-backed',scope:'general'});
 expect(r.text).not.toBe(fixture.candidate.text);
 expect(r.understood).toBe(false);expect(r.text).toContain("do not verify the project's implementation");
 expect(globalThis.fetch).toHaveBeenCalledTimes(1);
 if(fixture.label.includes('outbox')){expect(r.text).toContain('commits');expect(r.text).toContain('receiver');}
 else {expect(r.text).toContain('Strict: same site eligible; cross site top level GET excluded');expect(r.text).toContain('omitted: same site eligible; cross site top level GET browser-dependent');expect(r.text).toContain('POST-only endpoints are not complete CSRF defenses');}
});
it('never incorporates model prose, links or unsupported IDs into sourced output',()=>{
 const r=renderSourcePlan({...plan(['outbox.order','outbox.retry'],'example'),text:'Invented exactly-once guarantee https://evil.test',support:{kind:'observed'}},context,UNITS)!;
 expect(r.text).not.toContain('evil.test');expect(r.text).not.toContain('Invented');expect(r.support.scope).toBe('general');
 expect(r.support.sources.every(s=>Object.values(SOURCES).some(x=>x.url===s.url))).toBe(true);
 for(const bad of [plan(['fake']),plan(['outbox.order','outbox.order']),plan(['outbox.order'],'fake'),plan([]),plan(['outbox.order'],'review',{reviewTurnId:'unknown'})])expect(renderSourcePlan(bad,context,UNITS)).toBeNull();
});
it('quotes only the selected saved answer and keeps unsupported reviews provisional',()=>{
 const ctx={message:'My first answer was right.',reviews:[{id:'first',answer:'Sender commits intent before sending.'},{id:'second',answer:'The receiver records the key.'}]};
 const r=renderSourcePlan(plan(['outbox.order'],'review',{reviewTurnId:'first',quote:'receiver records the key',verdict:'consistent'}),ctx,UNITS)!;
 expect(r.text).not.toContain('You wrote');expect(r).toMatchObject({intent:'review',understood:false,reviewTurnId:'first',assessment:{status:'provisional',tentative:'uncertain'}});
 const exact=renderSourcePlan(plan(['outbox.order'],'review',{reviewTurnId:'first',quote:'commits intent'}),ctx,UNITS)!;expect(exact.text).toContain('“commits intent”');
});
it('gives different increasingly concrete hints before walking through the case',()=>{
 const history:any[]=[];const texts:string[]=[];
 for(let i=0;i<4;i++){
  const r=renderSourcePlan(plan(['outbox.retry'],'hint'),{message:'Another hint please.',history},UNITS)!;
  expect(r.intent).toBe('discuss');expect(r.assessment).toBeUndefined();texts.push(r.text);history.push({support:r.support,reply:r.text});
 }
 expect(new Set(texts).size).toBe(4);expect(texts[2]).toContain('crash only the sender');expect(texts[3]).toContain('walk through');
 const focused=renderSourcePlan(plan(['outbox.retry','transaction.boundary'],'hint'),{message:'Another hint please.',history:[]},UNITS)!;
 expect(focused.support.unitIds).toEqual(['outbox.retry']);expect(focused.text).not.toContain('email service');
});
it('keeps follow-up source content consistent with its worked example',()=>{
 const example=renderSourcePlan(plan(['outbox.order'],'example'),context,UNITS)!;
 const follow=renderSourcePlan(plan(['outbox.retry'],'discuss'),{message:'Does the sender crash erase the receiver key?',history:[{reply:example.text}]},UNITS)!;
 expect(example.text).toContain('leaves the receiver key and effect intact');expect(follow.text).toContain('does not erase that receiver record');
 expect(follow.assessment).toBeUndefined();
});
it('keeps source prose within actual display and lesson field bounds',()=>{
 for(const u of UNITS){
  for(const mode of ['explain','example','hint','feedback'])expect(renderSourcePlan(plan([u.id],mode),context,UNITS)!.text.length).toBeLessThanOrEqual(6000);
  const draft=sourceLessonDraft({concepts:[{title:u.area+' '+u.summary,question:u.id,basisIds:['f']}]},{facts:[{id:'f'}],scope:{maxConcepts:1}})!;
  // Explicit ID here is only a selection hint; production lessons use natural-language scope.
  expect(draft.allSourced).toBe(true);for(const field of ['explanation','mechanism','tradeoff','transfer'])expect((draft.json.concepts[0] as any)[field].length).toBeLessThanOrEqual(1800);
 }
});
it('replaces covered lesson questions, criteria and prose together without inventing evidence anchors',()=>{
 const value={concepts:[{title:'Transactional outbox',question:'Does rollback unsend an email?',expectedPoints:['Rollback unsends email'],explanation:'BAD',basisIds:['agent']}]};
 const r=sourceLessonDraft(value,{facts:[],agentStated:[{id:'agent'}],scope:{maxConcepts:1}})!;
 expect(r.allSourced).toBe(true);expect(r.json.concepts[0]).toMatchObject({basisIds:['agent'],support:{kind:'source-backed',scope:'general'}});expect(JSON.stringify(r)).not.toContain('Rollback unsends email');expect(JSON.stringify(r)).not.toContain('BAD');
 const invalid=sourceLessonDraft(value,{facts:[],agentStated:[]})!;expect(invalid.allSourced).toBe(false);expect(invalid.json.concepts[0].support.kind).toBe('provisional');
});
it('keeps unsupported topics useful but provisional, including forged verified assessments',()=>{
 const v=provisionalReply({intent:'answer',understood:true,text:'A tentative explanation.',support:{kind:'observed'},assessment:{status:'verified'}});
 expect(v).toMatchObject({understood:false,support:{kind:'provisional',scope:'general'},assessment:{status:'provisional',tentative:'understood'}});expect(v.text).toContain('not been marked');
 expect(sourceUnits({message:'Explain virtual nodes in consistent hashing.'})).toEqual([]);
 expect(sourceUnits({message:'What does the session do?'})).toEqual([]);
 const route=routeCandidate({mode:'provisional',intent:'answer',verdict:'consistent',text:'Virtual nodes reduce random imbalance.'});
 expect(provisionalReply(route)).toMatchObject({understood:false,assessment:{status:'provisional',tentative:'understood'}});
});
it('uses a closed schema while independently validating plans at runtime',()=>{
 const schema=sourceRouteSchema(UNITS) as any;expect(schema.additionalProperties).toBe(false);expect(schema.required).toEqual(Object.keys(schema.properties));
 expect(schema.properties.units.items.enum).toEqual(UNITS.map(u=>u.id));
 expect(renderSourcePlan(plan(['cookie.csrf']),'ignored' as any,sourceUnits({message:'Explain outbox retries.'}))).toBeNull();
});
