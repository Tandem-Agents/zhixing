import { describe, expect, it, vi } from 'vitest';
import { TerminalRecovery } from '../recovery.js';

function fixture() {
  const abort = new AbortController(), publish = vi.fn(async (_view: unknown) => {}), send = vi.fn(async (_message: unknown) => {});
  const recovery = new TerminalRecovery({ signal: abort.signal, publish, send });
  const id = () => (publish.mock.calls.at(-1)![0] as { recovery: { requestId: string } }).recovery.requestId;
  return { recovery, abort, publish, send, id };
}
describe('volatile recovery interaction', () => {
  it('keeps secret output off ordinary views and requires actual separate read-back', async () => {
    const f = fixture(); await f.recovery.show('display-only-value');
    expect(JSON.stringify(f.publish.mock.calls)).not.toContain('display-only-value');
    expect(f.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'recovery-page', text: 'display-only-value' }));
    let done = false; const reading = f.recovery.read().then(value => { done = true; return value; });
    await Promise.resolve(); expect(done).toBe(false);
    await f.recovery.act({ kind: 'recovery-part', requestId: f.id(), index: 0, encoded: Buffer.from('actual-user-input').toString('base64'), final: true });
    expect(await reading).toBe('actual-user-input');
  });
  it('invalidates cancelled requests without letting a stale part replace a new read', async () => {
    const f = fixture(), first = f.recovery.read(); void first.catch(() => {}); await Promise.resolve(); const old = f.id();
    await f.recovery.act({ kind: 'recovery-cancel', requestId: old }); await expect(first).rejects.toThrow('取消');
    const next = f.recovery.read(); await Promise.resolve(); const current = f.id(); expect(current).not.toBe(old);
    await expect(f.recovery.act({ kind: 'recovery-part', requestId: old, index: 0, encoded: '', final: true })).rejects.toThrow('失效');
    await f.recovery.act({ kind: 'recovery-part', requestId: current, index: 0, encoded: Buffer.from('current').toString('base64'), final: true });
    expect(await next).toBe('current');
  });
  it('retains only the final pure-display result and dismisses without a domain confirmation', async () => {
    const f = fixture(); await f.recovery.show('confirmation-code', 'code', true);
    let dismissed = false; const finish = f.recovery.finishDisplay().then(() => { dismissed = true; }); await Promise.resolve();
    expect(dismissed).toBe(false); expect(f.publish).toHaveBeenLastCalledWith(expect.objectContaining({ recovery: expect.objectContaining({ settled: true, input: false }) }));
    await f.recovery.act({ kind: 'recovery-cancel', requestId: f.id() }); await finish; expect(dismissed).toBe(true);
    await f.recovery.show('ongoing-invitation'); await f.recovery.finishDisplay(); f.recovery.close();
  });
  it('rejects an in-flight read when the owning application is closed', async () => {
    const f = fixture(), read = f.recovery.read(); void read.catch(() => {}); await Promise.resolve(); f.abort.abort();
    await expect(read).rejects.toThrow('取消');
  });
});
