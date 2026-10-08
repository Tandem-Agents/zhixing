import { describe, expect, it } from 'vitest';
import type { ConfirmationRequest } from '@zhixing/core/confirmation';
import { projectTerminalConfirmation, resolveTerminalConfirmation } from '../confirmation.js';

function request(command = 'synthetic command'): ConfirmationRequest {
  return { id: 'own-request', tool: 'Bash', toolInput: { command }, workingDirectory: 'synthetic',
    display: { title: '执行命令', body: { kind: 'bash', command, commandPreview: command.slice(0, 20) }, cwd: 'synthetic' },
    options: [{ kind: 'allow-once', label: '允许一次' }, { kind: 'deny-with-reason', label: '说明拒绝原因', placeholder: '原因' }],
    sessionType: 'interactive', contextId: { kind: 'workspace', hash: 'synthetic' }, createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER };
}
describe('terminal control projection', () => {
  it('makes a 512 KiB required command available page by page without truncation or an oversized frame', async () => {
    const command = 'x'.repeat(512 * 1024);
    const projection = projectTerminalConfirmation(request(command)); let shown = '';
    const result = await resolveTerminalConfirmation(projection, async page => {
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(256 * 1024);
      expect(page.choices!.filter(choice => choice.label === '拒绝本次操作')).toHaveLength(1);
      shown += page.message!.replace(/\n（正文 \d+\/\d+）$/u, '');
      return { itemId: page.choices!.some(choice => choice.id === 'next') ? 'next' : 'option:decision:0' };
    });
    expect(shown).toBe(command); expect(result).toEqual({ kind: 'allow-once' });
  });
  it('keeps headless undefined denial and legacy Ctrl+C compatibility in the note page', async () => {
    for (const cancelled of [false, true]) {
      let count = 0;
      const decision = await resolveTerminalConfirmation(projectTerminalConfirmation(request()), async () => {
        if (!count++) return { itemId: 'option:decision:1' };
        return cancelled ? { itemId: 'cancelled' } : undefined;
      });
      expect(decision).toEqual(cancelled ? { kind: 'cancelled', cause: 'user-ctrl-c' } : { kind: 'deny' });
    }
  });
  it('preserves a legal 8 KiB reason and requires a distinct second confirmation for an offered persistent rule', async () => {
    const note = 'n'.repeat(8192); let count = 0;
    const denied = await resolveTerminalConfirmation(projectTerminalConfirmation(request()), async () => count++ ? { itemId: 'submit', input: note } : { itemId: 'option:decision:1' });
    expect(denied).toEqual({ kind: 'deny', reason: note });
    const source = request(); const pattern = { label: 'synthetic rule', pattern: { tool: 'Bash', argument: 'synthetic *' } };
    source.options = [{ kind: 'allow-context', label: '允许此上下文', pattern }]; count = 0;
    const allowed = await resolveTerminalConfirmation(projectTerminalConfirmation(source), async page => {
      if (!count++) return { itemId: 'option:decision:0' };
      expect(page.title).toBe('保存这条授权规则？'); expect(page.choices![0]!.id).toBe('back'); return { itemId: 'confirm' };
    });
    expect(allowed).toEqual({ kind: 'allow-context', pattern, note: undefined });
  });
  it('keeps refusal reachable when required details exceed the control workspace', () => {
    const projection = projectTerminalConfirmation(request('x'.repeat(2 * 1024 * 1024)));
    expect([...projection.options.values()].some(option => option.kind.startsWith('allow'))).toBe(false);
    expect([...projection.options.values()].some(option => option.kind === 'deny')).toBe(true);
  });
});


it('returns from a permission note on Escape, preserving the pending request and option hotkeys', async () => {
  const source = request(); source.options[0] = { kind: 'allow-once', label: '允许一次', hotkey: 'y' };
  const pages: string[] = []; let count = 0;
  const result = await resolveTerminalConfirmation(projectTerminalConfirmation(source), async page => {
    pages.push(page.selectionLayer!);
    if (count++ === 0) { expect(page.choices![0]!.hotkey).toBe('y'); return { itemId: 'option:decision:1' }; }
    if (count === 2) return { itemId: 'cancelled', cancelCause: 'escape' };
    return { itemId: 'option:decision:0' };
  });
  expect(pages).toEqual(['select', 'input', 'select']); expect(result).toEqual({ kind: 'allow-once' });
});
for (const [cause, expected] of [['escape', 'deny'], ['ctrl-c', 'user-ctrl-c'], ['ctrl-d', 'user-ctrl-d'], ['aborted', 'aborted']] as const) {
  it(`preserves permission cancellation ${cause}`, async () => {
    const decision = await resolveTerminalConfirmation(projectTerminalConfirmation(request()), async () => ({ itemId: 'cancelled', cancelCause: cause }));
    expect(decision).toEqual(expected === 'deny' ? { kind: 'deny' } : { kind: 'cancelled', cause: expected });
  });
}
