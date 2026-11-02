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

it('waits for a picker deletion and then reloads the candidates with the result', async () => {
  const f = fixture(); f.edit('/resume ');
  const first = f.calls[0]!;
  if (first.action.kind !== 'input-candidates') throw Error('unexpected action');
  first.resolve({ revision: first.action.revision, active: true, start: 8, end: 8, mode: 'picker', canDelete: true,
    items: [{ id: 'chat-a', label: '对话甲' }, { id: 'chat-b', label: '对话乙' }] });
  await Promise.resolve();
  expect(f.session.confirmDelete(1)).toBe(false); expect(f.session.confirmDelete(1)).toBe(true);
  const deleting = f.session.manage('delete');
  expect(f.session.busy).toBe(true);
  const manage = f.calls[1]!;
  expect(manage.action).toMatchObject({ kind: 'candidate-manage', action: 'delete', id: 'chat-a' });
  // 删除结束（宿主回复）之前不重新取候选
  expect(f.calls).toHaveLength(2);
  manage.resolve({ accepted: true, deleted: true });
  await expect(deleting).resolves.toBe(true);
  expect(f.session.busy).toBe(false);
  expect(f.calls[2]?.action.kind).toBe('input-candidates');
  // 重取后停在原位置（原第一项已删，落到新的第一项），不是任意跳动
  const reload = f.calls[2]!;
  if (reload.action.kind !== 'input-candidates') throw Error('unexpected action');
  reload.resolve({ revision: reload.action.revision, active: true, start: 8, end: 8, mode: 'picker', canDelete: true, items: [{ id: 'chat-b', label: '对话乙' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(f.session.selected).toBe(0);
});

it('returns the selection to the renamed item when the list comes back after the rename page', async () => {
  const f = fixture(); f.edit('/work ');
  const first = f.calls[0]!;
  if (first.action.kind !== 'input-candidates') throw Error('unexpected action');
  first.resolve({ revision: first.action.revision, active: true, start: 6, end: 6, mode: 'picker', canRename: true,
    items: [{ id: 'scene-a', label: '甲' }, { id: 'scene-b', label: '乙' }] });
  await Promise.resolve();
  f.session.move(1);
  const renaming = f.session.manage('rename');
  // 改名页占用界面期间候选不活跃，回来后同一份草稿重新取候选（同步会把选中项归零）
  f.session.sync(false); f.session.sync(true);
  expect(f.session.selected).toBe(0);
  const reload = f.calls.find((call, index) => index > 0 && call.action.kind === 'input-candidates')!;
  if (reload.action.kind !== 'input-candidates') throw Error('unexpected action');
  reload.resolve({ revision: reload.action.revision, active: true, start: 6, end: 6, mode: 'picker', canRename: true,
    items: [{ id: 'scene-a', label: '甲' }, { id: 'scene-b', label: '乙改' }] });
  await Promise.resolve(); await Promise.resolve();
  expect(f.session.selected).toBe(1); expect(f.session.value?.items[f.session.selected]?.id).toBe('scene-b');
  f.calls.find(call => call.action.kind === 'candidate-manage')!.resolve({ accepted: true });
  await expect(renaming).resolves.toBe(false);
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
