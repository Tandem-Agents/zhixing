import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TerminalClipboard } from '../clipboard.js';

function factory(outputs: { chunks: Buffer[]; code?: number; unknown?: boolean; unavailable?: boolean }[]) {
  return vi.fn(() => {
    const output = outputs.shift()!;
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill: vi.fn(() => { child.stdout.end(); child.stderr.end(); return true; }) });
    let finish!: (value: { code: number; signal: null }) => void;
    const closed = new Promise<{ code: number; signal: null }>((resolve, reject) => {
      finish = value => output.unknown ? reject(Error('completion unknown')) : resolve(value);
    });
    const ready = Promise.resolve().then(() => {
      for (const bytes of output.chunks) child.stdout.write(Buffer.from(bytes));
      child.stdout.end(); child.stderr.end(); finish({ code: output.code ?? 0, signal: null });
      if (output.unavailable) throw Error('executable unavailable');
    });
    return { child, ready, closed };
  });
}

describe('owned clipboard reader', () => {
  it('reports an empty successful clipboard without inserting or trying another reader', async () => {
    const create = factory([{ chunks: [] }]), write = vi.fn();
    expect(await new TerminalClipboard(new AbortController().signal, create as any, 'linux').read(write)).toBe(false);
    expect(write).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
  });
  it.each(['timeout', 'abort'] as const)('stops on %s without fallback and waits for actual close', async reason => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      let close!: () => void;
      const closed = new Promise<{ code: number; signal: null }>(resolve => { close = () => {
        child.stdout.end(); child.stderr.end(); resolve({ code: 1, signal: null });
      }; });
      const create = vi.fn(() => ({ child, ready: Promise.resolve(), closed }));
      const reader = new TerminalClipboard(controller.signal, create as any, 'linux');
      let settled = false;
      const reading = reader.read(async () => {}).then(() => { throw Error('must reject'); }, error => { settled = true; return error; });
      if (reason === 'timeout') {
        await vi.advanceTimersByTimeAsync(1499); expect(child.kill).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
      } else controller.abort(Error('cancelled'));
      expect(child.kill).toHaveBeenCalledOnce(); expect(settled).toBe(false);
      close(); expect(await reading).toBeInstanceOf(Error);
      expect(create).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it('streams split UTF-8 exactly into bounded store pages', async () => {
    const original = '\uFEFF' + '中文🙂\r\n'.repeat(4000), bytes = Buffer.from(original), parts: string[] = [];
    const create = factory([{ chunks: [bytes.subarray(0, 4), bytes.subarray(4)] }]);
    const reader = new TerminalClipboard(new AbortController().signal, create as any, 'win32');
    await reader.read(async text => { expect(Buffer.byteLength(text)).toBeLessThanOrEqual(32 * 1024); parts.push(text); });
    expect(parts.join('')).toBe(original);
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0]).toBe('powershell.exe');
  });
  it('falls back only before any output and never after partial text or unknown completion', async () => {
    const create = factory([{ chunks: [], code: 127 }, { chunks: [Buffer.from('ok')] }]);
    let text = '';
    await new TerminalClipboard(new AbortController().signal, create as any, 'linux').read(async part => { text += part; });
    expect(text).toBe('ok'); expect(create).toHaveBeenCalledTimes(2);
    const missing = factory([{ chunks: [], code: 127, unavailable: true }, { chunks: [Buffer.from('fallback')] }]);
    const parts: string[] = [];
    await new TerminalClipboard(new AbortController().signal, missing as any, 'linux').read(async part => { parts.push(part); });
    expect(parts.join('')).toBe('fallback'); expect(missing).toHaveBeenCalledTimes(2);
    for (const output of [{ chunks: [Buffer.from('partial')], code: 1 }, { chunks: [], unknown: true }]) {
      const failure = factory([output]);
      await expect(new TerminalClipboard(new AbortController().signal, failure as any, 'linux').read(async () => {})).rejects.toThrow();
      expect(failure).toHaveBeenCalledOnce();
    }
  });
  it('enforces field bounds, rejects invalid UTF-8 and refuses overlapping reads', async () => {
    for (const bytes of [Buffer.alloc(8193, 65), Buffer.from([0xff])]) {
      const create = factory([{ chunks: [bytes] }]);
      await expect(new TerminalClipboard(new AbortController().signal, create as any).read(async () => {}, 8192)).rejects.toThrow();
      expect(create.mock.results[0]!.value.child.kill).toHaveBeenCalled();
    }
    let release!: () => void;
    const create = factory([{ chunks: [Buffer.from('ok')] }]);
    const reader = new TerminalClipboard(new AbortController().signal, create as any);
    const first = reader.read(() => new Promise<void>(resolve => { release = resolve; }));
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(reader.read(async () => {})).rejects.toThrow('busy');
    release(); await first;
  });
});
