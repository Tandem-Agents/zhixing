import { expect, it } from 'vitest';
import { TerminalCandidateSession } from '../candidate-session.js';
import { TerminalInputSession } from '../input-session.js';
import type { TerminalAction } from '../protocol.js';

function fixture() {
  const calls: { action: TerminalAction; resolve(value: unknown): void; reject(error: Error): void }[] = [];
  const input = new TerminalInputSession(async () => ({}), () => {});
  const session = new TerminalCandidateSession(input, action => new Promise((resolve, reject) => calls.push({ action, resolve, reject })), () => {});
  const edit = (text: string) => { input.edit(text, text.length); session.sync(); };
  const settle = async (index: number, items: { id: string; label: string }[] = []) => {
    const call = calls[index]!;
    if (call.action.kind !== 'input-candidates') throw Error('unexpected action');
    call.resolve({ revision: call.action.revision, active: true, start: 0, end: call.action.text.length, items });
    await Promise.resolve();
  };
  return { calls, input, session, edit, settle };
}

it('retains one open candidate session across loading, empty results and failures without accepting stale choices', async () => {
  const f = fixture(); f.edit('/');
  expect(f.session.open).toBe(true); expect(f.session.loading).toBe(true);
  await f.settle(0, [{ id: 'work', label: '/work' }]);
  f.edit('/no-match');
  expect(f.session.open).toBe(true); expect(f.session.value).toBeUndefined();
  expect(await f.session.accept()).toBe(false);
  await f.settle(1);
  expect(f.session.open).toBe(true); expect(f.session.loading).toBe(false);
  f.edit('/retry'); f.calls[2]!.reject(Error('provider failed')); await Promise.resolve();
  expect(f.session.open).toBe(true); expect(f.session.loading).toBe(false); expect(f.session.error).toBeTruthy();
  f.session.refresh(); await f.settle(3, [{ id: 'work', label: '/work' }]);
  expect(f.session.error).toBeUndefined(); expect(f.session.value?.items).toHaveLength(1);
});

it('rejects late results after leaving the candidate interaction', async () => {
  const f = fixture(); f.edit('/work'); f.session.sync(false); await f.settle(0, [{ id: 'work', label: '/work' }]);
  expect(f.session.open).toBe(false); expect(f.session.value).toBeUndefined();
  expect(await f.session.accept()).toBe(false); expect(f.input.draft.text).toBe('/work');
});

it('turns an invalid current result into a retryable state instead of an endless spinner', async () => {
  const f = fixture(); f.edit('/'); f.calls[0]!.resolve({ revision: 999, items: [] }); await Promise.resolve();
  expect(f.session.loading).toBe(false); expect(f.session.error).toBeTruthy(); expect(f.session.value).toBeUndefined();
});
