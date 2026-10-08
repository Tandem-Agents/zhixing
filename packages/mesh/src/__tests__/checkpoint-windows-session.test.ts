import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckpointDirectoryHandle, checkpointFilesystemCompletion } from '../checkpoint-child-bridge.js';
import { verifyCheckpointBridgeArtifactAsync } from '../checkpoint-bridge-artifact.js';

vi.mock('../checkpoint-bridge-artifact.js', async original => ({
  ...await original<object>(), verifyCheckpointBridgeArtifactAsync: vi.fn(async () => 'fixture-helper.exe'),
}));

function fixture() {
  const sent: unknown[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    ref: vi.fn(), unref: vi.fn(), kill: vi.fn(() => true),
  });
  child.stdin.on('data', data => sent.push(JSON.parse(data.toString())));
  const factory = vi.fn(() => child);
  return { child, sent, factory };
}
afterEach(() => { vi.useRealTimers(); vi.mocked(verifyCheckpointBridgeArtifactAsync).mockReset().mockResolvedValue('fixture-helper.exe'); });

describe.skipIf(process.platform !== 'win32')('owned Windows filesystem lifetime', () => {
  it('bounds a lost control connection without releasing physical work on a kill request', async () => {
    vi.useFakeTimers();
    const f = fixture(), session = CheckpointDirectoryHandle.createWindowsSession(5000, f.factory);
    const operation = session.openPath('fixture', false).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    f.child.emit('error', Error('control disconnected'));
    const closing = session.close(20).catch(error => error);
    let ended = false;
    await vi.advanceTimersByTimeAsync(21);
    expect(await closing).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    const failure = await operation;
    expect(failure.message).toBe('control disconnected');
    const completion = checkpointFilesystemCompletion(failure)!;
    expect(completion).toBeInstanceOf(Promise);
    void completion.then(() => { ended = true; });
    await Promise.resolve(); expect(ended).toBe(false);
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await expect(session.openPath('late', false)).rejects.toThrow('control disconnected');
    expect(f.factory).toHaveBeenCalledOnce();
    f.child.emit('close', null, 'SIGKILL'); await completion;
    expect(ended).toBe(true);
  });

  it('keeps a timed-out operation pending until actual close within the close budget', async () => {
    vi.useFakeTimers();
    const f = fixture(), session = CheckpointDirectoryHandle.createWindowsSession(50, f.factory);
    let settled = false;
    const operation = session.openPath('fixture', false).catch(error => { settled = true; return error; });
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBe(false); expect(f.child.kill).toHaveBeenCalledOnce();
    f.child.emit('close', null, 'SIGKILL');
    expect(await operation).toMatchObject({ code: 'ETIMEDOUT' });
    await session.close();
  });

  it('bounds verification and prevents a late verified helper from starting', async () => {
    vi.useFakeTimers();
    let verified!: (path: string) => void;
    vi.mocked(verifyCheckpointBridgeArtifactAsync).mockImplementationOnce(() => new Promise(resolve => { verified = resolve; }));
    const f = fixture(), session = CheckpointDirectoryHandle.createWindowsSession(20, f.factory);
    const operation = session.openPath('fixture', false).catch(error => error);
    await vi.advanceTimersByTimeAsync(21);
    const closing = session.close(10).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await closing).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    const failure = await operation;
    expect(failure).toMatchObject({ code: 'ETIMEDOUT' });
    const completion = checkpointFilesystemCompletion(failure)!;
    let ended = false; void completion.then(() => { ended = true; });
    await Promise.resolve(); expect(ended).toBe(false);
    verified('late-helper.exe'); await completion;
    expect(f.factory).not.toHaveBeenCalled(); expect(ended).toBe(true);
  });

  it('only shortens the original close budget', async () => {
    vi.useFakeTimers();
    const f = fixture(), session = CheckpointDirectoryHandle.createWindowsSession(5000, f.factory);
    const operation = session.openPath('fixture', false).catch(error => error);
    await vi.advanceTimersByTimeAsync(0);
    const closing = session.close(500).catch(error => error);
    const shorter = session.close(10).catch(error => error);
    const longer = session.close(1000).catch(error => error);
    await vi.advanceTimersByTimeAsync(11);
    expect(await closing).toMatchObject({ code: 'ERR_CHECKPOINT_OWNER_EXIT_UNCONFIRMED' });
    expect(await shorter).toBe(await closing); expect(await longer).toBe(await closing);
    await operation; f.child.emit('close', null, 'SIGKILL');
  });
});
