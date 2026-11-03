import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setRenderLibPath } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import { encodeBodyPage, type BodyPage, type BodyPageRevision } from '../body-model.js';
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
  await scenario('notice-between-one-paragraph-keeps-both-parts', async h => {
    // 按实测记录复现：回复写到一半时到点通知落盘，同一段落被通知隔成两段，两段的来源节点起点都是 0
    const line = (i: number) => `E-STREAM-${i} 正文片段。\n`;
    const head = Array.from({ length: 139 }, (_, i) => line(i)).join(''), tail = Array.from({ length: 11 }, (_, i) => line(139 + i)).join('');
    const part = (text: string, from: number, end: boolean) => ({ blockId: 'live:run-long:0', role: 'assistant', contentOffset: from, final: end, text,
      body: { version: 1 as const, revision: end ? 2 : 1, kind: 'markdown' as const, end, context: { nodes: [{ from, to: from + text.length, kind: 'paragraph' as const,
        depth: 0, anchor: from === 0, origin: 0, runs: [{ from, to: from + text.length, text, style: 0 }] }] } } });
    await h.publish({ first: 0, last: 5, start: 1, follow: true, segments: [
      { blockId: 'thinking', role: 'thinking', contentOffset: 0, final: true, text: '第一段思考\n第二段思考\n' },
      part(head, 0, false),
      { blockId: 'notice:schedule', role: 'notice', contentOffset: 0, final: true, text: '定时任务 · ✓ 定时任务完成: 隔离到点任务 (0s)' },
      part(tail, head.length, true),
    ] });
    await h.latest();
    const frame = h.test.captureCharFrame();
    assert.equal(frame.split('定时任务完成').length - 1, 1, 'the notice is shown exactly once');
    assert.ok(frame.includes('E-STREAM-138 ') && frame.includes('E-STREAM-149 '), 'text before and after the notice both stay in the body');
    assert.ok(frame.indexOf('E-STREAM-138 ') < frame.indexOf('定时任务完成') && frame.indexOf('定时任务完成') < frame.indexOf('E-STREAM-139 '), 'the notice sits where it arrived');
    assert.ok(h.box().scrollHeight >= 150, 'the earlier part keeps its full height for reading back');
    h.capture('notice-between');
  });
  await scenario('virtual-reading-resize-roundtrip', async h => {
    await h.publish({ first: 0, start: 0, last: 1, follow: true, segments: [{
      blockId: 'resize-long', role: 'assistant', contentOffset: 0, final: true,
      text: Array.from({ length: 120 }, (_, i) => `I-ROW-${i} 中文与英文 mixed words，滚动回看时保持这一行。\n`).join('\n'),
    }] });
    h.test.mockInput.pressKey('\x1b[5~'); await h.flush();
    const first = () => /I-ROW-\d+/u.exec(h.test.captureCharFrame())?.[0];
    const anchor = first(); assert.ok(anchor); h.capture('before');
    h.test.resize(40, 16); await h.flush();
    assert.equal(first(), anchor, 'narrowing preserves the first visible source row'); h.capture('narrow');
    h.test.resize(120, 32); await h.flush();
    assert.equal(first(), anchor, 'widening restores the same source row'); h.capture('wide');
  }, 32);
  await scenario('selection-bottom-wheel-and-clear', async h => {
    await h.test.mockMouse.drag(6, 4, 18, 5); await h.flush();
    const selected = h.test.renderer.getSelection()?.getSelectedText(); assert.ok(selected);
    await h.test.mockMouse.scroll(20, 8, 'down'); await h.flush();
    assert.equal(h.test.renderer.getSelection()?.getSelectedText(), selected);
    assert.equal(h.page.follow, false);
    h.capture('selected-after-wheel');
    await h.test.mockMouse.click(20, 8); await h.flush();
    assert.ok(!h.test.renderer.getSelection()?.getSelectedText());
    assert.equal(h.requests.filter((a: TerminalAction) => a.kind === 'display-page').at(-1)?.follow, true);
    assert.equal(h.page.follow, true);
    await h.publish({ ...h.page, segments: [{ ...h.page.segments[0], text: h.page.segments[0].text + '\nAFTER CLEAR' }] });
    assert.equal(h.box().scrollTop + h.box().viewport.height, h.box().scrollHeight);
  });
  await scenario('passive-resize-click-preserves-reading', async h => {
    await h.test.mockMouse.scroll(20, 8, 'up'); await h.flush();
    h.test.resize(120, 100); await h.flush(); assert.equal(h.box().scrollTop, 0);
    await h.test.mockMouse.click(20, 14); await h.flush();
    await h.publish({ ...h.page, segments: [{ ...h.page.segments[0], text: h.page.segments[0].text + '\n' + 'EXTRA\n'.repeat(40) }] });
    assert.equal(h.box().scrollTop, 0); assert.equal(h.page.follow, false);
  });
  for (const bodyFirst of [false, true]) await scenario('conversation-scope-' + bodyFirst, async h => {
    await h.test.mockMouse.scroll(20, 8, 'up'); await h.flush(); assert.equal(h.page.follow, false);
    const next = { ...h.page, follow: true, segments: [{ ...h.page.segments[0], blockId: 'different', text: 'NEW CONVERSATION\n'.repeat(100) }] };
    if (bodyFirst) await h.publish(next);
    await h.show({ ...h.view, conversationId: 'different-conversation' });
    if (!bodyFirst) await h.publish(next);
    assert.equal(h.box().scrollTop + h.box().viewport.height, h.box().scrollHeight);
  });
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
  await scenario('operation-notice-complete', async h => {
    const kept = '本次输入未接纳，已保留在输入框；原推进目标保持不变，确认验收标准前不执行原任务；可以补充说明，也可以说“直接执行”或“取消”。';
    const failed = '推进准则生成失败：模型回复里没有可识别的结构化内容（structured JSON missing）；输入已保留，可修改后重试。';
    // 折行处的空格落在行尾，比较时两边都去掉空白
    const flat = () => h.test.captureCharFrame().replace(/[│█\s]/gu, '');
    const whole = (value: string) => flat().includes(value.replace(/\s/gu, ''));
    const count = (value: string) => h.test.captureCharFrame().split(value).length - 1;
    // 上一轮已结束（过程区原本只显示“用时”），再收到本次输入的结算说明
    h.root.receive({ type: 'process-status', status: { conversationId: h.view.conversationId, view: { revision: 1, phase: '本轮已结束', activity: 'complete', durationMs: 2000, tools: [], children: [], usage: { contextTokens: 162 } } } });
    for (const [cols, rows] of [[100, 32], [40, 16]] as const) {
      h.test.resize(cols, rows);
      for (const [label, message, error] of [['kept', kept, false], ['failed', failed, true]] as const) {
        h.root.receive({ type: 'task-status', status: error ? { summary: { conversationId: h.view.conversationId, state: 'error', text: 'TASK_FAILED' } } : {} });
        await h.show({ ...h.view, message });
        assert.ok(whole(message), `${cols}x${rows} ${label}: 整段说明可见`);
        assert.equal(count(message.slice(0, 7)), 1, `${cols}x${rows} ${label}: 输入框下不再重复`);
        if (error) assert.ok(h.test.captureCharFrame().includes('TASK_FAILED'), '必须的失败仍可见');
        h.capture(`${cols}x${rows}-${label}`);
      }
      // 真实提交路径：结清消息也写进输入框下的状态槽；过程区已完整显示时只出现一次，草稿保留
      h.root.receive({ type: 'task-status', status: {} });
      await h.show({ ...h.view, message: undefined });
      await h.test.mockInput.typeText('进度怎么样了？'); await h.flush();
      h.test.mockInput.pressEnter(); await new Promise(resolve => setTimeout(resolve, 25)); await h.flush();
      const submit = h.requests.filter((a: TerminalAction) => a.kind === 'input-submit').at(-1) as Extract<TerminalAction, { kind: 'input-submit' }>;
      assert.ok(submit, 'Enter 发起了提交');
      h.root.receive({ type: 'submission', inputId: submit.inputId, version: submit.version, accepted: false, message: kept });
      await h.show({ ...h.view, message: kept });
      assert.ok(whole(kept), `${cols}x${rows} submission: 整段说明可见`);
      assert.equal(count(kept.slice(0, 7)), 1, `${cols}x${rows} submission: 输入框下不再重复`);
      const draft = h.nodes().find((n: any) => n.constructor.name === 'TerminalTextarea');
      assert.equal(draft.plainText, '进度怎么样了？', '未接纳的输入留在输入框');
      h.capture(`${cols}x${rows}-submission-kept`);
      draft.setText(''); await h.flush();
      // 候选打开压缩过程区：说明仍有可见的部分或去处，输入照常；收起候选后恢复整段
      for (const error of [false, true]) {
        h.root.receive({ type: 'task-status', status: error ? { summary: { conversationId: h.view.conversationId, state: 'error', text: 'TASK_FAILED' } } : {} });
        await h.show({ ...h.view, message: kept });
        await h.test.mockInput.typeText('/'); await h.flush();
        const frame = h.test.captureCharFrame();
        // 没有失败时说明本身就是状态行；有失败占了状态行时，状态行指明还有说明、按 Esc 收起候选查看
        assert.ok(frame.includes('本次输入未接纳') || error && frame.includes('Esc 收起候选查看'), `${cols}x${rows} error=${error}: 候选打开时说明仍可见`);
        // 宽窗口里失败原文与指引同行可见；窄窗口一行放不下时保留指引，收起候选后两者都完整
        if (error) assert.ok(cols >= 100 ? frame.includes('TASK_FAILED') : frame.includes('Esc 收起候选查看'));
        const editor = h.nodes().find((n: any) => n.constructor.name === 'TerminalTextarea');
        assert.equal(editor.plainText, '/');
        h.capture(`${cols}x${rows}-candidates-${error ? 'failed' : 'kept'}`);
        h.test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await h.flush();
        h.test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await h.flush();
        assert.ok(whole(kept), `${cols}x${rows} error=${error}: 收起候选后整段可见`);
        if (error) assert.ok(h.test.captureCharFrame().includes('TASK_FAILED'), '收起候选后失败原文可见');
      }
    }
  }, 32);
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
  for (const route of ['selection', 'clear-body', 'clear-editor', 'scrollbar']) {
    for (const successor of ['conversation', 'configuration']) await scenario(`late-reading-${route}-${successor}`, async h => {
      if (route.startsWith('clear')) { await h.test.mockMouse.drag(6, 4, 18, 5); await h.flush(); }
      let reject!: (error: Error) => void;
      h.readWith(() => new Promise((_resolve, fail) => { reject = fail; }));
      if (route === 'selection') await h.test.mockMouse.drag(6, 4, 18, 5);
      else if (route === 'clear-body') await h.test.mockMouse.click(20, 8);
      else if (route === 'clear-editor') {
        const editor = h.nodes().find((n: any) => n.constructor.name === 'TerminalTextarea');
        await h.test.mockMouse.click(editor.x, editor.y);
      } else {
        const bar = h.box().verticalScrollBar;
        await h.test.mockMouse.click(bar.x, bar.slider.getThumbRect().y - 2);
      }
      await h.flush(); assert.ok(reject, 'real interaction issued the retained request');
      h.readWith(undefined);
      if (successor === 'conversation') {
        await h.show({ ...h.view, conversationId: 'new-scope', title: 'NEW_READY', message: 'NEW_READY' });
        await h.publish({ first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'new', role: 'assistant', contentOffset: 0, final: true, text: 'NEW_CONVERSATION_BODY' }] });
      } else await h.show({ kind: 'configuration', title: 'NEW_READY', editId: 'new-config', choices: [{ id: 'field', label: 'NEW_FIELD' }] });
      const before = h.test.captureCharFrame();
      reject(Error('OLD_SCOPE_READ_FAILURE')); await h.flush();
      assert.equal(h.test.captureCharFrame(), before, 'old rejection cannot alter a successor page');
      h.capture('after-old-rejection');
    });
  }
  await scenario('latest-navigation-supersedes-pending-failure', async h => {
    let reject!: (error: Error) => void;
    h.readWith(() => new Promise((_resolve, fail) => { reject = fail; }));
    await h.test.mockMouse.scroll(20, 8, 'up'); await h.flush(); assert.ok(reject);
    h.readWith(undefined); await h.latest();
    reject(Error('OLD_NAVIGATION_FAILURE')); await h.flush();
    assert.equal(h.page.follow, true);
    assert.equal(h.box().scrollTop + h.box().viewport.height, h.box().scrollHeight);
    assert.ok(!h.test.captureCharFrame().includes('读取未完成'));
    assert.ok(!h.test.captureCharFrame().includes('OLD_NAVIGATION_FAILURE'));
  });
  for (const follow of [false, true]) await scenario('current-reading-failure-retry-' + follow, async h => {
    if (follow) { await h.test.mockMouse.drag(6, 4, 18, 5); await h.flush(); }
    h.readWith(async () => { throw Error('CURRENT_READ_FAILURE'); });
    if (follow) await h.test.mockMouse.click(20, 8); else await h.test.mockMouse.drag(6, 4, 18, 5);
    await h.flush(); assert.ok(h.test.captureCharFrame().includes('读取未完成'));
    const before = h.box().scrollTop, selected = h.test.renderer.getSelection()?.getSelectedText();
    h.capture('failed'); h.readWith(undefined);
    h.test.mockInput.pressKey('\x1b[6~'); await h.flush();
    assert.equal(h.page.follow, follow, 'retry repeats the failed intent, not an unrelated navigation');
    assert.equal(h.box().scrollTop, before);
    assert.equal(h.test.renderer.getSelection()?.getSelectedText(), selected);
    assert.ok(!h.test.captureCharFrame().includes('读取未完成'));
    assert.ok(!h.test.captureCharFrame().includes('CURRENT_READ_FAILURE'));
  });
  for (const edit of ['typing', 'paste']) await scenario(`pending-reading-edit-${edit}`, async h => {
    const editor = () => h.nodes().find((n: any) => n.constructor.name === 'TerminalTextarea');
    const editDraft = async () => {
      const expected = editor().plainText + (edit === 'typing' ? 'x' : '中文草稿');
      if (edit === 'typing') h.test.mockInput.pressKey('x');
      else await h.test.mockInput.pasteBracketedText('中文草稿');
      for (let i = 0; i < 25 && editor().plainText !== expected; i++) {
        await new Promise(resolve => setTimeout(resolve, 10)); await h.flush();
      }
      assert.equal(editor().plainText, expected, 'real input or paste completed');
      await h.flush();
    };
    await h.test.mockMouse.drag(6, 4, 18, 5); await h.flush();
    let reject!: (error: Error) => void;
    h.readWith(() => new Promise((_resolve, fail) => { reject = fail; }));
    await h.test.mockMouse.click(20, 8);
    await h.flush(); assert.ok(reject);
    const before = h.box().scrollTop;
    const requestsBeforeEdit = h.requests.filter((a: TerminalAction) => a.kind === 'display-page').length;
    await editDraft();
    assert.equal(h.requests.filter((a: TerminalAction) => a.kind === 'display-page').length, requestsBeforeEdit, 'draft editing is not a new reading intent');
    reject(Error('CURRENT_READ_AFTER_EDIT')); await h.flush();
    h.capture('failed');
    assert.ok(h.test.captureCharFrame().includes('读取未完成'), 'current failure remains visible after editing');
    assert.equal(h.box().scrollTop, before);

    let resolve!: (value: unknown) => void;
    h.readWith(() => new Promise(done => { resolve = done; }));
    h.test.mockInput.pressKey('\x1b[6~'); await h.flush(); assert.ok(resolve);
    await editDraft();
    assert.ok(editor().plainText.includes(edit === 'typing' ? 'xx' : '中文草稿中文草稿'));
    assert.equal(h.requests.filter((a: TerminalAction) => a.kind === 'display-page').at(-1)?.follow, true);
    await h.publish({ ...h.page, follow: true, segments: [{ ...h.page.segments[0], text: h.page.segments[0].text + '\n' + 'EXTRA\n'.repeat(20) }] });
    resolve({ accepted: true }); await h.flush();
    assert.ok(!h.test.captureCharFrame().includes('读取未完成'));
    assert.ok(!h.test.captureCharFrame().includes('CURRENT_READ_AFTER_EDIT'));
    assert.equal(h.page.follow, true);
    assert.equal(h.box().scrollTop + h.box().viewport.height, h.box().scrollHeight, 'successful retry restores follow despite concurrent draft editing');
    h.capture('retry-success');
  });
  await scenario('earlier-history-tall-block-keeps-reading-position', async h => {
    // 按宿主的显示序号复现：已载入 12 段较短内容（-12..-1）；更早一条记录是一个约 240 行的长回复段和它前面的用户短段，
    // 宿主处理 history-previous 时每载入一项就发一页，起点为“原首项 − 4”
    const short = Array.from({ length: 12 }, (_, i) => ({ blockId: `short-${i}`, role: i % 2 ? 'assistant' : 'user', contentOffset: 0, final: true,
      text: Array.from({ length: 5 }, (_, row) => `SHORT-${i}-${row} 较短内容`).join('\n') }));
    const tall = { blockId: 'tall', role: 'assistant', contentOffset: 0, final: true,
      text: Array.from({ length: 120 }, (_, i) => `I-ROW-${i} 中文与英文 mixed words，滚动回看时保持这一行。\n`).join('\n') };
    const opener = { blockId: 'opener', role: 'user', contentOffset: 0, final: true, text: 'E-OPENER 更早记录的用户输入' };
    const store = new Map<number, any>(short.map((segment, i) => [i - 12, segment]));
    let first = -12, sent: BodyPage | undefined;
    const pageAt = (start: number | undefined, follow: boolean): BodyPage => {
      const from = Math.max(first, Math.min(0, start ?? -4));
      return sent = { first, last: 0, start: from, follow, segments: Array.from({ length: Math.min(0, from + 4) - from }, (_, i) => store.get(from + i)) };
    };
    const trace: unknown[] = [];
    // 与宿主同一条投递路径：按修订号发 display-patch，界面解码后并入阅读窗口（display-page 消息会重置窗口，不是这条路径）
    let revision = 1000, previous: BodyPageRevision | undefined;
    const send = (page: BodyPage) => {
      const patch = encodeBodyPage(page, ++revision, previous); previous = { revision, page };
      h.root.receive({ type: 'display-patch', patch });
    };
    h.readWith(async (action: TerminalAction) => {
      if (action.kind === 'display-page') { send(pageAt(action.start, !!action.follow)); return { accepted: true }; }
      const start = first - 4;
      store.set(-13, tall); first = -13; send(pageAt(start, false)); await h.flush();
      store.set(-14, opener); first = -14; send(pageAt(start, false)); await h.flush();
      trace.push({ previousServed: true });
      return { accepted: true, hasEarlier: false };
    });
    await h.show({ ...h.view, historyHasMore: true });
    send(pageAt(undefined, true)); await h.flush(); await h.latest();
    const topRow = () => h.test.captureCharFrame().split('\n').map((row: string) => row.trim()).find((row: string) => /^(SHORT-|I-ROW-|E-OPENER)/u.test(row)) ?? '';
    const seen: string[] = [];
    for (let press = 0; press < 16; press++) {
      h.test.mockInput.pressKey('\x1b[5~'); await h.flush(); await h.flush();
      const row = topRow(); seen.push(row);
      trace.push({ press, top: row, scrollTop: h.box().scrollTop, scrollHeight: h.box().scrollHeight, start: sent?.start, first: sent?.first });
      if (row.startsWith('E-OPENER')) break;
    }
    console.log('EARLIER-TRACE ' + JSON.stringify(trace));
    // 连续：第一次翻进长回复时停在它的末尾附近，而不是直接落到记录开头；之后逐页向上直到第 0 行，最后才看到用户输入
    const firstTall = seen.find(row => row.startsWith('I-ROW-'));
    assert.ok(firstTall && Number(/I-ROW-(\d+)/u.exec(firstTall)![1]) >= 100, `first page into the earlier record starts near its end: ${firstTall}`);
    assert.ok(seen.some(row => row.startsWith('I-ROW-0 ')) || seen.at(-1)?.startsWith('E-OPENER'), 'reading reaches the record start page by page');
  });
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
