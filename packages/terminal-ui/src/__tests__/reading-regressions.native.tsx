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
      if (readReply && (action.kind === 'display-page' || action.kind === 'display-earlier')) return readReply(action);
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
  for (const route of ['selection', 'clear-body', 'clear-editor', 'pageup']) {
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
        // 会话正文已无竖条：用键盘翻页作为同一类真实阅读操作
        h.test.mockInput.pressKey('\x1b[5~');
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
    // 宿主处理 display-earlier：已存的直接回紧邻 before 的一页；不够时读一步源（这里一次读入长回复与用户短段），回复里带页，不改显示游标
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
      if (action.kind !== 'display-earlier') return { accepted: true };
      if (action.before <= first && first > -14) { store.set(-13, tall); store.set(-14, opener); first = -14; trace.push({ sourceRead: true }); }
      const end = Math.max(first, action.before), from = Math.max(first, end - 4);
      const page: BodyPage = { first, last: 0, start: from, follow: false, segments: Array.from({ length: end - from }, (_, i) => store.get(from + i)) };
      return { accepted: true, hasEarlier: first > -14, ...(page.segments.length ? { page } : {}) };
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
  // 宿主替身：显示序号 -(older+4)..-1；N 起初只存最后 4 段。display-earlier 已存就回紧邻 before 的一页，不够时“读一步源”前插 4 段；
  // hold=true 时每个 display-earlier 都挂起，直到测试放行（模拟源读在途）。经同一条 display-patch 路径发布跟随页。
  const fakeHistory = (h: any, older: number, options: { hold?: boolean } = {}) => {
    const total = older + 4;
    const seg = (i: number) => ({ blockId: `msg-${i}`, role: i % 2 ? 'assistant' : 'user', contentOffset: 0, final: true,
      text: i % 2 ? `ANSWER-${i} 第一行\nANSWER-${i} 第二行` : `ASK-${i} 问题` });
    const store = new Map<number, any>();
    for (let o = -total; o < 0; o++) store.set(o, seg(o + total));
    const state = { first: -4, earlier: 0, sourceReads: 0, gate: undefined as undefined | { resolve: () => void } };
    let revision = 2000, previous: BodyPageRevision | undefined;
    const send = (start: number | undefined, follow: boolean) => {
      const from = Math.max(state.first, Math.min(0, start ?? -4));
      const page: BodyPage = { first: state.first, last: 0, start: from, follow, segments: Array.from({ length: Math.min(0, from + 4) - from }, (_, i) => store.get(from + i)) };
      const patch = encodeBodyPage(page, ++revision, previous); previous = { revision, page };
      h.root.receive({ type: 'display-patch', patch });
    };
    h.readWith(async (action: TerminalAction) => {
      if (action.kind === 'display-page') { send(action.start, !!action.follow); return { accepted: true }; }
      if (action.kind !== 'display-earlier') return { accepted: true };
      state.earlier++;
      if (options.hold) await new Promise<void>(resolve => { state.gate = { resolve }; });
      if (action.before <= state.first && state.first > -total) { state.first = Math.max(-total, state.first - 4); state.sourceReads++; }
      const end = Math.max(state.first, action.before), from = Math.max(state.first, end - 4);
      const page: BodyPage = { first: state.first, last: 0, start: from, follow: false, segments: Array.from({ length: end - from }, (_, i) => store.get(from + i)) };
      return { accepted: true, hasEarlier: state.first > -total, ...(page.segments.length ? { page } : {}) };
    });
    return { state, send };
  };
  const bodyRows = (h: any) => {
    const rows = h.test.captureCharFrame().split('\n'), end = rows.findIndex((row: string) => row.includes('上方还有内容'));
    assert.ok(end >= 0, 'the reading row offers the upward entry');
    return rows.slice(0, end);
  };
  await scenario('short-tail-prefetch-keeps-first-frame', async h => {
    const fake = fakeHistory(h, 36);
    await h.show({ ...h.view, conversationId: 'prefetch-static', readyForInput: true, historyHasMore: true, message: '已恢复最近对话。' });
    fake.send(undefined, true); await h.flush();
    // 首个可读帧：欢迎框接最后几条消息，上方入口已在；随后整个预取期间逐帧核对正文区原样不动
    const first = bodyRows(h);
    assert.ok(first.join('\n').includes('ANSWER-39') && !first.join('\n').includes('ANSWER-35'));
    for (let i = 0; i < 16; i++) {
      // 预取期间 N 照常发布跟随页（如实时状态刷新），补丁带着前移后的 first：正文仍原样不动
      if (i === 8) fake.send(undefined, true);
      await h.flush(); assert.deepEqual(bodyRows(h), first, `frame ${i} keeps the first readable frame`);
    }
    assert.ok(fake.state.earlier >= 2 && fake.state.sourceReads >= 1, `background fill prepared earlier pages: ${JSON.stringify(fake.state)}`);
    assert.ok(!h.requests.some((a: TerminalAction) => a.kind === 'display-page' && a.start !== undefined && a.start < -4), 'prefetch never moves the display cursor');
    h.capture('prefetched');
    // 缓存已备：只滚一次就揭示，不再请求同一页
    const reads = fake.state.earlier;
    await h.test.mockMouse.scroll(20, 10, 'up'); await h.flush();
    assert.equal(fake.state.earlier, reads, 'the first wheel consumes the prepared page without another read');
    assert.ok(h.test.captureCharFrame().includes('ANSWER-35'), 'older content is revealed by the first wheel');
    h.capture('revealed');
  });
  await scenario('first-scroll-joins-inflight-earlier-read', async h => {
    const fake = fakeHistory(h, 36, { hold: true });
    await h.show({ ...h.view, conversationId: 'prefetch-inflight', readyForInput: true, historyHasMore: true, message: '已恢复最近对话。' });
    fake.send(undefined, true); await h.flush(); await h.flush();
    assert.equal(fake.state.earlier, 1, 'background fill has one read in flight');
    await h.test.mockMouse.scroll(20, 10, 'up'); await h.flush();
    assert.equal(fake.state.earlier, 1, 'the wheel joins the in-flight read instead of starting another');
    assert.ok(!h.test.captureCharFrame().includes('ANSWER-35'));
    fake.state.gate!.resolve(); await h.flush(); await h.flush();
    assert.ok(h.test.captureCharFrame().includes('ANSWER-35'), 'the single wheel is honoured once the read completes');
  });
  await scenario('conversation-start-divider-keeps-rows', async h => {
    const two: BodyPage = { first: 0, last: 2, start: 0, follow: true, segments: [
      { blockId: 'a', role: 'user', contentOffset: 0, final: true, text: 'DIVIDER-ASK 你好' },
      { blockId: 'b', role: 'assistant', contentOffset: 0, final: true, text: 'DIVIDER-ANSWER 你好！' }] };
    const rowOf = (needle: string) => h.test.captureCharFrame().split('\n').findIndex((row: string) => row.includes(needle));
    await h.show({ ...h.view, conversationId: 'divider', historyHasMore: true });
    await h.publish(two);
    const ask = rowOf('DIVIDER-ASK');
    assert.ok(ask > 0); assert.equal(rowOf('对话从这里开始'), -1, 'start not proven yet: no divider');
    await h.show({ ...h.view, conversationId: 'divider', historyHasMore: false });
    const divider = rowOf('对话从这里开始');
    assert.ok(divider >= 0 && divider < ask, 'the divider appears once the start is proven');
    assert.equal(rowOf('DIVIDER-ASK'), ask, 'it uses the existing gap row under the welcome frame; messages do not move');
    h.capture('divider');
    await h.show({ ...h.view, conversationId: 'divider-empty', historyHasMore: false });
    await h.publish({ first: 0, last: 0, start: 0, follow: true, segments: [] });
    assert.equal(rowOf('对话从这里开始'), -1, 'an empty new conversation has no divider');
  });
  await scenario('conversation-switch-drops-late-earlier-reply', async h => {
    const fake = fakeHistory(h, 36, { hold: true });
    await h.show({ ...h.view, conversationId: 'switch-a', readyForInput: true, historyHasMore: true });
    fake.send(undefined, true); await h.flush(); await h.flush();
    assert.equal(fake.state.earlier, 1);
    const gate = fake.state.gate!;
    await h.show({ ...h.view, conversationId: 'switch-b', readyForInput: true, historyHasMore: false });
    await h.publish({ first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'b', role: 'assistant', contentOffset: 0, final: true, text: 'SWITCH-B 新对话' }] });
    gate.resolve(); await h.flush(); await h.flush();
    await h.test.mockMouse.scroll(20, 10, 'up'); await h.flush();
    const frame = h.test.captureCharFrame();
    assert.ok(frame.includes('SWITCH-B') && !frame.includes('ANSWER-'), 'a late reply of the previous conversation never reaches the new one');
  });
  await scenario('prefetch-budget-stops-without-progress', async h => {
    h.readWith(async (action: TerminalAction) => action.kind === 'display-earlier' ? { accepted: true, hasEarlier: true } : { accepted: true });
    await h.show({ ...h.view, conversationId: 'budget', readyForInput: true, historyHasMore: true });
    const mark = h.requests.length;
    await h.publish({ first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'only', role: 'assistant', contentOffset: 0, final: true, text: 'BUDGET 唯一一段' }] });
    for (let i = 0; i < 40; i++) await h.flush();
    const count = h.requests.slice(mark).filter((a: TerminalAction) => a.kind === 'display-earlier').length;
    assert.ok(count > 0 && count <= 16, `background steps are bounded: ${count}`);
    assert.ok(h.test.captureCharFrame().includes('上方还有内容'), 'the entry stays available after the budget stops');
  });
  await scenario('first-gesture-survives-preparing-step', async h => {
    // 实际协议顺序：第一步源端还在准备（有进展、没有正文），第二步才有正文；一次上翻要等到正文出现再结清
    let calls = 0;
    h.readWith(async (action: TerminalAction) => {
      if (action.kind !== 'display-earlier') return { accepted: true };
      calls++;
      if (calls === 1) return { accepted: true, hasEarlier: true, progressed: true };
      return { accepted: true, hasEarlier: false, progressed: true, page: { first: -2, last: 2, start: -2, follow: false, segments: [
        { blockId: 'old-ask', role: 'user', contentOffset: 0, final: true, text: 'PREPARED-OLDER-ASK 更早的问题' },
        { blockId: 'old-answer', role: 'assistant', contentOffset: 0, final: true, text: 'PREPARED-OLDER-ANSWER 更早的回答' }] } };
    });
    // 不可输入：没有后台预取，只看用户这一次手势
    await h.show({ ...h.view, conversationId: 'preparing-gesture', historyHasMore: true });
    await h.publish({ first: 0, last: 2, start: 0, follow: true, segments: [
      { blockId: 'ask', role: 'user', contentOffset: 0, final: true, text: 'CURRENT-ASK 问题' },
      { blockId: 'answer', role: 'assistant', contentOffset: 0, final: true, text: 'CURRENT-ANSWER 回答' }] });
    await h.test.mockMouse.scroll(20, 10, 'up');
    for (let i = 0; i < 12 && !h.test.captureCharFrame().includes('PREPARED-OLDER'); i++) { await h.flush(); await new Promise(resolve => setTimeout(resolve, 40)); }
    assert.equal(calls, 2, 'the same intent continues after a preparing step');
    assert.ok(h.test.captureCharFrame().includes('PREPARED-OLDER-ANSWER'), 'one gesture is honoured once content exists');
  });
  await scenario('stalled-source-ends-as-retryable-failure', async h => {
    let calls = 0;
    h.readWith(async (action: TerminalAction) => {
      if (action.kind === 'display-earlier') calls++;
      return action.kind === 'display-earlier' ? { accepted: true, hasEarlier: true, progressed: false } : { accepted: true };
    });
    await h.show({ ...h.view, conversationId: 'stalled-gesture', historyHasMore: true });
    await h.publish({ first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'only', role: 'assistant', contentOffset: 0, final: true, text: 'STALLED 唯一一段' }] });
    await h.test.mockMouse.scroll(20, 10, 'up');
    for (let i = 0; i < 40 && !h.test.captureCharFrame().includes('读取未完成'); i++) { await h.flush(); await new Promise(resolve => setTimeout(resolve, 60)); }
    assert.ok(h.test.captureCharFrame().includes('读取未完成'), 'a source that never progresses ends in a visible, retryable failure');
    assert.ok(calls >= 5 && calls <= 6, `bounded attempts without busy waiting: ${calls}`);
  });
  await scenario('window-budget-moves-window-on-intent', async h => {
    // 一段很长的思考按 32 KiB 切成多个连续片段，屏上只占两行：已挂 30 段约 960 KiB，接近阅读窗口 1 MiB 上限；N 还存着更早的 4 段。
    // 后台补读取到的页放不下就不保留并停止补读；用户向上到顶时直接揭示，窗口从较新的一侧裁剪后移动
    const length = 32000 + 12, store = new Map<number, any>();
    for (let o = -34; o < 0; o++) store.set(o, { blockId: 'think', role: 'thinking', contentOffset: (o + 34) * length, final: o === -1,
      text: ('x'.repeat(32000) + `
THINK${String(o).padStart(4, ' ')}`).slice(0, length) });
    let revision = 3000, previous: BodyPageRevision | undefined, earlier = 0;
    const page = (from: number, to: number, follow: boolean): BodyPage => ({ first: -34, last: 0, start: from, follow,
      segments: Array.from({ length: to - from }, (_, i) => store.get(from + i)) });
    const send = (value: BodyPage) => { const patch = encodeBodyPage(value, ++revision, previous); previous = { revision, page: value }; h.root.receive({ type: 'display-patch', patch }); };
    h.readWith(async (action: TerminalAction) => {
      if (action.kind === 'display-page') { const from = Math.max(-30, action.start ?? -4); send(page(from, Math.min(0, from + 4), !!action.follow)); return { accepted: true }; }
      if (action.kind !== 'display-earlier') return { accepted: true };
      earlier++;
      const end = action.before, from = Math.max(-34, end - 4);
      return { accepted: true, hasEarlier: false, progressed: true, page: page(from, end, false) };
    });
    await h.show({ ...h.view, conversationId: 'window-budget', historyHasMore: false });
    for (let from = -30; from < 0; from += 4) send(page(from, Math.min(0, from + 4), true));
    await h.flush();
    const before = h.test.captureCharFrame();
    assert.ok(before.includes('THINK  -1'), 'the joined thinking block shows its newest tail');
    await h.show({ ...h.view, conversationId: 'window-budget', historyHasMore: false, readyForInput: true });
    for (let i = 0; i < 10; i++) await h.flush();
    assert.equal(earlier, 1, 'one background step; the page that does not fit is not retained and filling stops');
    assert.ok(h.test.captureCharFrame().includes('THINK  -1'), 'nothing was merged by the background step');
    await h.test.mockMouse.scroll(20, 6, 'up');
    for (let i = 0; i < 6; i++) await h.flush();
    assert.equal(earlier, 2, 'the gesture reads the page again');
    assert.ok(h.test.captureCharFrame().includes('THINK  -5'), 'the window moves: the earlier page is in, the newest carriers are trimmed');
  });
  await scenario('task-summary-occupies-a-row-only-when-ready-with-text', async h => {
    await h.show({ ...h.view, message: '已恢复最近对话。' });
    const above = () => { const rows = h.test.captureCharFrame().split(String.fromCharCode(10)); const box = rows.findLastIndex((row: string) => row.trimStart().startsWith('╭')); return rows.slice(box - 2, box).map((row: string) => row.trim()); };
    const summary = (state: 'loading' | 'ready' | 'error', text: string) => { h.root.receive({ type: 'task-status', status: { summary: { conversationId: h.view.conversationId, state, text } } }); return h.flush(); };
    const idle = above();
    await summary('loading', '正在读取任务列表…');
    assert.deepEqual(above(), idle, 'loading is not an effective summary: no row appears');
    await summary('ready', '');
    assert.deepEqual(above(), idle, 'a ready but empty summary takes no row');
    await summary('ready', '整理桌面 (0/1)');
    assert.equal(above()[0], '整理桌面 (0/1)', 'a ready summary with text sits right above the status row');
    await summary('error', '任务列表暂不可用：连接中断');
    assert.ok(h.test.captureCharFrame().includes('任务列表暂不可用'), 'a failure stays visible');
  });
  await scenario('reveal-inside-one-long-reply-keeps-reading-position', async h => {
    // 同一条长回复按承载片段切开（同一块键、连续偏移）；到顶揭示更早片段时，阅读位置不得跳到新窗口开头
    const lines = 30, store = new Map<number, any>();
    let offset = 0;
    for (let o = -8; o < 0; o++) {
      const text = Array.from({ length: lines }, (_, i) => `CROSS${o}-${String(i).padStart(2, '0')} 同一条长回复`).join('\n') + '\n';
      store.set(o, { blockId: 'long-reply', role: 'assistant', contentOffset: offset, final: o === -1, text,
        body: { version: 1, revision: 1, kind: 'plain', end: o === -1, context: { nodes: [{ kind: 'paragraph', origin: 0, from: offset, to: offset + text.length,
          anchor: offset === 0, runs: [{ from: offset, to: offset + text.length, text, style: 0 }] }] } } });
      offset += text.length;
    }
    let first = -2, revision = 4000, previous: BodyPageRevision | undefined;
    const page = (from: number, to: number, follow: boolean): BodyPage => ({ first, last: 0, start: from, follow, segments: Array.from({ length: to - from }, (_, i) => store.get(from + i)) });
    const send = (value: BodyPage) => { const patch = encodeBodyPage(value, ++revision, previous); previous = { revision, page: value }; h.root.receive({ type: 'display-patch', patch }); };
    h.readWith(async (action: TerminalAction) => {
      if (action.kind === 'display-page') { const from = Math.max(first, action.start ?? -2); send(page(from, Math.min(0, from + 4), !!action.follow)); return { accepted: true }; }
      if (action.kind !== 'display-earlier') return { accepted: true };
      if (action.before <= first) first = Math.max(-8, first - 4);
      const end = action.before, from = Math.max(first, end - 4);
      return { accepted: true, hasEarlier: first > -8, progressed: true, ...(end > from ? { page: page(from, end, false) } : {}) };
    });
    await h.show({ ...h.view, conversationId: 'one-long-reply', historyHasMore: true });
    send(page(-2, 0, true)); await h.flush();
    const header = () => h.test.captureCharFrame().includes('╭──── ╲');
    for (let i = 0; i < 6 && !header(); i++) { h.test.mockInput.pressKey('\x1b[5~'); await h.flush(); }
    assert.ok(header() && h.test.captureCharFrame().includes('CROSS-2-00'), 'reached the top of the mounted part of the reply');
    h.test.mockInput.pressKey('\x1b[5~');
    for (let i = 0; i < 6; i++) await h.flush();
    const frame = h.test.captureCharFrame();
    assert.ok(frame.includes('CROSS-3-'), 'the page right before the old top is revealed');
    assert.ok(!frame.includes('╭──── ╲') && !frame.includes('CROSS-4-00') && !frame.includes('CROSS-6-00'), 'reading continues one page up instead of jumping to the start of the revealed content');
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
