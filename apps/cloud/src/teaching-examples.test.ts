import {expect,it} from 'vitest';
import {emptyOutbox,outboxStep,outboxTrace,outboxWorkedExample,sameSiteAllows,cookieWorkedExample} from './teaching-examples.js';
it('requires local business/intent commit before relay send and preserves receiver state across sender death',()=>{
 expect(()=>outboxStep(emptyOutbox(),'send')).toThrow();expect(()=>outboxStep(emptyOutbox(),'retry')).toThrow();
 const trace=outboxTrace();const received=trace[2].state;const crashed=trace[3].state;const retried=trace[5].state;
 expect(received).toMatchObject({businessCommitted:true,intentCommitted:true,receiverKey:true,receiverEffects:1});
 expect(crashed).toEqual(received);expect(retried).toMatchObject({deliveries:2,receiverKey:true,receiverEffects:1});
 expect(outboxWorkedExample()).toContain('No uncoordinated third-party');
});
it('keeps explicit SameSite modes separate for cross-site requests',()=>{
 expect(sameSiteAllows('Strict','cross-site-top-level-GET')).toBe(false);
 expect(sameSiteAllows('Lax','cross-site-top-level-GET')).toBe(true);
 for(const request of ['cross-site-top-level-POST','cross-site-subresource'] as const){expect(sameSiteAllows('Lax',request)).toBe(false);expect(sameSiteAllows('None',request)).toBe(true);}
 expect(sameSiteAllows('omitted','cross-site-top-level-POST')).toBe('browser-dependent');
 expect(cookieWorkedExample()).toContain('requires Secure');expect(cookieWorkedExample()).toContain('POST-only');
});
