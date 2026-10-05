import { describe, expect, it, vi } from 'vitest';
import { TerminalPasteStream } from '../../../../terminal-ui/src/paste-stream.js';
import { TerminalInputSession } from '../../../../terminal-ui/src/input-session.js';
import type { TerminalAction } from '../../../../terminal-ui/src/protocol.js';

describe('terminal streaming paste ownership', () => {
  it('charges a yielded page until its consumer finishes, then releases all queued capacity on overflow', async () => {
    const page = TerminalPasteStream.pageBytes;
    let bytes = 0, peak = 0;
    const stream = new TerminalPasteStream(count => {
      if (bytes + count > page * 2) throw Error('full');
      bytes += count; peak = Math.max(peak, bytes);
    }, count => { bytes -= count; });
    stream.write(new Uint8Array(page));
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.length).toBe(page);
    expect(bytes).toBe(page);
    stream.write(new Uint8Array(page + 1));
    expect(bytes).toBe(page);
    await expect(iterator.next()).rejects.toThrow('full');
    expect(bytes).toBe(0); expect(peak).toBe(page * 2);
    stream.write(new Uint8Array(10)); stream.end(); expect(bytes).toBe(0);
  });

  it('writes original pages before the end marker but publishes a handle only after complete UTF-8 succeeds', async () => {
    const parts: string[] = [];
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-part') parts.push(action.text);
      if (action.kind === 'paste-finish') return { text: '[original]' };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    session.edit('beforeafter', 6);
    const stream = session.beginPaste();
    const original = '\uFEFF' + '汉字🦞\r\n  '.repeat(12000);
    const encoded = Buffer.from(original);
    for (let offset = 0; offset < encoded.length; offset += 7001) stream.write(encoded.subarray(offset, offset + 7001));
    await vi.waitFor(() => expect(parts.length).toBeGreaterThan(0));
    expect(request.mock.calls.some(([action]) => action.kind === 'paste-finish')).toBe(false);
    await expect(session.submit()).rejects.toThrow('输入仍在处理');
    expect(request.mock.calls.some(([action]) => action.kind === 'input-submit')).toBe(false);
    session.edit('X' + session.draft.text + 'Y', session.draft.text.length + 2);
    stream.end(); await stream.done;
    expect(parts.join('')).toBe(original);
    expect(parts.every(text => Buffer.byteLength(text) <= 32 * 1024)).toBe(true);
    expect(session.draft.text).toBe('Xbefore[original]afterY');
  });

  it('keeps the old draft and never publishes a partial original after a late write error', async () => {
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-part') throw Error('disk-full');
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); session.edit('old draft', 3);
    const stream = session.beginPaste(), result = expect(stream.done).rejects.toThrow('disk-full');
    stream.write(new Uint8Array(TerminalPasteStream.pageBytes).fill(65));
    await result;
    stream.write(Buffer.from('/exit\rnot a command')); stream.end();
    expect(session.draft.text).toBe('old draft');
    expect(request.mock.calls.some(([action]) => action.kind === 'paste-finish' || action.kind === 'input-submit')).toBe(false);
    expect(session.pending).toBe(false);
  });

  it('rejects an incomplete final UTF-8 code point without replacing the draft', async () => {
    const request = vi.fn(async () => ({}));
    const session = new TerminalInputSession(request, vi.fn()); session.edit('keep', 4);
    const stream = session.beginPaste(), result = expect(stream.done).rejects.toThrow();
    stream.write(new Uint8Array([0xf0, 0x9f, 0xa6])); stream.end(); await result;
    expect(session.draft.text).toBe('keep');
  });
});
