import path from 'node:path';
import { appendFile, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { expect, it, onTestFinished } from 'vitest';
import { createTempDir } from '@zhixing/test-utils';
import { acquireFileLock } from '../../persistence/file-lock.js';
import { FileAuthorityCommitLog } from '../commit-log.js';
import { FileArtifactStore } from '../artifact-store.js';

async function fixture() {
  const root = await createTempDir('checkpoint-read-view');
  const artifacts = new FileArtifactStore(path.join(root, 'artifacts'));
  const makeLog = () => {
    const log = new FileAuthorityCommitLog(path.join(root, 'authority'), artifacts);
    onTestFinished(() => log.stopStorageMaintenance());
    return log;
  };
  return { log: makeLog(), makeLog };
}

it('keeps an issued read head without a writer claim, then sees a peer append', async () => {
  const { log, makeLog } = await fixture();
  await log.append([{ stream: 'control', body: { value: 1 } }]);
  const first = await log.checkpoint();
  const release = await acquireFileLock(path.join(log.rootDir, '.commit-log.lock'), { staleMs: 30_000, waitMs: 100 });
  try { expect(await log.checkpoint(first)).toBe(first); }
  finally { await release(); }
  await makeLog().append([{ stream: 'control', body: { value: 2 } }]);
  const second = await log.checkpoint(first);
  expect(second).not.toBe(first);
  expect(second.lsn).toBe(2);
  expect(await log.checkpoint(second)).toBe(second);
  expect((await log.readEnvelopeAt(first)).entries[0]!.body).toEqual({ value: 1 });
});

it('keeps proof ownership local and makes issued checkpoint fields immutable', async () => {
  const { log, makeLog } = await fixture();
  await log.append([{ stream: 'control', body: { value: 1 } }]);
  const first = await log.checkpoint();
  expect(Object.isFrozen(first)).toBe(true);
  expect(Reflect.set(first, 'lsn', 999)).toBe(false);
  expect(Reflect.set(first, 'prefixDigest', 'sha256:' + '0'.repeat(64))).toBe(false);
  const copied = { ...first };
  const refreshed = await log.checkpoint(copied);
  expect(refreshed).not.toBe(copied);
  expect(refreshed).toEqual(first);
  const forged = { ...first, lsn: 999, prefixDigest: 'sha256:' + '0'.repeat(64) };
  expect(await log.checkpoint(forged)).toEqual(first);
  expect(await makeLog().checkpoint(first)).not.toBe(first);
});

it.each(['corrupt', 'replacement'])('never preserves a read view over %s bytes with a restored mtime', async mode => {
  const { log } = await fixture();
  await log.append([{ stream: 'control', body: { text: 'original' } }]);
  const first = await log.checkpoint();
  const metadata = await stat(log.logPath);
  const bytes = await readFile(log.logPath);
  bytes[bytes.indexOf(Buffer.from('original'))] ^= 1;
  if (mode === 'replacement') {
    await writeFile(log.logPath + '.replacement', bytes);
    await rename(log.logPath + '.replacement', log.logPath);
  } else await writeFile(log.logPath, bytes);
  await utimes(log.logPath, metadata.atime, metadata.mtime);
  await expect(log.checkpoint(first)).rejects.toBeInstanceOf(Error);
});

it('recovers an incomplete tail through the original path instead of reusing the old object', async () => {
  const { log } = await fixture();
  await log.append([{ stream: 'control', body: { value: 1 } }]);
  const first = await log.checkpoint();
  await appendFile(log.logPath, Buffer.from([1, 2, 3]));
  const next = await log.checkpoint(first);
  expect(next).not.toBe(first);
  expect(next).toEqual(first);
  expect((await stat(log.logPath)).size).toBe(first.frameEndOffset);
});

it('cannot return a vanished source as an unchanged read view', async () => {
  const { log } = await fixture();
  await log.append([{ stream: 'control', body: { value: 1 } }]);
  const first = await log.checkpoint();
  await unlink(log.logPath);
  // The normal checkpoint path may report an empty source or fail recovery;
  // either way the old committed source must never be presented as unchanged.
  const outcome = await log.checkpoint(first).then(value => ({ value }), error => ({ error }));
  if ('value' in outcome) {
    expect(outcome.value).not.toBe(first);
    expect(outcome.value.lsn).toBe(0);
  } else expect(outcome.error).toBeInstanceOf(Error);
  await expect(log.readEnvelopeAt(first)).rejects.toBeInstanceOf(Error);
});
