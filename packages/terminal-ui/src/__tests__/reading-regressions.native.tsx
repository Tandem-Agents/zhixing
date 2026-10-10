import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setRenderLibPath } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import type { BodyPage } from '../body-model.js';
import type { TerminalAction, TerminalView } from '../protocol.js';
setRenderLibPath(process.env.ZHIXING_TERMINAL_RENDER_LIB!);
const frames: Record<string, unknown> = {}, checks: string[] = [];
const walk = (node: any): any[] => [node, ...(node.getChildren?.() ?? []).flatMap(walk)];
async function scenario(name: string, run: (h: any) => Promise<void>, height = 40) {
  const test = await createTestRenderer({ width: 120, height, useThread: false, consoleMode: 'disabled', exitOnCtrlC: false, otherModifiersMode: true });
  let root: Awaited<ReturnType<typeof createTerminalRoot>> | undefined, generation = 0;
  let page: BodyPage = { first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: name, role: 'assistant', contentOffset: 0, final: true,
    text: Array.from({ length: 80 }, (_, i) => `LINE ${i} retained selection text`).join('\n') }] };
  const view = { kind: 'conversation', title: '知行', conversationId: name, connected: true } as const;
  const requests: TerminalAction[] = [], copies: string[] = [];
  const pasted = new Map<string, string>();
  let readReply: ((action: TerminalAction) => Promise<unknown>) | undefined;
  const flush = async () => { for (let i = 0; i < 10; i++) await test.renderOnce(); await new Promise<void>(resolve => queueMicrotask(resolve)); };
  const nodes = () => walk(test.renderer.root), box = () => nodes().find(n => n.constructor.name === 'TerminalScrollBox');
  const tick = setInterval(() => void test.renderOnce(), 15);
  try {
    root = await createTerminalRoot({ signal: new AbortController().signal, inputReady() {}, exit: async () => {}, request: async action => {
      requests.push(action);
      if (action.kind === 'input-begin') pasted.set(action.inputId, '');
      if (action.kind === 'input-part') pasted.set(action.inputId, (pasted.get(action.inputId) ?? '') + action.text);
      if (action.kind === 'paste-finish') return { text: pasted.get(action.inputId) ?? '', handles: [], paste: false };
      if (readReply && (action.kind === 'display-page' || action.kind === 'history-previous')) return readReply(action);
      if (action.kind === 'display-page') { page = { ...page, follow: !!action.follow }; root!.receive({ type: 'display-page', page }); }
      if (action.kind === 'clipboard-write') { copies.push(action.text); return { state: 'copied' }; }
      if (action.kind === 'input-candidates') return { revision: action.revision, start: 0, end: action.text.length, active: action.text.startsWith('/'), items: action.text.startsWith('/') ? [{ id: 'config', label: '/config' }] : [] };
      return { accepted: true };
    } }, async () => test.renderer);
    clearInterval(tick);
    const show = async (value: Omit<TerminalView, 'generation'>) => { root!.receive({ type: 'view', view: { ...value, generation: ++generation } }); await flush(); };
    const publish = async (value: BodyPage) => { page = value; root!.receive({ type: 'display-page', page }); await flush(); };
    const latest = async () => { test.mockInput.pressKey('\x1b[1;5F'); await flush(); };
    await show(view); await publish(page); await latest();
    await run({ test, root, flush, nodes, box, show, publish, latest, view, requests, copies, get page() { return page; },
      readWith: (reply: typeof readReply) => { readReply = reply; },
      capture: (label: string) => { frames[name + '-' + label] = test.captureSpans(); } });
    checks.push(name); console.log('PASS ' + name);
  } finally { clearInterval(tick); await root?.dispose(); test.renderer.destroy(); }
}
try {
  await scenario('thinking-source-copy', async h => {
    for (const text of ['alpha\n\nbeta', 'x'.repeat(150)]) {
      h.test.renderer.clearSelection();
      await h.publish({ first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: text.slice(0, 5), role: 'thinking', contentOffset: 20, final: true, text }] });
      const leaf = h.nodes().find((n: any) => n.constructor.name === 'BodyTextRenderable' && n.plainText.startsWith(text.slice(0, 5)));
      assert.ok(leaf);
      const lines = leaf.plainText.split('\n'); assert.equal(lines.length, 2);
      await h.test.mockMouse.drag(leaf.x, leaf.y, leaf.x + lines[1].length, leaf.y + 1); await h.flush();
      h.test.mockInput.pressKey('\x03'); await h.flush();
      assert.equal(h.copies.at(-1), text, 'source blanks preserved; visual soft wraps omitted');
    }
  });
  await scenario('required-footer-feedback', async h => {
    await h.show({ ...h.view, displayPaused: true, displayGap: true });
    h.root.receive({ type: 'task-status', status: { noticeGap: 'TASK_NOTICE_GAP', summary: { conversationId: h.view.conversationId, state: 'error', text: 'TASK_FAILED' } } });
    h.root.receive({ type: 'process-status', status: { conversationId: h.view.conversationId, view: { revision: 1, phase: 'RUNNING', activity: 'running', notice: 'PROCESS_GAP', tools: ['optional tool'], children: [{ id: 'child', parentToolCallId: 'parent', label: 'CHILD_FAILED', status: 'failed' }], usage: {} } } });
    await h.flush();
    const assertComplete = () => {
      const text = h.test.captureCharFrame();
      for (const value of ['正文保留已暂停', 'TASK_NOTICE_GAP', 'TASK_FAILED', 'PROCESS_GAP', 'CHILD_FAILED']) assert.ok(text.includes(value), value);
      assert.ok(!text.includes('Esc 收起候选查看'));
      const editor = h.nodes().find((n: any) => n.constructor.name === 'TerminalTextarea');
      assert.equal(text.split('\n').findIndex((row: string) => row.includes('正文保留已暂停')), editor.parent.y - 1);
    };
    assertComplete(); h.capture('normal');
    await h.test.mockInput.typeText('/'); await h.flush(); h.capture('candidates');
    h.test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25));
    await h.flush(); assertComplete(); h.capture('candidates-closed');
  }, 24);
  await scenario('history-gap-recovery-guidance', async h => {
    await h.show({ kind: 'history', title: '历史', conversationId: h.view.conversationId, connected: false, displayPaused: true, displayGap: true });
    let text = h.test.captureCharFrame();
    for (const value of ['历史展示已暂停', '缺口', '重新打开历史']) assert.ok(text.includes(value), value);
    assert.ok(!text.includes('Ctrl+R')); h.capture('paused');
    h.requests.length = 0; h.test.mockInput.pressKey('\x12'); await h.flush();
    assert.ok(!h.requests.some((a: TerminalAction) => a.kind === 'display-retry'));
    await h.show({ kind: 'history', title: '历史', conversationId: h.view.conversationId, connected: false, displayGap: true });
    text = h.test.captureCharFrame(); assert.ok(text.includes('历史展示存在缺口')); h.capture('gap');
  }, 24);
  await scenario('configuration-action-group-boundaries', async h => {
    for (const width of [120, 45]) for (const section of [undefined, 'Actions']) {
      h.test.resize(width, 24);
      await h.show({ kind: 'configuration', title: 'Provider', editId: 'provider-edit', configurationHome: false, choices: [
        { id: 'field', label: 'Field' },
        { id: 'save', label: 'Save', presentation: 'button', primary: true, shortcut: 'Ctrl+S', section },
        { id: 'cancel', label: 'Cancel', presentation: 'button', shortcut: 'Esc', section },
      ] });
      const rows = h.test.captureCharFrame().split('\n');
      const at = (label: string) => rows.findIndex((row: string) => row.includes(label));
      assert.equal(at('Save') - at('Field'), section ? 4 : 2);
      assert.equal(at('Cancel') - at('Save'), 1);
      if (section) assert.equal(at('Save') - at(section), 2, 'existing section gap is not duplicated');
      h.capture(`${width}-${section ?? 'subpage'}`);
    }
  }, 24);
  console.log(JSON.stringify({ checks }));
} finally {
  if (process.env.ZHIXING_READING_CAPTURE) {
    fs.mkdirSync(process.env.ZHIXING_READING_CAPTURE, { recursive: true });
    fs.writeFileSync(path.join(process.env.ZHIXING_READING_CAPTURE, 'regression-frames.json'), JSON.stringify(frames));
  }
}
