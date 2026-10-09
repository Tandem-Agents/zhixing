import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalClipboardWriter } from '../clipboard-write.js';

function harness(run: (call: { command: string; args: string[]; input: string; output: (s: string | Buffer) => void; close: (code?: number) => void }) => void) {
  const live = new Set<() => void>();
  const create = vi.fn((command: string, args: string[], options: { signal: AbortSignal }) => {
    let resolve!: (result: { code: number; signal: null }) => void;
    const closed = new Promise<{ code: number; signal: null }>(r => { resolve = r; });
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => close()) });
    let done = false, input = '';
    const abort = () => close();
    const close = (code = 0) => { if (done) return; done = true; live.delete(abort); options.signal.removeEventListener('abort', abort); child.stdout.end(); child.stderr.end(); resolve({ code, signal: null }); };
    live.add(abort); options.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('data', chunk => { input += chunk.toString('utf8'); });
    child.stdin.once('finish', () => run({ command, args, input, output: s => child.stdout.write(s), close }));
    return { child, ready: Promise.resolve(), closed };
  });
  return { create, live };
}
const entry = () => 'E:/fixture with space/dist/index.js';
afterEach(() => vi.useRealTimers());
describe('owned clipboard writes', () => {
  it.each(['accepted', 'unknown', 'unavailable'])('reports the native %s receipt without another writer', async status => {
    const h = harness(call => { expect(call.input).toBe('中文🙂\ntext'); call.output(status + '\n'); call.close(); });
    const writer = new TerminalClipboardWriter(new AbortController().signal, h.create as any, 'win32', {}, entry);
    expect(await writer.write('中文🙂\ntext')).toEqual({ state: status === 'accepted' ? 'copied' : status });
    expect(h.create).toHaveBeenCalledOnce(); expect(h.live.size).toBe(0); await writer.close();
  });
  it('does not write on a remote target or spawn for invalid text', async () => {
    const h = harness(() => { throw Error('unexpected write'); });
    const writer = new TerminalClipboardWriter(new AbortController().signal, h.create as any, 'linux', { SSH_CONNECTION: 'remote' }, entry);
    expect(await writer.write('a')).toEqual({ state: 'unavailable' });
    await expect(writer.write('x\0y')).rejects.toThrow('size');
    await expect(writer.write('x'.repeat(224 * 1024 + 1))).rejects.toThrow('size');
    expect(h.create).not.toHaveBeenCalled(); await writer.close();
  });
  it('verifies a request-specific Wayland offer, retries reads, and retains the accepted provider beyond setup timeout', async () => {
    vi.useFakeTimers(); let offer = '', attempts = 0;
    const h = harness(call => {
      if (call.command === 'wl-copy') { offer = call.args.at(-1)!; expect(call.input).toBe('same text'); }
      else { expect(call.args.at(-1)).toBe(offer); expect(offer).toMatch(/^text\/plain;charset=utf-8;x-zhixing-copy=/); attempts++;
        if (attempts === 1) call.close(1); else { call.output('same text'); call.close(); } }
    });
    const writer = new TerminalClipboardWriter(new AbortController().signal, h.create as any, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, entry);
    const work = writer.write('same text'); await vi.advanceTimersByTimeAsync(60);
    expect(await work).toEqual({ state: 'provider' }); expect(attempts).toBe(2); expect(h.live.size).toBe(1);
    await vi.advanceTimersByTimeAsync(2000); expect(h.live.size).toBe(1);
    await writer.close(); expect(h.live.size).toBe(0);
  });
  it('does not acknowledge a missing offer or leak its writer after the deadline', async () => {
    vi.useFakeTimers(); let reads = 0;
    const h = harness(call => { if (call.command === 'wl-paste') { reads++; call.close(1); } });
    const writer = new TerminalClipboardWriter(new AbortController().signal, h.create as any, 'linux', { WAYLAND_DISPLAY: 'wayland-0' }, entry);
    const work = writer.write('text'); await vi.advanceTimersByTimeAsync(1501);
    expect(await work).toEqual({ state: 'unknown' }); expect(reads).toBeLessThanOrEqual(9); expect(h.live.size).toBe(0);
    expect(h.create.mock.calls.filter(c => c[0] === 'wl-copy')).toHaveLength(1); await writer.close();
  });
  it('requires matching X11 helper identity and preserves exactly one accepted provider', async () => {
    const h = harness(call => call.output(JSON.stringify({ requestId: call.args.at(-1), window: 123 }) + '\n'));
    const writer = new TerminalClipboardWriter(new AbortController().signal, h.create as any, 'linux', { DISPLAY: ':0' }, entry);
    expect(await writer.write('first')).toEqual({ state: 'provider' }); expect(h.live.size).toBe(1);
    expect(await writer.write('second')).toEqual({ state: 'provider' }); expect(h.live.size).toBe(1);
    await writer.close(); expect(h.live.size).toBe(0);
  });
});
