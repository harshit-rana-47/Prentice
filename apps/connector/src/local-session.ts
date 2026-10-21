/** Compare identity only after the cloud has verified the incoming token and account.
 * This is not JWT signature verification and must never authorize a request on its own.
 */
export function sameVerifiedSignIn(previous: string, incoming: string): boolean {
  if (!previous || !incoming) return false;
  if (previous === incoming) return true;
  try {
    const before = JSON.parse(Buffer.from(previous.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string; session_id?: string };
    const after = JSON.parse(Buffer.from(incoming.split('.')[1] ?? '', 'base64url').toString()) as { sub?: string; session_id?: string };
    return typeof before.sub === 'string' && before.sub.length > 0 && before.sub === after.sub
      && typeof before.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(before.session_id) && before.session_id === after.session_id;
  } catch { return false; }
}
