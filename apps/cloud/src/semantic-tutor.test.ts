import {afterEach,expect,it,vi} from 'vitest';
import {KNOWLEDGE} from '@prentice/domain';
import {completeLearning} from './learning.js';
const native=globalThis.fetch;
afterEach(()=>{globalThis.fetch=native;vi.unstubAllEnvs();});
const answer='An index narrows the rows to inspect, but writes must keep the extra data structure updated, so it adds overhead.';
const current={prompt:'Why can an index help reads but cost writes?',criteria:['Explain lookup and maintenance costs'],grounding:'inference'};
const candidate={intent:'answer',understood:true,text:'You explained both the reduced lookup work and the extra write maintenance.',hint:'',teaching:'',reviewTurnId:null,questionId:null};
const audit=()=>({safeTeaching:true,coverage:true,outcome:'understood',reason:'Explains the causal tradeoff.',criteria:[{criterion:'Explains index lookup benefits and maintenance overhead',state:'met',quote:answer,sourceId:'indexes',sourceQuote:KNOWLEDGE.find(r=>r.id==='indexes')!.principle}],feedback:'',hint:''});
function sequence(values:unknown[]){if(values[0]&&typeof values[0]==='object'&&!(values[0] instanceof Response)){const first={...(values[0] as any)};values[0]=first;if(['answer','review'].includes(first.intent)&&!first.evaluation){const second=values[1] as any;first.evaluation={outcome:first.understood?'understood':second?.outcome??'incorrect',reason:second?.reason??'Explains the source-backed boundary.',criteria:second?.criteria??[]};}}vi.stubEnv('GROQ_API_KEY','synthetic');vi.stubEnv('GROQ_REVIEW_MODEL','qwen/qwen3.8-27b');vi.stubEnv('GROQ_MODEL','openai/gpt-oss-120b');const sent:any[]=[];globalThis.fetch=vi.fn(async(_url,init)=>{sent.push(JSON.parse(String(init?.body)));const v=values.length?values.shift():{safe:true,coverage:true};return v instanceof Response?v:Response.json({choices:[{message:{content:JSON.stringify(v)}}]});}) as typeof fetch;return sent;}
const request=(message=answer)=>({action:'tutor',evidence:{facts:[],agentStated:[]},current,message,history:[]});
it('does not retrieve process-cancellation references from incidental exception-lesson wording',async()=>{
 const sent=sequence([Response.json({}, {status:429})]);
 const r:any=await completeLearning({...request('Throwing stops normal execution; the caller catches the error or it propagates to a higher handler.'),current:{prompt:"How does using a thrown exception affect the caller's error-handling responsibilities?",concept:'Exception-based input validation',criteria:['Explain propagation and caller handling'],grounding:'inference',teaching:'An exception provides a signal that input is unacceptable and aborts normal flow.'}});
 expect(JSON.parse(sent[0].messages[1].content).references).toEqual([]);
 expect(r.json.text).not.toContain('Killing a parent');
 expect(r.json).toMatchObject({understood:false,assessment:{status:'provisional'},support:{kind:'provisional'}});
});
it('uses a different model, exact source evidence and complete-answer binding for a new question',async()=>{
 const sent=sequence([candidate,audit()]);const r=await completeLearning(request());expect(r).toMatchObject({ok:true,json:{understood:true,assessment:{status:'assessed',method:'source-review',outcome:'understood'}}});expect(sent.map(r=>r.model)).toEqual(['openai/gpt-oss-120b','qwen/qwen3.8-27b','qwen/qwen3.8-27b']);expect(JSON.parse(sent[1].messages[1].content).candidate).toBeUndefined();expect(sent[1].max_completion_tokens).toBe(600);expect(sent[2].max_completion_tokens).toBe(250);expect(sent[0].max_completion_tokens).toBeUndefined();
});
it('does not grant mastery on model disagreement, insufficient coverage, ambiguity, or fabricated evidence',async()=>{
 const cases=[{...audit(),outcome:'ambiguous'},{...audit(),coverage:false},{...audit(),criteria:[]},{...audit(),criteria:[{...audit().criteria[0],sourceId:'made-up-reference'}]},{...audit(),outcome:'partial',criteria:[...audit().criteria,{...audit().criteria[0],state:'missing',quote:''}]}];
 for(const a of cases){sequence([candidate,a,{safe:true,coverage:a.coverage}]);expect(await completeLearning(request())).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});}
});
it('returns useful provisional help rather than an unchecked reply when reviewer fails',async()=>{
 for(const a of [{safe:false},Response.json({}, {status:429})]){sequence(a instanceof Response?[candidate,a]:[candidate,audit(),a]);const r:any=await completeLearning(request());expect(r.json).toMatchObject({intent:'answer',understood:false,assessment:{status:'provisional'}});expect(r.json.text).toContain('Maintaining indexes');expect(r.json.text).not.toContain(candidate.text);}
});
it('leaves requests for another hint and follow-up questions unassessed and contextual',async()=>{
 const reply={...candidate,intent:'discuss',understood:false,text:'Picture inserting a row: besides the table, which structure must now learn where that row lives?'};
 sequence([reply,{...audit(),outcome:'unassessed',criteria:[]}]);const r:any=await completeLearning(request('Another hint about write costs please.'));expect(r.json.text).toBe(reply.text);expect(r.json.assessment).toBeUndefined();
});
it('cannot retract a previous demonstration from an inconclusive clarification',async()=>{
 const bad='An index always makes writes faster.';const a={...audit(),outcome:'incorrect',criteria:[{...audit().criteria[0],state:'contradicted',quote:bad}]};
 sequence([{...candidate,intent:'review',understood:false,reviewTurnId:'first'},a]);const r:any=await completeLearning({...request('To clarify: '+bad),reviews:[{...current,id:'first',answer,answerTruncated:false}]});expect(r.json.assessment.status).toBe('provisional');
});

it('does not let a second model waive an unqualified guarantee or add a full lesson on an initial attempt',async()=>{
 const unsafe={...candidate,understood:false,text:'The key guarantees that the external effect occurs at most once.'};
 sequence([unsafe,audit()]);const blocked:any=await completeLearning(request());expect(blocked.json.intent).toBe('answer');expect(blocked.json.assessment.status).toBe('provisional');
 sequence([{...candidate,teaching:'The key guarantees that the external effect occurs at most once.'},audit()]);const initial:any=await completeLearning(request());expect(initial.json.teaching).toBe('');expect(initial.json.assessment.outcome).toBe('understood');
});

it('blocks the live-reproduced remote charge inside a local transaction, even when a reviewer would approve',async()=>{
 const text='B starts a transaction, records the key and charges a credit card. It commits both together.';
 const sent=sequence([{...candidate,intent:'teach',text},audit()]);
 const result:any=await completeLearning({...request('Give an example.'),current:{...current,prompt:'Explain the transactional outbox retry boundary.'}});
 expect(result.json.intent).toBe('teach');expect(result.json.text).not.toContain(text);expect(result.json.text).toMatch(/(?:stated|explicit) assumptions/);expect(sent).toHaveLength(2);
});

it('retains varied covered questions but independently reviews their criteria before release',async()=>{
 const {sourceLessonDraft}=await import('./source-teaching.js');
 const question='Predict the outcome when the relay loses its acknowledgement after the receiver commits.';
 const input={concepts:[{title:'Transactional outbox',question,expectedPoints:['Explain which durable state survives and how the retry is suppressed'],basisIds:['f']}]};
 const result=sourceLessonDraft(input,{facts:[{id:'f'}]},true)!;
 expect(result.allSourced).toBe(false);expect(result.json.concepts[0].question).toBe(question);
});

it('uses the checked cookie state trace rather than releasing the live contradictory Strict/Lax example',async()=>{
 const wrong='SameSite=Strict: a cross-site POST sends the cookie. Explicit Lax also sends it on POST.';
 sequence([{...candidate,intent:'teach',text:wrong},{...audit(),outcome:'unassessed',criteria:[]}]);
 const r:any=await completeLearning({...request('Give an example.'),current:{...current,prompt:'Do HttpOnly cookies and requiring POST prevent CSRF?'}});
 expect(r.json.text).not.toContain(wrong);expect(r.json.text).toContain('explicit Strict');expect(r.json.text).toContain('unsafe POST');expect(r.json.assessment).toBeUndefined();
});
it('replaces the live overbroad cookie hint with an actual scoped reasoning clue',async()=>{
 sequence([{...candidate,intent:'discuss',text:'The browser sends cookies on every request regardless of where the request originates.'},audit()]);
 const r:any=await completeLearning({...request('Another hint please'),current:{...current,prompt:'Why are HttpOnly and POST insufficient to prevent CSRF?'},history:[{message:'A hint please'}]});expect(r.json.text).toContain('token or request-origin');expect(r.json.assessment.status).toBe('provisional');
});

it('a blind incorrect grade is independent of teaching approval and cannot consume an attempt if prose review fails',async()=>{
 const bad='An index makes every write cheaper.';
 const blind={...audit(),safeTeaching:false,outcome:'incorrect',criteria:[{...audit().criteria[0],state:'contradicted',quote:bad}]};
 const tutor={...candidate,understood:false,text:'An index must also be updated when rows change.'};
 sequence([tutor,blind,{safe:true,coverage:true}]);expect(await completeLearning(request(bad))).toMatchObject({ok:true,json:{assessment:{status:'assessed',outcome:'incorrect'}}});
 sequence([tutor,blind,{safe:false}]);expect(await completeLearning(request(bad))).toMatchObject({ok:true,json:{intent:'answer',assessment:{status:'provisional'}}});
});

it('does not leak the learner answer into prose review or the proposed tutor answer into blind grading',async()=>{
 const sent=sequence([candidate,audit(),{safe:true,coverage:true}]);await completeLearning(request());
 const blind=JSON.parse(sent[1].messages[1].content),review=JSON.parse(sent[2].messages[1].content);
 expect(blind.evaluatedAnswer).toBe(answer);expect(blind.candidate).toBeUndefined();
 expect(review.evaluatedAnswer).toBeUndefined();expect(review.message).toBeUndefined();expect(review.latestExchange.prentice.text).toBe(candidate.text);expect(review.latestExchange.learner).toBe(answer);
});

it('requires two grounded structured grades rather than a contradictory legacy boolean or scalar approval',async()=>{
 const valid={outcome:'understood',reason:audit().reason,criteria:audit().criteria};
 sequence([{...candidate,understood:false,evaluation:valid},audit(),{safe:true,coverage:true}]);expect(await completeLearning(request())).toMatchObject({ok:true,json:{understood:true,assessment:{outcome:'understood'}}});
 sequence([{...candidate,evaluation:{}},audit(),{safe:true,coverage:true}]);expect(await completeLearning(request())).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
});

it('does not return the tutor drafting rubric in the conversation response',async()=>{
 sequence([candidate,audit(),{safe:true,coverage:true}]);const r:any=await completeLearning(request());expect(r.json.evaluation).toBeUndefined();expect(r.json.assessment).toHaveProperty('proof');
});

it('retrieves references for the original reviewed question rather than only the current topic',async()=>{
 const sent=sequence([{...candidate,intent:'review',reviewTurnId:'first'},audit(),{safe:true,coverage:true}]);
 await completeLearning({...request('My first answer was actually correct.'),current:{...current,prompt:'Explain TypeScript runtime validation.'},reviews:[{id:'first',prompt:'What does a sender crash do to the receiver idempotency key?',criteria:['Explain durable receiver state'],grounding:'inference',answer:'It erases the receiver key.'}]});
 expect(JSON.parse(sent[0].messages[1].content).references.map((r:any)=>r.id)).toContain('outbox');expect(JSON.parse(sent[1].messages[1].content).question.prompt).toContain('sender crash');
});

it('can reassess the saved explanation when the review request is phrased as a question',async()=>{
 sequence([{...candidate,intent:'review',reviewTurnId:'first'},audit(),{safe:true,coverage:true}]);
 const r:any=await completeLearning({...request('Was my answer correct?'),reviews:[{...current,id:'first',answer,answerTruncated:false}]});
 expect(r.json).toMatchObject({intent:'review',understood:true,assessment:{status:'assessed',outcome:'understood'}});
});

it('resolves canonical source material from IDs instead of trusting model-generated quotations',async()=>{
 const altered={...audit(),criteria:[{...audit().criteria[0],sourceQuote:'A made-up quotation with an ellipsis ...'}]};
 sequence([candidate,altered,{safe:true,coverage:true}]);const r:any=await completeLearning(request());expect(r.json.assessment).toMatchObject({status:'assessed',outcome:'understood'});expect(r.json.assessment.proof.criteria[0].sourceQuote).toBe(KNOWLEDGE.find(k=>k.id==='indexes')!.principle);
 const unknown={...altered,criteria:[{...altered.criteria[0],sourceId:'invented'}]};sequence([candidate,unknown,{safe:true,coverage:true}]);expect(await completeLearning(request())).toMatchObject({ok:true,json:{assessment:{status:'provisional'}}});
});

it('progresses exhausted fallback hints into a checked example instead of repeating the last hint forever',async()=>{
 sequence([{...candidate,intent:'discuss',text:"Sure, here's a hint to guide you toward a complete answer."},audit()]);
 const r:any=await completeLearning({...request('Another hint please'),current:{...current,prompt:'Why are HttpOnly and POST insufficient against CSRF?'},history:[{message:'hint please'},{message:'another hint'},{message:'more hint'}]});
 expect(r.json.text).toContain('walk through a concrete case');expect(r.json.text).toContain('SameSite=None');expect(r.json.understood).toBe(false);
});

it('does not publish a definitive negative judgment when grounded reviews disagree about partial reasoning',async()=>{
 const first={...candidate,understood:false,text:'You did not explain anything correctly.',hint:'What must the receiver remember when the sender retries?',evaluation:{outcome:'incorrect',reason:'Missing reasoning',criteria:[{...audit().criteria[0],state:'missing',quote:''}]}};
 const second={...audit(),outcome:'partial',criteria:[audit().criteria[0],{...audit().criteria[0],criterion:'Explains the remaining write maintenance step',state:'missing',quote:''}]};
 sequence([first,second,{safe:true,coverage:true}]);const r:any=await completeLearning(request());expect(r.json.assessment.status).toBe('provisional');expect(r.json.text).not.toContain('did not explain anything');expect(r.json.text).toContain('What must the receiver remember');expect(r.json.hint).toBe('');
});

it('selects a distinct default reviewer when the tutor model changes and refuses explicit self-review',async()=>{
 const {reviewerConfig}=await import('./groq.js');vi.stubEnv('GROQ_REVIEW_MODEL','');
 expect(reviewerConfig({apiKey:'synthetic',model:'qwen/qwen3.8-27b'})?.model).toBe('openai/gpt-oss-120b');expect(reviewerConfig({apiKey:'synthetic',model:'openai/gpt-oss-120b'})?.model).toBe('qwen/qwen3.8-27b');
 vi.stubEnv('GROQ_REVIEW_MODEL','qwen/qwen3.8-27b');expect(reviewerConfig({apiKey:'synthetic',model:'qwen/qwen3.8-27b'})).toBeNull();
});

it('repairs the live missing-versus-contradicted record once before independent grading, without exposing the other verdict',async()=>{
 const bad='An index always speeds every read and every write.';
 const criterion={criterion:'Explains that maintaining the index adds write overhead',state:'contradicted',quote:bad,sourceId:'indexes'};
 const invalid={outcome:'incorrect',reason:'Incorrect write cost claim.',criteria:[{...criterion,state:'missing'}]};
 const repaired={...invalid,criteria:[criterion]};
 const sent=sequence([{...candidate,understood:false,text:'Consider the cost of maintaining the index.',evaluation:invalid},repaired,{...audit(),...repaired},{safe:true,coverage:true}]);
 const r:any=await completeLearning(request(bad));
 expect(r.json.assessment).toMatchObject({status:'assessed',outcome:'incorrect'});
 expect(sent.map(s=>s.model)).toEqual(['openai/gpt-oss-120b','openai/gpt-oss-120b','qwen/qwen3.8-27b','qwen/qwen3.8-27b']);
 expect(JSON.parse(sent[1].messages[1].content).evaluatedAnswer).toBe(bad);
 expect(JSON.parse(sent[1].messages[1].content).candidate).toBeUndefined();
 expect(JSON.parse(sent[2].messages[1].content).proposal).toBeUndefined();
});

it('repairs reference prose mistakenly placed in learner quote fields, but still requires both valid grades',async()=>{
 const invalid={outcome:'understood',reason:'Correct tradeoff.',criteria:[{...audit().criteria[0],quote:KNOWLEDGE.find(k=>k.id==='indexes')!.principle}]};
 sequence([{...candidate,evaluation:invalid},{outcome:'understood',reason:audit().reason,criteria:audit().criteria},audit(),{safe:true,coverage:true}]);
 expect(await completeLearning(request())).toMatchObject({ok:true,json:{assessment:{status:'assessed',outcome:'understood'}}});
 sequence([{...candidate,evaluation:invalid},{outcome:'understood',reason:audit().reason,criteria:audit().criteria},{...audit(),outcome:'ambiguous'}, {safe:true,coverage:true}]);
 expect(await completeLearning(request())).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
});

it('cannot use repair to change an outcome, invent an evidence span, or retry indefinitely',async()=>{
 const invalid={outcome:'understood',reason:'Correct tradeoff.',criteria:[{...audit().criteria[0],quote:'An invented learner quotation'}]};
 for(const repair of [{...audit(),outcome:'incorrect'},invalid,Response.json({}, {status:429})]){
  const sent=sequence([{...candidate,evaluation:invalid},repair,audit(),{safe:true,coverage:true}]);
  expect(await completeLearning(request())).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
  expect(sent).toHaveLength(4);
 }
});

it('keeps repair within the existing overall deadline',async()=>{
 const sent=sequence([{...candidate,evaluation:{outcome:'understood',reason:'Unusable evidence.',criteria:[]}}]);
 const now=vi.spyOn(Date,'now').mockReturnValueOnce(0).mockReturnValue(29_500);
 try{expect(await completeLearning(request())).toMatchObject({ok:true,json:{assessment:{status:'provisional'}}});expect(sent).toHaveLength(1);}finally{now.mockRestore();}
});

const menu={...candidate,intent:'discuss',understood:false,text:'Would you like to try answering the question again, get a detailed explanation, or move on?',evaluation:{outcome:'unassessed',reason:'No new answer provided to assess.',criteria:[]}};
it('retries the live generic-menu nonresponse and independently checks the replacement assessment',async()=>{
 const bad='An index always makes every write faster.';
 const evaluation={outcome:'incorrect',reason:'Index maintenance adds overhead.',criteria:[{...audit().criteria[0],state:'contradicted',quote:bad}]};
 const sent=sequence([menu,{...candidate,understood:false,text:'Updating a row also requires maintaining its indexes.',evaluation},{...audit(),...evaluation},{safe:true,coverage:true}]);
 const r:any=await completeLearning(request(bad));
 expect(r.json).toMatchObject({intent:'answer',assessment:{status:'assessed',outcome:'incorrect'}});
 expect(r.json.text).not.toContain('Would you like');expect(sent.map(s=>s.model)).toEqual(['openai/gpt-oss-120b','openai/gpt-oss-120b','qwen/qwen3.8-27b','qwen/qwen3.8-27b']);
 expect(JSON.parse(sent[1].messages[1].content).validationIssue).toContain('Only offered next-step choices');
});

it('withholds a repeated menu and retains useful source help without looping or awarding mastery',async()=>{
 const sent=sequence([menu,menu]);const r:any=await completeLearning(request('Another concrete hint please.'));
 expect(sent).toHaveLength(2);expect(r.json.assessment.status).toBe('provisional');expect(r.json.text).not.toContain(menu.text);expect(r.json.text).toContain('Maintaining indexes');
});

it('allows a choice menu when the learner actually requests options or gives an ambiguous acknowledgment',async()=>{
 for(const message of ['yes','What are my options?']){
  const sent=sequence([menu,{safeTeaching:true,outcome:'unassessed',reason:'Clarifies next step.',criteria:[]}]);
  const r:any=await completeLearning(request(message));expect(r.json.text).toBe(menu.text);expect(sent).toHaveLength(2);expect(r.json.assessment).toBeUndefined();
 }
});

it('does not require evidence of absent reasoning or accept fabricated evidence for a contradiction',async()=>{
 const bad='An index always makes every write faster.';
 const evaluation={outcome:'incorrect',reason:'Index maintenance adds write overhead.',criteria:[{...audit().criteria[0],state:'contradicted',quote:bad},{...audit().criteria[0],criterion:'Explains how an index narrows the read lookup',state:'missing',quote:'A quote copied from the question rather than the answer'}]};
 const sent=sequence([{...candidate,understood:false,text:'Maintaining the index adds work.',evaluation},{...audit(),...evaluation},{safe:true,coverage:true}]);
 const r:any=await completeLearning(request(bad));expect(r.json.assessment).toMatchObject({status:'assessed',outcome:'incorrect'});expect(r.json.assessment.proof.criteria[1].quote).toBe('');expect(r.json.assessment.evidence).toHaveLength(1);expect(sent).toHaveLength(3);
 const fabricated={...evaluation,criteria:[{...evaluation.criteria[0],quote:'A fabricated learner misconception'},evaluation.criteria[1]]};
 sequence([{...candidate,evaluation:fabricated},fabricated,{...audit(),...evaluation},{safe:true,coverage:true}]);expect(await completeLearning(request(bad))).toMatchObject({ok:true,json:{assessment:{status:'provisional'}}});
});

it('recovers the live sentence-initial article capitalization error while retaining an exact learner span',async()=>{
 const text='I was wrong earlier. The index narrows the lookup but adds work to writes.';
 const a={...audit(),criteria:[{...audit().criteria[0],quote:'the index narrows the lookup but adds work to writes'}]};
 const sent=sequence([{...candidate,evaluation:{outcome:a.outcome,reason:a.reason,criteria:a.criteria}},a,{safe:true,coverage:true}]);
 const r:any=await completeLearning(request(text));expect(r.json.assessment).toMatchObject({status:'assessed',outcome:'understood'});expect(r.json.assessment.proof.criteria[0].quote).toBe('The index narrows the lookup but adds work to writes');expect(sent).toHaveLength(3);
});

it('does not case-fold identifiers or arbitrary words, change a claim, or resolve ambiguous quote matches',async()=>{
 for(const [text,quote] of [
  ['UserID differs from userId; the spelling matters.','userID differs from userId'],
  ['An index adds write work.','an index removes write work'],
  ['The index adds write work. The index adds write work.','the index adds write work'],
  ['I think The index adds write work.','the index adds write work'],
 ]){
  const a={...audit(),criteria:[{...audit().criteria[0],quote}]};
  sequence([{...candidate,evaluation:{outcome:a.outcome,reason:a.reason,criteria:a.criteria}},a,a,{safe:true,coverage:true}]);
  expect(await completeLearning(request(text!))).toMatchObject({ok:true,json:{understood:false,assessment:{status:'provisional'}}});
 }
});

it('withholds the live cookie hint that lists SameSite as a server request check even if a reviewer would approve',async()=>{
 const unsafe={...candidate,intent:'discuss',understood:false,text:'Recall how the browser includes the cookie and what server‑side checks (e.g., CSRF tokens, SameSite, Origin validation) stop CSRF.'};
 const sent=sequence([unsafe,unsafe,{safeTeaching:true}]);
 const r:any=await completeLearning({...request('Another hint please'),current:{...current,prompt:'Do HttpOnly cookies and POST prevent CSRF?'}});
 expect(sent).toHaveLength(2);expect(r.json.text).not.toContain('checks (e.g.');expect(r.json.assessment.status).toBe('provisional');
});

it('requires cookie-sending scope in the actual claim, even if a later sentence mentions SameSite',async()=>{
 for(const text of [
  'The cookie is still attached to the forged POST because HttpOnly only blocks script reads.',
  'HttpOnly does not stop attaching a cookie to any request that matches its domain and path. SameSite also exists.',
 ]){
  const unsafe={...candidate,intent:'discuss',text};const sent=sequence([unsafe,unsafe]);
  const r:any=await completeLearning({...request('Explain this cookie CSRF case.'),current:{...current,prompt:'Do HttpOnly cookies and POST prevent CSRF?'}});
  expect(sent).toHaveLength(2);expect(r.json.text).not.toContain(text);expect(r.json.text).toContain('mode-dependent');
 }
});

it('uses a maintained cookie hint instead of repeating an unsafe model premise, then independently reviews it',async()=>{
 const unsafe={...candidate,intent:'discuss',text:'The cookie is still attached because it exists.'};
 const sent=sequence([unsafe,{safeTeaching:true,outcome:'unassessed',reason:'Scoped concrete hint.',criteria:[]}]);
 const r:any=await completeLearning({...request('Another hint please'),current:{...current,prompt:'Do HttpOnly cookies and POST prevent CSRF?'}});
 expect(r.json.text).toContain('What must the server validate besides the HTTP method');expect(r.json.assessment).toBeUndefined();expect(sent.map(s=>s.model)).toEqual(['openai/gpt-oss-120b','qwen/qwen3.8-27b']);
 expect(JSON.parse(sent[1].messages[1].content).candidate.text).toBe(r.json.text);
});

it('does not expose unchecked technical prose from the blind grader as an assessment reason',async()=>{
 const reason='Browsers always send cookies with a cross-site POST if a session cookie exists.';
 sequence([candidate,{...audit(),reason},{safe:true,coverage:true}]);const r:any=await completeLearning(request());
 expect(r.json.assessment.status).toBe('assessed');expect(r.json.assessment.reason).not.toContain(reason);expect(r.json.assessment.reason).toContain('two source-grounded assessments agree');expect(r.json.text).toBe(candidate.text);
});

it('replaces the live parenthesized server-verification hint while keeping an independently justified assessment',async()=>{
 const bad='POST plus HttpOnly prevents all CSRF.';
 const evaluation={outcome:'incorrect',reason:'HttpOnly and POST alone are insufficient.',criteria:[{criterion:'Recognizes that HttpOnly and POST alone cannot prevent CSRF',quote:bad,state:'contradicted',sourceId:'csrf'}]};
 const hint='CSRF defenses require the server to verify something (e.g., an anti-CSRF token, SameSite attribute, or Origin/Referer check).';
 const sent=sequence([{...candidate,understood:false,text:'HttpOnly restricts script reads; it does not establish request intent.',hint,evaluation},{...audit(),...evaluation},{safe:true,coverage:true}]);
 const r:any=await completeLearning({...request(bad),current:{...current,prompt:'Do HttpOnly cookies and POST prevent CSRF?'}});
 expect(r.json.assessment.outcome).toBe('incorrect');expect(r.json.hint).not.toContain(hint);expect(r.json.hint).toContain('What must the server validate');expect(sent).toHaveLength(3);
});

it('does not scope-check incidental teaching that the lifecycle discards, and advances maintained clues',async()=>{
 const bad='POST plus HttpOnly prevents all CSRF.';
 const evaluation={outcome:'incorrect',reason:'HttpOnly and POST alone are insufficient.',criteria:[{criterion:'Recognizes that HttpOnly and POST alone cannot prevent CSRF',quote:bad,state:'contradicted',sourceId:'csrf'}]};
 const sent=sequence([{...candidate,understood:false,text:'HttpOnly restricts script reads; it does not establish request intent.',teaching:'The cookie is still attached because it exists.',evaluation},{...audit(),...evaluation},{safe:true,coverage:true}]);
 const current={prompt:'Do HttpOnly cookies and POST prevent CSRF?',criteria:['Explain browser and server responsibilities'],grounding:'inference'};
 const r:any=await completeLearning({...request(bad),current});expect(r.json.teaching).toBe('');expect(r.json.assessment.outcome).toBe('incorrect');expect(sent).toHaveLength(3);
 sequence([{...candidate,intent:'discuss',text:'The cookie is still attached because it exists.'},{safeTeaching:true,outcome:'unassessed',criteria:[]}]);
 const next:any=await completeLearning({...request('Another hint please'),current,history:[{message:bad,hint:'An attacker can submit a form using POST too. What must the server validate besides the HTTP method?'}]});
 expect(next.json.text).toContain('token or request-origin check');expect(next.json.assessment).toBeUndefined();
});

it('binds an explicit first-answer review to the locally identified answer without preselecting a grade',async()=>{
 const sent=sequence([{...candidate,intent:'review',reviewTurnId:'first'},audit(),{safe:true,coverage:true}]);
 const r:any=await completeLearning({...request('Please review my first answer.'),current:{...current,prompt:'Why does a TypeScript assertion not validate JSON?'},reviews:[{...current,id:'first',first:true,answer,answerTruncated:false}]});
 expect(r.json).toMatchObject({intent:'review',reviewTurnId:'first',assessment:{status:'assessed',outcome:'understood'}});
 const schema=sent[0].response_format.json_schema.schema.properties;
 expect(schema.intent.enum).toEqual(['review']);expect(schema.reviewTurnId.enum).toEqual(['first']);expect(schema.evaluation.properties.outcome.enum).toContain('incorrect');
});

it('does not accept a clarification menu or a different answer in place of the explicitly selected review',async()=>{
 const sent=sequence([{...menu,text:'Which answer would you like reviewed?'}]);
 const r:any=await completeLearning({...request('Please review my first answer.'),reviews:[{...current,id:'first',first:true,answer,answerTruncated:false}]});
 expect(r.json).toMatchObject({intent:'review',reviewTurnId:'first',assessment:{status:'provisional'}});expect(r.json.text).not.toContain('Which answer');expect(sent).toHaveLength(1);
});

it('replaces the live XSS advice that treated CSRF tokens and SameSite as protection against injected same-origin actions',async()=>{
 const text='An XSS payload can cause requests if the server lacks proper CSRF checks. Defenses must include CSRF tokens or SameSite settings to stop the unwanted actions.';
 const sent=sequence([{...candidate,intent:'discuss',text},{safeTeaching:true,outcome:'unassessed',criteria:[],reason:'Reviewed the maintained example.'}]);
 const r:any=await completeLearning({...request('Could XSS still perform actions even when JavaScript cannot read the HttpOnly cookie?'),current:{...current,prompt:'Why does a TypeScript assertion not validate JSON?'}});
 expect(r.json.text).not.toContain(text);expect(r.json.text).toContain('XSS can undermine CSRF defenses');expect(r.json.text).toContain('eligible request');expect(r.json.assessment).toBeUndefined();expect(sent).toHaveLength(2);expect(JSON.parse(sent[1].messages[1].content).candidate.text).toBe(r.json.text);
});

it('does not accept a reviewer that grades the tutor explanation as learner understanding during discussion',async()=>{
 const text='A SELECT FOR UPDATE on the absent slot ensures only one transaction can insert it.';
 sequence([{...candidate,intent:'discuss',text},{...audit(),outcome:'understood',safeTeaching:true}]);
 const r:any=await completeLearning({...request('Explain this concurrency case.'),current:{...current,prompt:'Does a transaction prevent a check-then-insert race?'}});
 expect(r.json.text).not.toContain(text);expect(r.json.text).toContain('Atomicity');expect(r.json.assessment.status).toBe('provisional');
});

it('keeps inconclusive authorization feedback focused on permission checks rather than the first lexical CSRF reference',async()=>{
 const bad='Hiding the button and enabling CORS ensures authenticated users can access only resources they own.';
 const missing={outcome:'incorrect',reason:'Missing the mechanism.',criteria:[{criterion:'Explains bypassing client controls and server permission checks',state:'missing',quote:'',sourceId:'authorization'}]};
 sequence([{...candidate,understood:false,text:'An unchecked correction.',evaluation:missing},missing,{...audit(),outcome:'incorrect',criteria:[{...missing.criteria[0],state:'contradicted',quote:bad}]},{safe:true,coverage:true}]);
 const r:any=await completeLearning({...request(bad),current:{...current,prompt:'Why must the server authorize a resource operation when the client hides its button?'}});
 expect(r.json.assessment.status).toBe('provisional');expect(r.json.text).toContain('CORS governs browser');expect(r.json.text).toContain('server-side authentication/authorization');expect(r.json.text).not.toContain('POST-only endpoints alone');
});

it('does not mistake the live negated guarantee with typographic contractions for a positive guarantee',async()=>{
 const {unqualifiedGuarantee}=await import('./semantic-tutor.js');
 for(const text of ['Virtual nodes don’t guarantee identical load.','Virtual nodes do not guarantee identical load.','Jitter won’t guarantee delivery.'])expect(unqualifiedGuarantee({text})).toBe(false);
 expect(unqualifiedGuarantee({text:'Virtual nodes guarantee identical load.'})).toBe(true);
});
