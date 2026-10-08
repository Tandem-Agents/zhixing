import { describe, expect, it, vi } from 'vitest';
import { TerminalInputSession } from '../../../../terminal-ui/src/input-session.js';
import type { TerminalAction } from '../../../../terminal-ui/src/protocol.js';

describe('terminal draft receipts and asynchronous paste', () => {
  it.each(['clipboard', 'native'] as const)('empty %s preserves text, prior paste and material handles', async kind => {
    const old = '[old paste]', material = '[material]';
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'clipboard-read') return { empty: true };
      if (action.kind === 'paste-finish') return { text: '', handles: [], replacePastes: true };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    session.candidate({ text: old + material, execute: false, handles: [
      { token: old, id: crypto.randomUUID(), paste: true }, { token: material, id: crypto.randomUUID() },
    ] }, { start: 0, end: 0 });
    const original = `prefix ${session.draft.text} suffix`;
    session.edit(original, original.length);
    if (kind === 'clipboard') await session.pasteClipboard(); else await session.paste(new Uint8Array());
    expect(session.draft.text).toBe(original);
    session.edit(original, original.indexOf(material) + material.length);
    expect(session.atomic('backspace')).toBe(true);
    expect(session.draft.text).toBe(`prefix ${old} suffix`);
    session.edit(session.draft.text, session.draft.text.indexOf(old) + old.length);
    expect(session.atomic('backspace')).toBe(true);
    expect(session.draft.text).toBe('prefix  suffix');
    await session.submit();
    expect(request.mock.calls.some(([action]) => action.kind === 'input-submit')).toBe(true);
  });
  it('places an asynchronous clipboard result at its marker, preserving intervening edits and blocking early submit', async () => {
    let ready!: () => void;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'clipboard-read') return new Promise<void>(resolve => { ready = resolve; });
      if (action.kind === 'paste-finish') return { text: '中文🙂', handles: [], replacePastes: true };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); session.edit('AB', 1);
    const paste = session.pasteClipboard();
    await expect(session.submit()).rejects.toThrow('输入仍在处理');
    session.edit(session.draft.text + 'C', session.draft.text.length + 1);
    ready(); await paste;
    expect(session.draft.text).toBe('A中文🙂BC');
    expect(request.mock.calls.some(([action]) => action.kind === 'input-submit')).toBe(false);
  });
  it('drops clipboard results after the pending marker was cancelled', async () => {
    let ready!: () => void;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'clipboard-read') return new Promise<void>(resolve => { ready = resolve; });
      if (action.kind === 'paste-finish') return { text: 'late', handles: [] };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    const paste = session.pasteClipboard(); session.clear(session.draft.version);
    session.edit('new', 3); ready(); await paste;
    expect(session.draft.text).toBe('new');
  });
  it('restores atomic handles supplied by a cold window', async () => {
    const ticket = crypto.randomUUID(), inputId = crypto.randomUUID(), pasteId = crypto.randomUUID();
    const text = '[Pasted #7 +1 lines · 9B]';
    const bytes = Buffer.byteLength(text);
    const session = new TerminalInputSession(async action => {
      if (action.kind === 'input-history') return { ticket, inputId, bytes };
      if (action.kind === 'input-window') return { inputId, bytes, text, start: 0, end: bytes,
        handles: [{ token: text, id: pasteId, paste: true }] };
      return {};
    }, vi.fn());
    await session.history(-1);
    expect(session.atomic('backspace')).toBe(true);
    expect(session.draft.text).toBe('');
  });

  it('repeats only the idempotent completed-reference receipt after an unknown acknowledgement', async () => {
    const completed: string[][] = []; let fail = true;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'paste-finish') return { text: 'short paste' };
      if (action.kind === 'input-references' && action.completed.length) {
        completed.push([...action.completed]);
        if (fail) { fail = false; throw Error('receipt lost'); }
      }
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    await session.paste(Buffer.from('short paste'));
    await vi.waitFor(() => expect(completed).toHaveLength(1));
    await session.submit();
    expect(completed[1]).toContain(completed[0]![0]);
    const references = request.mock.calls.map(([action]) => action).filter(action => action.kind === 'input-references');
    expect(references.every((action, index) => index === 0 || action.version > references[index - 1]!.version)).toBe(true);
    expect(request.mock.calls.filter(([action]) => action.kind === 'paste-finish')).toHaveLength(1);
  });

  it('reconciles a cached token after its collection response was lost', async () => {
    const id = crypto.randomUUID(), token = '[Pasted #1 +1 lines · 9B]';
    let fail = true, collected = false;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-references' && action.cached?.includes(id)) {
        collected = true;
        if (fail) { fail = false; throw Error('lost collection reply'); }
        return { removed: [id] };
      }
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    session.candidate({ text: token, execute: false, handles: [{ token, id }] }, { start: 0, end: 0 });
    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    session.edit('', 0);
    await vi.waitFor(() => expect(collected).toBe(true));
    session.edit('retry receipt', 13); await session.submit();
    session.edit(token, token.length);
    expect(session.atomic('backspace')).toBe(false);
    expect(request.mock.calls.filter(([action]) => action.kind === 'input-references' && action.cached?.includes(id))).toHaveLength(2);
  });

  it('transmits mixed UTF-8 exactly through bounded parts with an exact declared size', async () => {
    const original = '汉字🦞\r\n  '.repeat(20000), bytes = Buffer.from(original);
    const parts: string[] = [];
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-part') { expect(Buffer.byteLength(action.text)).toBeLessThanOrEqual(32 * 1024); parts.push(action.text); }
      if (action.kind === 'paste-finish') return { text: '[folded original]' };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); await session.paste(bytes);
    expect(parts.join('')).toBe(original);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'input-begin', purpose: 'paste', bytes: bytes.length }));
    expect(parts.length).toBeLessThan(20);
  });

  it('restores only the editable history window and then returns to the saved draft and cursor', async () => {
    const ticket = crypto.randomUUID(), inputId = crypto.randomUUID();
    const piece = '汉字 🦞\r\n\t  '.repeat(512);
    const original = piece.repeat(32) + 'tail  ';
    const bytes = Buffer.byteLength(original), text = 'tail  ';
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-history') return { ticket, inputId, bytes };
      if (action.kind === 'input-window') return { inputId, bytes, text, start: bytes - text.length, end: bytes };
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    session.edit('saved draft', 3);
    await session.history(-1);
    expect(session.draft.text).toBe(text); expect(session.beforeWindow).toBe(true);
    expect(request.mock.calls.some(([action]) => action.kind === 'input-history-next')).toBe(false);
    expect(request).toHaveBeenCalledWith({ kind: 'input-history-end', ticket });
    await session.history(1);
    expect(session.draft).toMatchObject({ text: 'saved draft', cursor: 3 });
  });

  it.each(['edit', 'page'] as const)('discards a late history page after %s and releases its read ticket', async change => {
    const ticket = crypto.randomUUID(), inputId = crypto.randomUUID();
    let resolve!: (page: { text: string }) => void;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-history') return { ticket, inputId, bytes: 4 };
      if (action.kind === 'input-window') return new Promise<{ text: string }>(done => { resolve = value => done({ ...value, ...{ inputId, bytes: 4, start: 0, end: 4 } }); });
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn());
    session.edit('original', 3);
    const reading = session.history(-1);
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
    if (change === 'edit') session.edit('new edit', 5); else session.activate(false);
    resolve({ text: 'late' }); await reading;
    expect(session.draft.text).toBe(change === 'edit' ? 'new edit' : 'original');
    expect(request).toHaveBeenCalledWith({ kind: 'input-history-end', ticket });
  });

  it('rejects incomplete history without replacing the current draft', async () => {
    const ticket = crypto.randomUUID(), inputId = crypto.randomUUID();
    const request = vi.fn(async (action: TerminalAction) => action.kind === 'input-history' ? { ticket, inputId, bytes: 10 }
      : action.kind === 'input-window' ? { inputId, start: 0, end: 10, bytes: 10, text: '' } : {});
    const session = new TerminalInputSession(request, vi.fn());
    session.edit('keep', 2);
    await expect(session.history(-1)).rejects.toThrow('未完整');
    expect(session.draft).toMatchObject({ text: 'keep', cursor: 2 });
    expect(request).toHaveBeenCalledWith({ kind: 'input-history-end', ticket });
  });

  it('starts at the newest history again after an accepted recalled submission', async () => {
    const ticket = crypto.randomUUID(), inputId = crypto.randomUUID();
    let session: TerminalInputSession;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-history') return { ticket, inputId, bytes: 3 };
      if (action.kind === 'input-window') return { inputId, bytes: 3, start: 0, end: 3, text: 'old' };
      if (action.kind === 'input-splice') return { inputId: crypto.randomUUID(), bytes: 3 };
      if (action.kind === 'input-submit') session.settle({ ...action, accepted: true });
      return {};
    });
    session = new TerminalInputSession(request, vi.fn());
    session.edit('saved', 2); await session.history(-1); await session.submit();
    expect(session.draft.text).toBe('');
    await session.history(-1);
    expect(request.mock.calls.filter(([action]) => action.kind === 'input-history').map(([action]) => 'offset' in action ? action.offset : -1)).toEqual([0, 0]);
    await session.history(1); expect(session.draft.text).toBe('');
  });

  it('clears exactly its accepted version, including receipt before request reply', async () => {
    let session: TerminalInputSession;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-submit') session.settle({ ...action, accepted: true });
    });
    session = new TerminalInputSession(request, vi.fn());
    session.edit('中文 🦞\n原始空白  ', 5); await session.submit();
    expect(session.draft.text).toBe(''); expect(session.pending).toBe(false);
    const parts = request.mock.calls.map(([action]) => action).filter(action => action.kind === 'input-part');
    expect(parts.map(part => part.text).join('')).toBe('中文 🦞\n原始空白  ');
  });
  it('late acceptance and duplicate receipts never clear a newer draft', async () => {
    let submitted: Extract<TerminalAction, { kind: 'input-submit' }> | undefined;
    const session = new TerminalInputSession(async action => { if (action.kind === 'input-submit') submitted = action; }, vi.fn());
    session.edit('first', 5); await session.submit(); session.edit('new draft', 9);
    expect(session.settle({ ...submitted!, accepted: true })).toBe(true);
    expect(session.settle({ ...submitted!, accepted: true })).toBe(false);
    expect(session.draft.text).toBe('new draft');
  });
  it('keeps an unknown dispatched outcome locked without automatically submitting twice', async () => {
    const request = vi.fn(async (action: TerminalAction) => { if (action.kind === 'input-submit') throw Error('unknown result'); });
    const session = new TerminalInputSession(request, vi.fn()); session.edit('keep', 4);
    await expect(session.submit()).rejects.toThrow('unknown result');
    expect(session.draft.text).toBe('keep'); await expect(session.submit()).rejects.toThrow('仍在处理');
    expect(request.mock.calls.filter(([action]) => action.kind === 'input-submit')).toHaveLength(1);
  });
  it('retains edits on both sides of an in-flight paste and blocks premature submit', async () => {
    let finish!: (result: unknown) => void;
    const session = new TerminalInputSession(async action => action.kind === 'paste-finish' ? new Promise(resolve => { finish = resolve; }) : undefined, vi.fn());
    session.edit('beforeafter', 6);
    const paste = session.paste(new TextEncoder().encode('🦞 中文\n'.repeat(3000)));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    session.edit(`X${session.draft.text}Y`, session.draft.text.length + 2);
    await expect(session.submit()).rejects.toThrow('仍在处理');
    finish({ text: '[folded original]' }); await paste;
    expect(session.draft.text).toBe('Xbefore[folded original]afterY');
    expect(session.draft.cursor).toBe(session.draft.text.length);
  });
  it('never resurrects a pending paste marker that the user removed', async () => {
    let finish!: (result: unknown) => void;
    const session = new TerminalInputSession(async action => action.kind === 'paste-finish' ? new Promise(resolve => { finish = resolve; }) : undefined, vi.fn());
    const paste = session.paste(new TextEncoder().encode('original'));
    await vi.waitFor(() => expect(finish).toBeTypeOf('function')); session.edit('replacement', 11);
    finish({ text: 'original' }); await paste; expect(session.draft.text).toBe('replacement');
  });

  it('keeps edits made during a window save on the saved base and submits the complete next version', async () => {
    let release!: () => void, held = true;
    const size = 50 * 1024, uploaded = new Map<string, string>();
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-begin') { uploaded.set(action.inputId, ''); if (held) { held = false; await new Promise<void>(done => { release = done; }); } }
      if (action.kind === 'input-part') uploaded.set(action.inputId, uploaded.get(action.inputId)! + action.text);
      if (action.kind === 'input-splice') {
        const inputId = crypto.randomUUID(), source = uploaded.get(action.inputId)!;
        const text = source.slice(0, action.start) + uploaded.get(action.replacementId)! + source.slice(action.end);
        uploaded.set(inputId, text); return { inputId, bytes: text.length };
      }
      if (action.kind === 'input-window') {
        const source = uploaded.get(action.inputId)!, start = Math.max(0, source.length - 24 * 1024);
        return { inputId: action.inputId, start, end: source.length, bytes: source.length, text: source.slice(start) };
      }
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); session.edit('a'.repeat(size), size);
    const saving = session.compact(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    session.edit(session.draft.text + 'later', size + 5); release(); await saving;
    expect(session.draft.text).toBe('a'.repeat(size) + 'later');
    await session.compact();
    expect(session.draft.text.length).toBeLessThanOrEqual(32 * 1024); expect(session.beforeWindow).toBe(true);
    await session.submit();
    const submission = request.mock.calls.map(([action]) => action).findLast(action => action.kind === 'input-submit');
    expect(submission?.kind).toBe('input-submit');
    expect(uploaded.get(submission!.inputId)).toBe('a'.repeat(size) + 'later');
    expect(session.settle({ inputId: submission!.inputId, version: submission!.version, accepted: false })).toBe(true);
    expect(session.draft.text.endsWith('later')).toBe(true);
  });

  it('does not replace a newer cursor when a clean window read completes late', async () => {
    const inputId = crypto.randomUUID(), ticket = crypto.randomUUID(), bytes = 65 * 1024 * 1024;
    let hold = false, deliver!: (value: unknown) => void;
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-history') return { inputId, ticket, bytes };
      if (action.kind === 'input-window') {
        if (hold) return new Promise(done => { deliver = done; });
        return { inputId, bytes, start: bytes - 4, end: bytes, text: 'tail' };
      }
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); await session.history(-1);
    session.edit('tail', 0); hold = true;
    const moving = session.navigate('left'); await vi.waitFor(() => expect(deliver).toBeTypeOf('function'));
    session.edit('tail', 2);
    deliver({ inputId, bytes, start: bytes - 8, end: bytes, text: 'new-tail' }); await moving;
    expect(session.draft).toMatchObject({ text: 'tail', cursor: 2 });
  });

  it('keeps the complete prior draft when atomic paste publication fails, and never submits its pending marker', async () => {
    const inputId = crypto.randomUUID(), ticket = crypto.randomUUID(), bytes = 65 * 1024 * 1024;
    const sizes = new Map([[inputId, bytes]]), uploads = new Map<string, string>();
    const request = vi.fn(async (action: TerminalAction) => {
      if (action.kind === 'input-history') return { inputId, ticket, bytes };
      if (action.kind === 'input-window') return { inputId, bytes, start: bytes - 4, end: bytes, text: 'tail' };
      if (action.kind === 'input-begin') { uploads.set(action.inputId, ''); sizes.set(action.inputId, 0); }
      if (action.kind === 'input-part') { uploads.set(action.inputId, uploads.get(action.inputId)! + action.text); sizes.set(action.inputId, Buffer.byteLength(uploads.get(action.inputId)!)); }
      if (action.kind === 'paste-finish') {
        if (!action.draft) return { textEdit: true, text: '[new original]' };
        throw Error('synthetic atomic paste failure');
      }
      if (action.kind === 'input-splice') {
        const id = crypto.randomUUID(), total = sizes.get(action.inputId)! - (action.end - action.start) + sizes.get(action.replacementId)!;
        sizes.set(id, total); return { inputId: id, bytes: total };
      }
      return {};
    });
    const session = new TerminalInputSession(request, vi.fn()); await session.history(-1);
    await expect(session.paste(Buffer.from('new original'))).rejects.toThrow('synthetic atomic paste failure');
    expect(session.draft.text).toBe('tail'); await session.submit();
    const submission = request.mock.calls.map(([action]) => action).findLast(action => action.kind === 'input-submit');
    expect(submission?.kind).toBe('input-submit'); expect(sizes.get(submission!.inputId)).toBe(bytes);
    expect(uploads.get(request.mock.calls.map(([action]) => action).findLast(action => action.kind === 'input-splice')!.replacementId)).toBe('tail');
  });
});
