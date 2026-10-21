import { expect, it, vi } from 'vitest';
import { runtimeFetch, type LocalSession } from './prentice';

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
it('shares simultaneous relay reads but fetches again after completion', async () => {
  const read = deferred(); const call = vi.fn().mockReturnValueOnce(read.promise).mockResolvedValue({ fresh: true });
  const session: LocalSession = { token: 'test', runtimeUrl: '', call };
  const first = runtimeFetch(session, '/v1/workspace'); const second = runtimeFetch(session, '/v1/workspace');
  expect(call).toHaveBeenCalledTimes(1);
  read.resolve({ tree: [] }); expect(await first).toEqual(await second);
  expect(await runtimeFetch(session, '/v1/workspace')).toEqual({ fresh: true }); expect(call).toHaveBeenCalledTimes(2);
});
it('does not reuse a read started before a project selection, or let it erase the new pending read', async () => {
  const old = deferred(); const current = deferred();
  const call = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ok: true }).mockReturnValueOnce(current.promise);
  const session: LocalSession = { token: 'test', runtimeUrl: '', call };
  const before = runtimeFetch(session, '/v1/tasks/latest');
  await runtimeFetch(session, '/v1/project', { method: 'POST', body: '{}' });
  const after = runtimeFetch(session, '/v1/tasks/latest');
  old.resolve({ project: 'old' }); await before;
  const same = runtimeFetch(session, '/v1/tasks/latest'); expect(call).toHaveBeenCalledTimes(3);
  current.resolve({ project: 'new' }); expect(await after).toEqual({ project: 'new' }); expect(await same).toEqual({ project: 'new' });
});
it('isolates sessions, keeps mutations independent and retries failed reads', async () => {
  const call = vi.fn().mockRejectedValueOnce(Error('offline')).mockResolvedValue({ ok: true });
  const one: LocalSession = { token: 'one', runtimeUrl: '', call }; const two = { ...one, token: 'two' };
  await expect(runtimeFetch(one, '/v1/projects')).rejects.toThrow('offline');
  await Promise.all([runtimeFetch(one, '/v1/projects'), runtimeFetch(two, '/v1/projects')]);
  await Promise.all([runtimeFetch(one, '/v1/home/pin', { method: 'POST' }), runtimeFetch(one, '/v1/home/pin', { method: 'POST' })]);
  expect(call).toHaveBeenCalledTimes(5);
});
it('does not share requests with independent cancellation', async () => {
  const call = vi.fn().mockResolvedValue({ ok: true }); const session: LocalSession = { token: 'test', runtimeUrl: '', call };
  await Promise.all([runtimeFetch(session, '/v1/projects', { signal: new AbortController().signal }), runtimeFetch(session, '/v1/projects', { signal: new AbortController().signal })]);
  expect(call).toHaveBeenCalledTimes(2);
});
