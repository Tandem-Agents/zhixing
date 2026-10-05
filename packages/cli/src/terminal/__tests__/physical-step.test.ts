import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { DeviceCapacityArbiterPort } from '@zhixing/core/resources';
import type { CheckpointFilesystemSession } from '@zhixing/mesh/filesystem';
import { ownedPosixFilesystem } from '../../../../mesh/src/checkpoint-posix-session.js';

vi.mock('@zhixing/mesh/filesystem', async () => {
  const module = await import('../../../../mesh/src/checkpoint-posix-session.js');
  return { checkpointFilesystemCompletion: module.checkpointFilesystemCompletion, CheckpointDirectoryHandle: {} };
});
import { terminalMetadataStep, terminalPhysicalStep } from '../physical-step.js';
import { TerminalManagedFiles } from '../managed-files.js';

afterEach(() => vi.useRealTimers());
describe('terminal delegated physical completion', () => {
  it('seals queued file work and notifies the existing close owner once on an unconfirmed effect', async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), ref() {}, unref() {}, kill() { return true; } });
    const owner = ownedPosixFilesystem(10, async () => '/fixture', () => child);
    const directory = { identity: '1:1', close: async () => {}, openDirectory: async () => directory, writeAt: async () => owner.request('writeAt', {}) };
    const session = { openPath: async () => directory, close: owner.stop } as unknown as CheckpointFilesystemSession;
    const notify = vi.fn(), queued = vi.fn();
    const files = new TerminalManagedFiles('/fixture', undefined, session, notify);
    try {
      const first = files.runOperation(() => files.write('input/one', Buffer.from('x'), 0, 1, { claim() {}, complete() {} })).catch(error => error);
      const second = files.runOperation(async () => { queued(); }).catch(error => error);
      await vi.advanceTimersByTimeAsync(1010);
      expect(await first).toMatchObject({ code: 'ETIMEDOUT' });
      expect(await second).toMatchObject({ message: 'terminal-files-unconfirmed' });
      expect(notify).toHaveBeenCalledOnce(); expect(queued).not.toHaveBeenCalled();
      await expect(files.runOperation(async () => {})).rejects.toThrow('admission');
    } finally {
      child.emit('close', 137, null); await files.close().catch(() => {});
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });

  it.each([true, false])('returns a permit only after actual helper close (close on kill=%s)', async closeOnKill => {
    vi.useFakeTimers();
    const events: string[] = [];
    let exited = false;
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), ref() {}, unref() {},
      kill() { events.push('kill'); if (closeOnKill) queueMicrotask(actualClose); return true; },
    });
    function actualClose() { exited = true; events.push('close'); child.emit('close', 137, null); }
    const session = ownedPosixFilesystem(10, async () => '/fixture', () => child);
    const capacity = { async acquire() { return { kind: 'granted', permit: {
      tryBegin() { return { claim() {}, complete() { events.push(`complete:${exited}`); } }; },
      release() { events.push(`release:${exited}`); },
    } }; } } as DeviceCapacityArbiterPort;
    try {
      const operation = terminalPhysicalStep(capacity, terminalMetadataStep, new AbortController().signal,
        async () => session.request('identity', { handle: 1 })).catch(error => error);
      await vi.advanceTimersByTimeAsync(1010);
      expect(await operation).toMatchObject({ code: 'ETIMEDOUT' });
      if (!closeOnKill) {
        expect(events).toEqual(['kill']);
        await expect(session.request('identity', { handle: 1 })).rejects.toThrow();
        actualClose(); await vi.advanceTimersByTimeAsync(0);
      }
      expect(events).toEqual(['kill', 'close', 'complete:true', 'release:true']);
    } finally {
      if (!exited) actualClose();
      await session.stop().catch(() => {});
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
    }
  });
});
