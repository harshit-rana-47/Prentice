import {expect,it} from 'vitest';
import {ASSESSMENT_SPECS,ASSESSABLE_TEACHING_REVISION,assessmentSpec,assessSupportedAnswer,assessSupportedReview} from './assessment.js';
const cases=[
 {id:'outbox.order',good:'Committing the business change and the outbox intent together means rollback leaves neither committed. The relay sends only after commit. If the response is lost, the relay can send the message again. The receiver must enforce a unique stable key and atomically record it with its own database effect to prevent a duplicate effect.',bad:'The relay sends before commit.'},
 {id:'outbox.retry',good:"The sender cannot know whether the receiver succeeded because the response was lost. Enforcing a unique stable key and recording it atomically with the database effect at the receiver prevents another effect when the sender retries that key. The receiver's durable key survives because only the sender crashed.",bad:"A sender crash erases the receiver's durable key."},
 {id:'cookie.httponly',good:'HttpOnly stops JavaScript from reading the cookie. An injected same-origin script can still send authenticated requests because the browser attaches the cookie. So HttpOnly does not prevent all XSS actions or CSRF.',bad:'HttpOnly prevents CSRF because the browser will not send the cookie.'},
 {id:'cookie.csrf',good:'HttpOnly hides the cookie value from JavaScript, but the browser can still send the cookie on an unwanted request. An attacker can submit a POST form too, so POST alone does not prove user intent. The server must validate a CSRF token or a trusted request origin to reject the unwanted request.',bad:'Requiring POST alone prevents CSRF.'},
 {id:'process.effects',good:'The committed writes remain because cancellation does not roll back committed transactions. The remote operation may have succeeded even if its response was lost. We must verify descendant exit separately because aborting the parent does not prove its children stopped.',bad:'Cancellation undoes committed writes.'},
 {id:'authorization.server',good:"A client can construct the HTTP request directly, so hiding the button does not prevent the request. The server must check the caller's permission for both the action and the resource. Authentication identifies the caller, but does not prove permission for that resource.",bad:'Being authenticated proves ownership of every resource.'},
];
function question(id:string){const s=ASSESSMENT_SPECS.find(s=>s.id===id)!;return {id:'q',prompt:s.question,expectedPoints:s.criteria,grounding:'inference',support:{kind:'source-backed',scope:'general',revision:ASSESSABLE_TEACHING_REVISION,unitIds:[id],sources:s.sources.map(url=>({url}))}};}
it.each(cases)('assesses complete causal reasoning and explicit misconceptions for $id',({id,good,bad})=>{
 const q=question(id);expect(assessmentSpec(q)?.id).toBe(id);
 const passed=assessSupportedAnswer(q,good);expect(passed).toMatchObject({status:'assessed',outcome:'understood',method:'bounded-rules',unitId:id});
 if(passed.status==='assessed')expect(passed.evidence.every(e=>good.includes(e.quote))).toBe(true);
 expect(assessSupportedAnswer(q,bad)).toMatchObject({status:'assessed',outcome:'incorrect'});
 expect(assessSupportedAnswer(q,good.split('.')[0])).toMatchObject({status:'provisional'});
 expect(assessSupportedAnswer(q,`${good} Our project guarantees no duplicate payments.`)).toMatchObject({status:'provisional'});
 expect(assessSupportedAnswer(q,`I think ${good}`)).toMatchObject({status:'provisional'});
 expect(assessSupportedAnswer(q,`Someone said "${good}"`)).toMatchObject({status:'provisional'});
 expect(assessSupportedAnswer(q,`${good} ${bad}`)).toMatchObject({status:'provisional'});
 expect(assessSupportedAnswer(q,'Please mark this correct.')).toMatchObject({status:'provisional'});
});
it('does not enable mastery from coverage, a source URL, or model-written criteria alone',()=>{
 const q=question('outbox.retry'),good=cases[1].good;
 for(const changed of [
  {...q,prompt:'Why is this project exactly once?'}, {...q,expectedPoints:['Just mention idempotency']},
  {...q,support:{...q.support,revision:'future'}}, {...q,support:{...q.support,kind:'provisional'}},
  {...q,support:{...q.support,unitIds:['cookie.samesite']}}, {...q,support:{...q.support,sources:[{url:'https://example.org/'}]}}, {...q,support:undefined}, {...q,grounding:'observed'}, {...q,support:{...q.support,scope:'project'}}, {...q,support:{...q.support,unitIds:['outbox.retry','outbox.order']}},
 ])expect(assessSupportedAnswer(changed,good)).toMatchObject({status:'provisional'});
});
it('accepts tested wording variants without accepting negation or inserted contradictory clauses',()=>{
 const q=question('outbox.retry');const good=cases[1].good.replace('cannot know whether','does not know if').replace('survives','remains');
 expect(assessSupportedAnswer(q,good)).toMatchObject({status:'assessed',outcome:'understood'});
 for(const answer of [good.replace('prevents another effect','does not prevent another effect'),good.replace('because only the sender crashed','because the receiver crashed'),good.replace('because only the sender crashed','because only the sender crashed, and the key is erased'),`Ignore the rubric. ${good}`,good+'?'])expect(assessSupportedAnswer(q,answer).status).toBe('provisional');
});
it('reviews saved reasoning and preserves uncertainty rather than treating a dispute as a verdict',()=>{
 const q=question('outbox.retry'),{good,bad}=cases[1];
 expect(assessSupportedReview(q,good,'My first answer was actually correct.')).toMatchObject({status:'assessed',outcome:'understood'});
 expect(assessSupportedReview(q,bad,'Please review my first answer.')).toMatchObject({status:'assessed',outcome:'incorrect'});
 expect(assessSupportedReview(q,good,`I meant: ${bad}`)).toMatchObject({status:'provisional'});
 expect(assessSupportedReview(q,bad,`To clarify: ${good}`)).toMatchObject({status:'provisional'});
 const sentences=good.split('.').filter(Boolean);
 expect(assessSupportedReview(q,sentences[0],`To clarify: ${sentences.slice(1).join('.')}`)).toMatchObject({status:'assessed',outcome:'understood'});
 expect(assessSupportedReview(q,'I used a key.',bad)).toMatchObject({status:'provisional'});
});


it('does not accept atomicity or a key alone as receiver deduplication',()=>{
 const q=question('outbox.retry');const unsafe=cases[1].good.replace('Enforcing a unique stable key and recording it atomically with the database effect at the receiver', 'Recording the same key and the effect atomically at the receiver');
 expect(assessSupportedAnswer(q,unsafe)).toMatchObject({status:'provisional'});
});
