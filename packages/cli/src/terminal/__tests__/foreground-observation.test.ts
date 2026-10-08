import { describe, expect, it, vi } from 'vitest';
import { TerminalForegroundChild, type TerminalForegroundProcesses } from '../foreground-process.js';

function fixture(created = true, throwing = false) {
  const state = { ready: true, created, resumed: false, cancelled: false, creationExited: false, exited: false,
    pid: created ? 42 : 0, error: created ? 0 : 87, birth: '42', nativeQueueMs: 4, nativeSetupMs: 5,
    nativeCreateMs: 70, nativePublishMs: 1, nativeTotalMs: 80, observationMs: 3 };
  const observer = vi.fn(() => { if (throwing) throw Error('observer-failed'); });
  const native = { create: vi.fn(() => 1), createPosix: vi.fn(() => 1), observe: () => state };
  const owner = { sealed: false, native, children: new Set(), requestObservation() {} } as unknown as TerminalForegroundProcesses;
  const child = new TerminalForegroundChild(owner, false, { pipeEnvironment: false, observeCreation: observer });
  child.on('error', () => {});
  return { child, observer, native };
}

describe('foreground creation observations', () => {
  it('publishes one finite native breakdown without environment, path or command payloads', async () => {
    const { child, observer } = fixture();
    await child.start('private-path', ['private-command'], { SECRET: 'private-value' }, false);
    child.poll(); child.poll(); await expect(child.created).resolves.toBeUndefined();
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]).toEqual([expect.objectContaining({ nativeCreateMs: 70, nativeTotalMs: 80, observationMs: 3, errorCode: 0 }), 'success']);
    expect(JSON.stringify(observer.mock.calls)).not.toContain('private-');
    child.disposeTransport();
  });
  it('keeps a failed creation failed and preserves its native error code', async () => {
    const { child, observer } = fixture(false);
    await child.start('fixture-node', [], {}, false); child.poll();
    await expect(child.created).rejects.toThrow('terminal-process-create-87');
    expect(observer).toHaveBeenCalledOnce();
    expect(observer.mock.calls[0]).toEqual([expect.objectContaining({ errorCode: 87 }), 'failure']);
    child.disposeTransport();
  });
  it('does not let a throwing observer interfere with creation publication', async () => {
    const { child } = fixture(true, true);
    await child.start('fixture-node', [], {}, false);
    expect(() => child.poll()).not.toThrow(); await expect(child.created).resolves.toBeUndefined();
    child.disposeTransport();
  });
  it('retains time spent in a native dispatch that throws', async () => {
    const { child, observer, native } = fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(10);
    const fail = () => { clock.mockReturnValue(85); throw Error('native-dispatch-failed'); };
    native.create.mockImplementation(fail); native.createPosix.mockImplementation(fail);
    try {
      await child.start('fixture-node', [], {}, false);
      await expect(child.created).rejects.toThrow('native-dispatch-failed');
      expect(observer).toHaveBeenCalledOnce();
      expect(observer.mock.calls[0]).toEqual([expect.objectContaining({ dispatchMs: 75, durationMs: 75 }), 'failure']);
    } finally { clock.mockRestore(); child.disposeTransport(); }
  });
});
