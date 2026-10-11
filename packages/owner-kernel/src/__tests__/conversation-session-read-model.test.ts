import path from 'node:path';
import { FileArtifactStore, FileAuthorityCommitLog, type DurableLogCheckpoint } from '@zhixing/core/authority';
import { acquireFileLock } from '@zhixing/core/persistence';
import { isHoldingMaintenanceExclusion } from '@zhixing/core/resources';
import { createTempDir } from '@zhixing/test-utils';
import { expect, it, vi } from 'vitest';
import { ConversationSessionReadModel } from '../conversation-session-read-model.js';
import type { ConversationReadIndex } from '../conversation-read-index.js';
import { trackAuthorityLog, DURABLE_IO_TEST_TIMEOUT_MS } from './durable-io-test-support.js';

type State = { domainRevision: number; values: number[] };
async function fixture() {
  const root = await createTempDir('session-read-model');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const log = trackAuthorityLog(new FileAuthorityCommitLog(path.join(root, 'log'), artifacts));
  const positions: DurableLogCheckpoint[] = [];
  // Directory locators are fixed to real WAL positions; no Authority IO is mocked.
  const sessionPage = vi.fn(async (_id: string, after: number) => positions.filter(position => position.lsn > after).slice(0, 64));
  const reduce = vi.fn(async (state: State, record: { body: unknown }) => {
    expect(isHoldingMaintenanceExclusion()).toBe(false);
    state.domainRevision++;
    state.values.push((record.body as { value: number }).value);
    return state;
  });
  const model = new ConversationSessionReadModel(log, { sessionPage } as unknown as ConversationReadIndex,
    'conv-1', () => ({ domainRevision: 0, values: [] } as State), reduce);
  const append = async (value: number) => {
    await log.append([{ stream: 'run:conv-1', body: { t: 'session-control', value } }]);
    positions.push(await log.checkpoint());
  };
  const read = () => model.read(state => [...state.values]);
  return { log, model, append, read, sessionPage, reduce };
}

it('keeps an unchanged session view without a writer claim or a second fold', async () => {
  const { log, append, read, sessionPage, reduce } = await fixture();
  await append(1);
  expect(await read()).toEqual([1]);
  const release = await acquireFileLock(path.join(log.rootDir, '.commit-log.lock'), { staleMs: 30_000, waitMs: 100 });
  try { expect(await read()).toEqual([1]); }
  finally { await release(); }
  expect(sessionPage).toHaveBeenCalledTimes(1);
  expect(reduce).toHaveBeenCalledTimes(1);
  await append(2);
  expect(await read()).toEqual([1, 2]);
  expect(reduce).toHaveBeenCalledTimes(2);
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('invalidates a retained view when an imported base changes, even at the same WAL head', async () => {
  const { model, append, read } = await fixture();
  await append(1);
  expect(await read()).toEqual([1]);
  model.installBase([{ lsn: 1, at: '2026-10-11T00:00:00.000Z', stream: 'run:conv-1', body: { t: 'session-control', value: 7 } }]);
  expect(await read()).toEqual([7, 1]);
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('does not publish a stale fold over a concurrent newer view', async () => {
  const { model, append, read, reduce } = await fixture();
  await append(1);
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  reduce.mockImplementationOnce(async (state, record) => {
    entered(); await hold;
    state.domainRevision++;
    state.values.push((record.body as { value: number }).value);
    return state;
  });
  const older = read();
  await started;
  await append(2);
  expect(await read()).toEqual([1, 2]);
  resume();
  expect(await older).toEqual([1, 2]);
  expect(await model.read(state => state.domainRevision)).toBe(2);
}, DURABLE_IO_TEST_TIMEOUT_MS);

it('discards an in-flight old base and retries against the installed generation', async () => {
  const { model, append, read, reduce } = await fixture();
  await append(1);
  let resume!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { resume = resolve; });
  reduce.mockImplementationOnce(async (state, record) => {
    entered(); await hold;
    state.domainRevision++;
    state.values.push((record.body as { value: number }).value);
    return state;
  });
  const pending = read();
  await started;
  model.installBase([{ lsn: 1, at: '2026-10-11T00:00:00.000Z', stream: 'run:conv-1', body: { t: 'session-control', value: 9 } }]);
  resume();
  expect(await pending).toEqual([9, 1]);
}, DURABLE_IO_TEST_TIMEOUT_MS);
