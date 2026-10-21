/** Small, explicit teaching models, not claims about a project's runtime. */
export type OutboxEvent='commit'|'send'|'receive'|'sender-crash'|'retry'|'record-sent';
export interface OutboxState {businessCommitted:boolean;intentCommitted:boolean;sentRecorded:boolean;deliveries:number;receiverKey:boolean;receiverEffects:number}
export const emptyOutbox=():OutboxState=>({businessCommitted:false,intentCommitted:false,sentRecorded:false,deliveries:0,receiverKey:false,receiverEffects:0});
export function outboxStep(state:OutboxState,event:OutboxEvent):OutboxState{
 const next={...state};
 if(event==='commit'){next.businessCommitted=true;next.intentCommitted=true;}
 if(event==='send'||event==='retry'){
  if(!state.businessCommitted||!state.intentCommitted)throw Error('Commit local business state and intent before sending.');
  next.deliveries++;
 }
 if(event==='receive'){
  if(!state.deliveries)throw Error('No message sent.');
  // ASSUMPTION: this receiver coordinates a stable key, concurrency and its own DB effect.
  if(!state.receiverKey){next.receiverKey=true;next.receiverEffects++;}
 }
 if(event==='record-sent')next.sentRecorded=true;
 // A sender crash changes neither component's committed state in this model.
 return next;
}
export function outboxTrace(){
 let state=emptyOutbox();return (['commit','send','receive','sender-crash','retry','receive'] as OutboxEvent[]).map(event=>({event,state:state=outboxStep(state,event)}));
}
export function outboxWorkedExample(){
 const labels:Record<OutboxEvent,string>={commit:'Sender atomically commits the business row and intent M',send:'Relay sends M',receive:'Receiver handles M with enforced durable deduplication', 'sender-crash':'Sender crashes before recording the successful send',retry:'Relay retries the same M','record-sent':'Relay records send status'};
 return `Hypothetical direct delivery. Assumptions: the receiver atomically coordinates stable key M with its own database effect, handles concurrent duplicates, and retains M for these retries. No uncoordinated third-party charge is inside that transaction.\n${outboxTrace().map((step,i)=>`${i+1}. ${labels[step.event]}. Sender business/intent: ${step.state.intentCommitted?'committed':'absent'}; sent status: ${step.state.sentRecorded?'recorded':'not recorded'}; receiver key: ${step.state.receiverKey?'present':'absent'}; receiver effects: ${step.state.receiverEffects}.`).join('\n')}\nThe sender crash leaves the receiver key and effect intact. Duplicate delivery does not add an effect under these assumptions. Without receiver enforcement, duplicate effects remain possible. Eventual delivery depends on recovery, retries and availability. Broker publish acceptance and consumer acknowledgement are separate from this direct-delivery example.`;
}
export type SameSiteMode='Strict'|'Lax'|'None'|'omitted';
export type RequestKind='same-site'|'cross-site-top-level-GET'|'cross-site-top-level-POST'|'cross-site-subresource';
/** SameSite eligibility ONLY: assume a matching HTTPS cookie and no other blocking policy. */
export function sameSiteAllows(mode:SameSiteMode,request:RequestKind):boolean|'browser-dependent'{
 if(request==='same-site')return true;
 if(mode==='omitted')return 'browser-dependent';
 return mode==='None'||mode==='Lax'&&request==='cross-site-top-level-GET';
}
export function cookieWorkedExample(){
 const requests:RequestKind[]=['same-site','cross-site-top-level-GET','cross-site-top-level-POST','cross-site-subresource'];
 const rows=(['Strict','Lax','None','omitted'] as SameSiteMode[]).map(mode=>`${mode}: ${requests.map(r=>{const allowed=sameSiteAllows(mode,r);return `${r.replaceAll('-', ' ')} ${allowed===true?'eligible':allowed===false?'excluded':allowed}`;}).join('; ')}.`);
 return `Hypothetical cookie-policy comparison. Assume a matching HTTPS cookie, valid lifetime, eligible request credentials and no other blocking policy. Each row is a separately labeled mode, not a silent mode change.\n\n${rows.join('\n')}\n\nExplicit Lax requires BOTH top-level navigation and a safe method for the cross-site exception. None requires Secure. Omitted SameSite is not universally None or explicit Lax; some browser defaults allow recent-cookie POSTs. Under Strict a cross-site GET does not carry the cookie. Under Lax a top-level GET can, so GET must not perform unsafe state changes. HttpOnly and POST-only endpoints are not complete CSRF defenses: use appropriate server-side token/origin defenses. This table models SameSite eligibility, not proof that a real request will include a cookie or that a project is secure.`;
}
