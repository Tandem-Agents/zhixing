import { EventEmitter } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { TextLineInput, TextSessionOutput, createTextSelection, attachTextInterrupts, TEXT_INPUT_MAX_LINE_BYTES } from '../text-session-io.js';
import { resolveTerminalConfirmation, projectTerminalConfirmation } from '../terminal/confirmation.js';
import type { ConfirmationRequest } from '@zhixing/core/confirmation';
import { chooseTerminalSelection } from '../terminal/selection.js';

function output() {
  let value = '';
  return { writer: new TextSessionOutput({ write: text => { value += text; } }), text: () => value };
}

describe('non-TTY line input', () => {
  it('drains every line received before startup finished, including final unterminated text', async () => {
    const stream = new PassThrough(), lines = new TextLineInput(stream);
    stream.end('one\r\ntwo\nthree');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await lines.next()).toBe('one');
    expect(await lines.next()).toBe('two');
    expect(await lines.next()).toBe('three');
    expect(await lines.next()).toBeUndefined(); lines.dispose();
  });
  it('keeps queued lines while an earlier turn is waiting and EOF arrives', async () => {
    const stream = new PassThrough(), lines = new TextLineInput(stream);
    const first = lines.next(); stream.write('first\n'); expect(await first).toBe('first');
    stream.end('second\nthird\n');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await lines.next()).toBe('second'); expect(await lines.next()).toBe('third');
    expect(await lines.next()).toBeUndefined(); lines.dispose();
  });
  it('only an explicit exit discards queued future input and releases a waiting reader', async () => {
    const stream = new PassThrough(), lines = new TextLineInput(stream);
    const waiting = lines.next(); lines.dispose(); expect(await waiting).toBeUndefined();
    stream.end(); expect(stream.listenerCount('error')).toBe(0);
  });
  it('applies stream backpressure while startup or an earlier turn is waiting', async () => {
    let produced = 0;
    const stream = new Readable({ highWaterMark: 1024, read() {
      produced += 256; this.push(`${'x'.repeat(255)}\n`);
    } });
    const lines = new TextLineInput(stream);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(produced).toBeLessThanOrEqual(1280);
    expect(await lines.next()).toBe('x'.repeat(255));
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(stream.readableLength).toBeLessThanOrEqual(1280);
    lines.dispose(); stream.destroy();
  });
  it('rejects an oversized unterminated line explicitly rather than retaining or truncating it', async () => {
    const stream = new PassThrough(), lines = new TextLineInput(stream);
    stream.end('x'.repeat(TEXT_INPUT_MAX_LINE_BYTES + 1));
    await expect(lines.next()).rejects.toThrow('单行输入超过 1 MiB'); lines.dispose();
  });
});

describe('non-TTY output and decisions', () => {
  it('streams text immediately without printing the final message twice or leaking terminal control bytes', () => {
    const view = output();
    view.writer.yield({ type: 'text_delta', text: '\x1b[31mhello\x1b[0m' });
    expect(view.text()).toBe('hello');
    view.writer.yield({ type: 'text_delta', text: ' world' });
    view.writer.yield({ type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'hello world' }] } });
    view.writer.line('done'); expect(view.text()).toBe('hello world\ndone\n');
    expect(view.text()).not.toContain('\x1b');
  });
  it('never interprets remaining pipe input as an approval or a modal choice', async () => {
    const view = output(), choose = createTextSelection(view.writer);
    const stream = new PassThrough(), lines = new TextLineInput(stream); stream.end('yes\nnext task\n');
    expect(await choose({ kind: 'selection', title: '删除？', choices: [{ id: 'confirm', label: '删除', danger: true }] })).toBeUndefined();
    const request = { id: 'request-1', display: { title: '允许写入？', body: { kind: 'file-write', path: '/tmp/file', preview: 'content' } },
      options: [{ kind: 'allow-once', label: '允许一次' }, { kind: 'deny', label: '拒绝' }] } as ConfirmationRequest;
    expect(await resolveTerminalConfirmation(projectTerminalConfirmation(request), choose)).toEqual({ kind: 'deny' });
    expect(await lines.next()).toBe('yes'); expect(await lines.next()).toBe('next task'); lines.dispose();
    expect(view.text()).toContain('已拒绝本次操作');
  });
  it('does not auto-activate a business action named next, including on a confirmation', async () => {
    const view = output(), choose = createTextSelection(view.writer);
    for (const kind of ['selection', 'confirmation'] as const) {
      expect(await choose({ kind, title: '继续删除', choices: [{ id: 'next', label: '删除下一项', danger: true }] })).toBeUndefined();
    }
    const display = createTextSelection(view.writer, { readOnly: true });
    expect(await display({ kind: 'selection', title: '业务操作', choices: [{ id: 'next', label: '执行下一步' }] })).toBeUndefined();
    expect(await display({ kind: 'selection', selectionLayer: 'select', title: '只读信息', choices: [
      { id: 'option:done', label: '返回输入' }, { id: 'next', label: '下一页正文' }, { id: 'return', label: '收起' },
    ] })).toEqual({ itemId: 'next' });
  });
  it('reads the entire decision body without selecting an action or consuming task input', async () => {
    const view = output(), display = createTextSelection(view.writer, { readOnly: true });
    const body = Array.from({ length: 60 }, (_, i) => `RULE_${i.toString().padStart(3, '0')} ${'x'.repeat(160)}`);
    const result = await chooseTerminalSelection({ title: '当前信任与待确认事项', body: [...body, '撤销：/trust revoke ID'],
      options: [{ value: 'resume', label: '继续确认', tone: 'danger', input: { placeholder: '说明' } }, { value: 'done', label: '返回输入' }] }, display);
    expect(result).toBeUndefined();
    for (const line of body) expect(view.text()).toContain(line.slice(0, 8));
    expect(view.text()).toContain('撤销：/trust revoke ID'); expect(view.text()).not.toContain('还有更多内容');
    for (const selectionLayer of ['input', 'confirm'] as const) expect(await display({ kind: 'selection', selectionLayer,
      title: '不能自动选择', choices: [{ id: 'next', label: '继续' }] })).toBeUndefined();
  });
});

describe('non-TTY process interrupts', () => {
  it('aborts the active run once per signal, requests exit on the second interrupt, and cleans listeners', async () => {
    const signals = new EventEmitter(); let now = 0;
    const abort = vi.fn(async () => {}), exit = vi.fn();
    const detach = attachTextInterrupts({ signals, now: () => now, active: () => true, abort,
      abortBackground: vi.fn(async () => false), exit, error: error => { throw error; } });
    signals.emit('SIGINT'); expect(abort).toHaveBeenCalledOnce(); expect(exit).not.toHaveBeenCalled();
    now = 500; signals.emit('SIGINT'); expect(exit).toHaveBeenCalledOnce();
    detach(); expect(signals.listenerCount('SIGINT')).toBe(0); expect(signals.listenerCount('SIGTERM')).toBe(0);
  });
  it('stops an observed background task before exiting an idle text session', async () => {
    const signals = new EventEmitter(), exit = vi.fn(); let now = 0;
    const background = vi.fn(async () => true);
    const detach = attachTextInterrupts({ signals, now: () => now, active: () => false,
      abort: vi.fn(async () => {}), abortBackground: background, exit, error: vi.fn() });
    signals.emit('SIGINT'); await new Promise<void>(resolve => setImmediate(resolve)); expect(exit).not.toHaveBeenCalled();
    now = 2000; background.mockResolvedValue(false); signals.emit('SIGINT');
    await new Promise<void>(resolve => setImmediate(resolve)); expect(exit).toHaveBeenCalledOnce(); detach();
  });
  it('SIGTERM both requests exit and cancels the active run', () => {
    const signals = new EventEmitter(), abort = vi.fn(async () => {}), exit = vi.fn();
    const detach = attachTextInterrupts({ signals, active: () => true, abort,
      abortBackground: vi.fn(async () => false), exit, error: vi.fn() });
    signals.emit('SIGTERM'); expect(abort).toHaveBeenCalledOnce(); expect(exit).toHaveBeenCalledOnce(); detach();
  });
});
