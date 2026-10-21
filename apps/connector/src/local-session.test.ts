import { expect, it } from 'vitest';
import { sameVerifiedSignIn } from './local-session.js';
const jwt = (body: unknown) => `header.${Buffer.from(JSON.stringify(body)).toString('base64url')}.signature`;
const identity = { sub: 'account-a', session_id: '00000000-0000-4000-8000-000000000001' };
it('preserves a verified sign-in across JWT refresh, but isolates different users and login sessions', () => {
  const before = jwt({ ...identity, exp: 1 });
  expect(sameVerifiedSignIn(before, jwt({ ...identity, exp: 2 }))).toBe(true);
  expect(sameVerifiedSignIn(before, jwt({ ...identity, sub: 'account-b' }))).toBe(false);
  expect(sameVerifiedSignIn(before, jwt({ ...identity, session_id: '00000000-0000-4000-8000-000000000002' }))).toBe(false);
  expect(sameVerifiedSignIn(before, jwt({ sub: 'account-a' }))).toBe(false);
  expect(sameVerifiedSignIn('invalid', 'other')).toBe(false);
  expect(sameVerifiedSignIn('', '')).toBe(false);
});
