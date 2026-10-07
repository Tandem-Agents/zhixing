// Runs with the pinned Bun/native renderer via scripts/test-root.ts.
// This exercises actual layout/input; it does not claim OS IME or clipboard evidence.
import assert from 'node:assert/strict';
import path from 'node:path';
import { setRenderLibPath, type TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import type { TerminalAction, TerminalView } from '../protocol.js';
import { interactionKey } from '../surface-layout.js';
import type { BodyNode, BodyPage } from '../body-model.js';
import type { TerminalPasteSink } from '../paste-stream.js';

process.env.OTUI_ASSET_ROOT = path.resolve(`dist/${process.platform}-${process.arch}/assets`);
setRenderLibPath(path.resolve(`dist/${process.platform}-${process.arch}/${process.platform === 'win32' ? 'opentui.dll' : process.platform === 'darwin' ? 'libopentui.dylib' : 'libopentui.so'}`));
const test = await createTestRenderer({ width: 80, height: 24, useThread: false, consoleMode: 'disabled', exitOnCtrlC: false, otherModifiersMode: true });
const actions: TerminalAction[] = [];
let generation = 0;
const checks: string[] = [];
const frameTimes: number[] = [];
let clipboardReply: (() => Promise<unknown>) | undefined;
let externalPaste: (() => TerminalPasteSink | undefined) | undefined;
const tick = setInterval(() => { void test.renderOnce(); }, 15);
let root: Awaited<ReturnType<typeof createTerminalRoot>> | undefined;
try {
  root = await createTerminalRoot({ signal: new AbortController().signal, exit: async () => {}, inputReady() {},
    request: async action => {
      actions.push(action);
      if (action.kind === 'input-candidates') return { revision: action.revision, start: 0, end: 0, items: [] };
      if (action.kind === 'input-history') return { end: true };
      if (action.kind === 'clipboard-read') return clipboardReply ? clipboardReply() : { text: '字段粘贴' };
      if (action.kind === 'paste-finish') return { text: '右键中文🙂', handles: [], replacePastes: true };
      return { accepted: true };
    } }, async options => { externalPaste = (options as { externalPaste?: () => TerminalPasteSink | undefined })?.externalPaste; return test.renderer; });
  clearInterval(tick);
  const flush = async () => { const start = performance.now(); for (let frame = 0; frame < 4; frame++) await test.renderOnce(); await new Promise<void>(resolve => process.nextTick(resolve)); frameTimes.push(performance.now() - start); };
  const show = async (view: Omit<TerminalView, 'generation'>) => { root!.receive({ type: 'view', view: { ...view, generation: ++generation } }); await flush(); };
  const text = () => test.captureCharFrame();
  const editor = () => {
    const visit = (node: any): TextareaRenderable | undefined => node.constructor.name === 'TerminalTextarea' ? node : node.getChildren?.().map(visit).find(Boolean);
    const found = visit(test.renderer.root); assert.ok(found, 'mounted editor'); return found;
  };
  await show({ kind: 'conversation', title: '知行 · 交互验证', conversationId: 'test' });
  let lines = text().split('\n');
  assert.match(lines.at(-2) ?? '', /输入消息或/);
  assert.equal(editor().height, 1); assert.equal(editor().placeholder, null);
  checks.push('empty input: 3-row frame, common footer, no inline placeholder');
  await show({ kind: 'conversation', title: '知行', conversationId: 'test', busy: true });
  root.receive({ type: 'process-status', status: { conversationId: 'test', view: { revision: 1, phase: '正在回复', tools: [], children: [], usage: {} } } });
  await flush(); assert.match(text(), /正在回复/); assert.ok(!text().includes('正在处理'));
  root.receive({ type: 'process-status', status: undefined });
  await show({ kind: 'conversation', title: '知行 · 交互验证', conversationId: 'test' });
  checks.push('active process uses the shared M1 indicator without another busy row');
  // The upstream mock typeText iterates UTF-16 units. Real stdin carries UTF-8.
  for (const point of '中文 mixed 👨‍👩‍👧‍👦') test.mockInput.pressKey(point);
  await flush();
  assert.equal(editor().plainText, '中文 mixed 👨‍👩‍👧‍👦'); assert.ok(!text().includes('输入消息或'));
  const cursor = editor().cursorOffset;
  const shared = root.information.source(); shared.set('left', 'test', '共享公告'); await flush();
  assert.equal(editor().cursorOffset, cursor); assert.match(text(), /共享公告/);
  checks.push('Chinese/emoji editing and information updates preserve cursor');
  await test.mockInput.typeText('很长的内容'.repeat(40)); await flush();
  assert.ok(editor().height > 1 && editor().height <= 8, JSON.stringify({ height: editor().height, width: editor().width, lines: editor().virtualLineCount, total: editor().editorView.getTotalVirtualLineCount(), length: editor().plainText.length, frame: text() }));
  const draft = editor().plainText;
  await show({ kind: 'configuration', title: '配置', editId: 'edit', choices: [{ id: 'a', label: '第一项' }, { id: 'b', label: '第二项' }] });
  test.mockInput.pressArrow('down'); await flush();
  await show({ kind: 'configuration', title: '配置', editId: 'edit', choices: [{ id: 'a', label: '第一项' }, { id: 'b', label: '第二项' }], message: '状态更新' });
  test.mockInput.pressEnter(); await flush();
  assert.ok(actions.some(action => action.kind === 'configuration-action' && action.action === 'b'));
  await show({ kind: 'configuration', title: '字段', editId: 'edit', field: { id: 'test', label: '输入地址', secret: false } });
  await test.mockInput.typeText('本机字段'); await flush();
  await show({ kind: 'configuration', title: '字段', editId: 'edit', field: { id: 'test', label: '输入地址', secret: false }, message: '刷新' });
  assert.equal(editor().plainText, '本机字段');
  await test.mockMouse.click(20, 8, 2); await flush();
  assert.equal(editor().plainText, '本机字段字段粘贴');
  editor().selectAll(); clipboardReply = async () => ({ text: '' });
  await test.mockMouse.click(20, 8, 2); await flush();
  assert.equal(editor().plainText, '本机字段字段粘贴', 'empty clipboard must not erase selected field');
  test.renderer.keyInput.processPaste(new Uint8Array()); await flush();
  assert.equal(editor().plainText, '本机字段字段粘贴', 'empty native paste must not erase selected field');
  for (const change of ['edit', 'cursor', 'selection', 'refresh'] as const) {
    editor().setText('original'); editor().cursorOffset = 4; await flush();
    let done!: (value: unknown) => void;
    clipboardReply = () => new Promise(resolve => { done = resolve; });
    await test.mockMouse.click(20, 8, 2);
    if (change === 'edit') { editor().cursorOffset = 8; editor().insertText('-new'); editor().selectAll(); }
    if (change === 'cursor') editor().cursorOffset = 8;
    if (change === 'selection') editor().selectAll();
    if (change === 'refresh') await show({ kind: 'configuration', title: '字段', editId: 'edit', field: { id: 'test', label: '输入地址', secret: false }, message: '刷新仍允许原位置粘贴' });
    await flush(); done({ text: 'X' }); await flush();
    assert.equal(editor().plainText, change === 'edit' ? 'original-new' : change === 'refresh' ? 'origXinal' : 'original', `late clipboard: ${change}`);
  }
  checks.push('empty field pastes are no-ops; delayed results cannot replace later edits, cursor or selection');
  editor().setText('keep'); editor().selectAll();
  externalPaste?.()?.end(); await flush(); assert.equal(editor().plainText, 'keep');
  const fieldStream = externalPaste?.(); assert.ok(fieldStream);
  fieldStream.write(new TextEncoder().encode('late'));
  editor().setText('newer'); fieldStream.end(); await flush(); assert.equal(editor().plainText, 'newer');
  let clipboardDone!: (value: unknown) => void;
  clipboardReply = () => new Promise(resolve => { clipboardDone = resolve; });
  await test.mockMouse.click(20, 8, 2);
  const beforePendingSubmit = actions.length;
  test.mockInput.pressEnter(); test.mockInput.pressKey('s', { ctrl: true }); await flush();
  assert.ok(!actions.slice(beforePendingSubmit).some(action => action.kind === 'configuration-action'));
  assert.match(text(), /粘贴仍在处理/);
  await show({ kind: 'conversation', title: '知行', conversationId: 'test' });
  clipboardDone({ text: '不应串页' }); await flush(); clipboardReply = undefined;
  assert.equal(editor().plainText, draft);
  checks.push('page refresh preserves selection and field; return restores main draft');
  const local = root.information.source(interactionKey({ kind: 'conversation', title: '知行', conversationId: 'test', generation }));
  local.set('left', 'notice', '主场景公告');
  await show({ kind: 'selection', title: '临时选择', requestId: 'pick', choices: [{ id: 'a', label: '普通  行' }, { id: 'cancel', label: '取消', danger: true }] });
  assert.ok(!text().includes('主场景公告')); assert.match(text(), /共享公告/); assert.match(text(), /普通░░行░/);
  const late = root.information.source(interactionKey({ kind: 'selection', title: '临时选择', requestId: 'pick', generation }));
  await show({ kind: 'conversation', title: '知行', conversationId: 'test' });
  late.set('left', 'notice', '迟到的旧页面'); await flush();
  assert.match(text(), /主场景公告/); assert.ok(!text().includes('迟到的旧页面'));
  local.dispose();
  checks.push('paused input announcements resume; ended page publishers and clipboard replies cannot leak');
  await show({ kind: 'configuration', title: '保密字段', editId: 'secret', field: { id: 'secret', label: '凭据', secret: true } });
  await test.mockMouse.click(20, 8, 2); await flush();
  assert.match(text(), /••••/); assert.ok(!text().includes('字段粘贴'));
  assert.ok(!actions.some(action => action.kind === 'input-part' && action.text.includes('字段粘贴')));
  clipboardReply = () => new Promise(resolve => { clipboardDone = resolve; });
  await test.mockMouse.click(20, 8, 2); test.mockInput.pressKey('X'); await flush();
  const masked = text(); clipboardDone({ text: 'late' }); await flush();
  assert.equal(text().match(/•+/)?.[0], masked.match(/•+/)?.[0]); clipboardReply = undefined;
  await show({ kind: 'conversation', title: '知行', conversationId: 'test' });
  checks.push('dedicated clipboard field is masked and never enters ordinary draft storage');
  test.resize(40, 12); await flush(); assert.equal(editor().plainText, draft); assert.ok(editor().height <= 4);
  test.resize(100, 30); await flush(); assert.equal(editor().plainText, draft);
  checks.push('narrow/wide resize retains input and bounded viewport');
  const history = { first: 0, start: 0, last: 1, follow: true, segments: [
    { blockId: 'long', contentOffset: 0, role: 'assistant', text: Array.from({ length: 100 }, (_, i) => `history row ${i}`).join('\n'), final: true },
  ] } as const;
  root.receive({ type: 'display-page', page: history }); await flush();
  const before = text(); await test.mockMouse.scroll(20, 8, 'up'); await flush();
  assert.notEqual(text(), before); assert.ok(actions.some(action => action.kind === 'display-page' && !action.follow));
  checks.push('wheel moves retained body without changing input');
  const anchorRow = text().match(/history row \d+/)?.[0]; assert.ok(anchorRow);
  root.receive({ type: 'display-page', page: { ...history, follow: false } }); await flush();
  test.resize(60, 20); await flush(); assert.ok(text().includes(anchorRow), JSON.stringify({ anchorRow, frame: text() }));
  test.resize(100, 30); await flush(); assert.ok(text().includes(anchorRow), JSON.stringify({ anchorRow, frame: text() }));
  checks.push('paused reading anchor survives page acknowledgement and both resize directions');
  const beforePaste = editor().plainText;
  await test.mockMouse.click(20, 8, 2); await flush();
  assert.equal(editor().plainText, beforePaste + '右键中文🙂');
  const afterPaste = text(); await test.mockMouse.scroll(20, 8, 'up'); await flush();
  assert.notEqual(text(), afterPaste); assert.ok(actions.some(action => action.kind === 'clipboard-read' && action.target === 'draft'));
  checks.push('right-button application event pastes through N without disabling wheel');
  await test.mockMouse.drag(5, 5, 19, 6); await flush();
  assert.ok(test.renderer.getSelection()?.getSelectedText().includes('history row'), JSON.stringify({ selection: test.renderer.getSelection()?.getSelectedText(), frame: text() }));
  assert.match(text(), /复制选区/);
  const interrupts = actions.filter(action => action.kind === 'interrupt').length;
  test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush();
  assert.equal(actions.filter(action => action.kind === 'interrupt').length, interrupts);
  checks.push('copy shortcut cannot interrupt a run');
  const paragraphs = (count: number, follow: boolean): BodyPage => {
    let source = ''; const nodes: BodyNode[] = [];
    for (let i = 0; i < count; i++) {
      const line = `paragraph ${i} 中文混排，窄屏需要重新换行。English long line remains readable.`;
      const from = source.length; source += line + '\n\n';
      nodes.push({ from, to: from + line.length, kind: 'paragraph', runs: [{ from, to: from + line.length, text: line, style: 0 }] },
        { from: from + line.length, to: source.length, kind: 'space', runs: [] });
    }
    return { first: 0, last: 1, start: 0, follow, segments: [{ blockId: 'markdown', contentOffset: 0, role: 'assistant', text: source, final: false,
      body: { version: 1, revision: count, kind: 'markdown', end: false, context: { nodes } } }] };
  };
  root.receive({ type: 'display-page', page: paragraphs(30, true) }); await flush();
  await test.mockMouse.scroll(20, 8, 'up'); await flush();
  const paragraphAnchor = text().match(/paragraph \d+/)?.[0]; assert.ok(paragraphAnchor);
  root.receive({ type: 'display-page', page: paragraphs(32, false) }); await flush();
  test.resize(60, 24); await flush(); assert.ok(text().includes(paragraphAnchor), JSON.stringify({ paragraphAnchor, frame: text() }));
  test.resize(100, 30); await flush(); assert.ok(text().includes(paragraphAnchor), JSON.stringify({ paragraphAnchor, frame: text() }));
  checks.push('streamed Markdown nodes preserve the reader through replacement and reflow');
  for (const mode of ['ascii', 'cjk', 'markdown'] as const) {
    await show({ kind: 'configuration', title: '清理选区', editId: 'reset' });
    await show({ kind: 'conversation', title: '选区重排', conversationId: 'selection-test' });
    test.resize(80, 30); await flush();
    const page = (count: number): BodyPage => mode === 'markdown' ? paragraphs(count, false) : ({ first: 0, start: 0, last: 1, follow: false, segments: [{
      blockId: 'selection', contentOffset: 0, role: 'assistant', final: false,
      text: Array.from({ length: count }, (_, i) => `ROW${i}: ` + (mode === 'ascii' ? 'abcde ' : '中文abc ').repeat(16)).join('\n'),
    }] });
    root.receive({ type: 'display-page', page: page(40) }); await flush();
    const rows = text().split('\n').map((line, y) => ({ line, y })).filter(row => row.y >= 4 && /ROW\d+:|paragraph \d+/.test(row.line));
    assert.ok(rows.length >= 2, mode + ': selection rows');
    const x = (row: typeof rows[number]) => Math.max(row.line.indexOf('ROW'), row.line.indexOf('paragraph'));
    await test.mockMouse.drag(x(rows[0]!) + 2, rows[0]!.y, x(rows[1]!) + 18, rows[1]!.y); await flush();
    const selected = test.renderer.getSelection()?.getSelectedText(); assert.ok(selected, mode + ': initial selection');
    root.receive({ type: 'display-page', page: page(42) }); await flush();
    assert.equal(test.renderer.getSelection()?.getSelectedText(), selected, `${mode}: append`);
    test.resize(60, 24); await flush();
    assert.equal(test.renderer.getSelection()?.getSelectedText(), selected, `${mode}: narrow`);
    test.resize(100, 34); await flush();
    assert.equal(test.renderer.getSelection()?.getSelectedText(), selected, `${mode}: wide`);
    assert.ok(editor().focused, 'body selection must not steal input focus');
    const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
    for (const behavior of ['word', 'line'] as const) {
      test.renderer.startSelection(leaf, leaf.x + 3, Math.max(leaf.y, 4), behavior);
      test.renderer.updateSelection(leaf, leaf.x + 6, Math.max(leaf.y, 4), { finishDragging: true }); await flush();
      const expanded = test.renderer.getSelection()!.getSelectedText(); assert.ok(expanded);
      test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
      assert.equal(test.renderer.getSelection()!.getSelectedText(), expanded, `${mode}: ${behavior} selection reflow`);
    }
    const reverseRows = text().split('\n').map((line, y) => ({ line, y })).filter(row => row.y >= 4 && /ROW\d+:|paragraph \d+/.test(row.line));
    await test.mockMouse.drag(x(reverseRows[1]!) + 18, reverseRows[1]!.y, x(reverseRows[0]!) + 2, reverseRows[0]!.y); await flush();
    const reverseText = test.renderer.getSelection()!.getSelectedText(); assert.ok(reverseText);
    root.receive({ type: 'display-page', page: page(44) }); await flush();
    test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), reverseText, `${mode}: backward selection reflow and append`);
  }
  checks.push('ASCII, CJK and Markdown source selections survive append and narrow/wide reflow');
  root.receive({ type: 'display-page', page: { first: 0, start: 0, last: 1, follow: false, segments: [{ blockId: 'single', contentOffset: 0, role: 'assistant', text: 'A 中 B', final: true }] } }); await flush();
  for (const [start, end, behavior, expected] of [[5, 5, 'word', 'A'], [7, 8, 'cell', '中']] as const) {
    await test.mockMouse.drag(5, 4, 9, 4); await flush();
    const leaf = test.renderer.getSelection()!.selectedRenderables[0]!; assert.ok(leaf);
    test.renderer.startSelection(leaf, start, 4, behavior);
    test.renderer.updateSelection(leaf, end, 4, { finishDragging: true }); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), expected);
    test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), expected, 'single-grapheme selection');
  }
  const selectionPage = (text: string): BodyPage => ({ first: 0, start: 0, last: 1, follow: false,
    segments: [{ blockId: 'boundary', contentOffset: 0, role: 'assistant', text, final: false }] });
  test.renderer.clearSelection();
  root.receive({ type: 'display-page', page: selectionPage('alpha beta gamma delta\nsecond row unchanged') }); await flush();
  await test.mockMouse.drag(5, 4, 10, 4); await flush();
  test.resize(60, 24); await flush();
  const restoredSelection = test.renderer.getSelection()!;
  assert.equal(restoredSelection.getSelectedText(), 'alpha ');
  await test.mockMouse.click(22, 4, 0, { modifiers: { ctrl: true } }); await flush();
  assert.equal(test.renderer.getSelection(), restoredSelection, 'Ctrl extends the existing native selection');
  const extendedText = restoredSelection.getSelectedText(); assert.equal(extendedText, 'alpha beta gamma d');
  test.resize(100, 34); await flush();
  assert.equal(test.renderer.getSelection()!.getSelectedText(), extendedText, 'Ctrl extension survives reflow');
  const reverseRanges: string[] = [];
  for (const reflow of [false, true]) {
    test.renderer.clearSelection();
    await test.mockMouse.drag(22, 4, 10, 4); await flush();
    if (reflow) { test.resize(60, 24); await flush(); }
    await test.mockMouse.click(7, 4, 0, { modifiers: { ctrl: true } }); await flush();
    reverseRanges.push(test.renderer.getSelection()!.getSelectedText());
    test.resize(100, 34); await flush();
  }
  assert.equal(reverseRanges[1], reverseRanges[0], 'reflow preserves the anchor of a backward drag');
  for (const [initial, appended] of [['alpha', 'alphabet'], ['A', 'Abc'], ['中', '中文']] as const) {
    for (const behavior of ['word', 'line'] as const) {
      test.renderer.clearSelection();
      root.receive({ type: 'display-page', page: selectionPage(initial) }); await flush();
      await test.mockMouse.doubleClick(5, 4); await flush();
      if (behavior === 'line') {
        const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
        test.renderer.startSelection(leaf, 5, 4, 'line');
        test.renderer.updateSelection(leaf, 5, 4, { finishDragging: true }); await flush();
      }
      assert.equal(test.renderer.getSelection()!.getSelectedText(), initial);
      root.receive({ type: 'display-page', page: selectionPage(appended) }); await flush();
      assert.equal(test.renderer.getSelection()!.getSelectedText(), initial, `${behavior}: appended text is outside the frozen range`);
      test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
      root.receive({ type: 'display-page', page: selectionPage(appended + ' more') }); await flush();
      assert.equal(test.renderer.getSelection()!.getSelectedText(), initial, `${behavior}: repeated append and reflow preserve exact range`);
    }
  }
  checks.push('Ctrl range changes and exact word/line boundaries survive reflow and streaming append');
  for (const glyph of ['中', '🐈', '👨‍👩‍👧']) {
    for (const reverse of [false, true]) {
      for (const target of [5, 10]) {
        const extended: string[] = [];
        for (const reflow of [false, true]) {
          test.renderer.clearSelection(); test.resize(80, 30);
          root.receive({ type: 'display-page', page: selectionPage(`A ${glyph} B`) }); await flush();
          await test.mockMouse.drag(reverse ? 8 : 7, 4, reverse ? 7 : 8, 4); await flush();
          assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph);
          if (reflow) {
            for (const width of [60, 100, 60, 80]) {
              test.resize(width, 30); await flush();
              assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph, `single wide ${glyph}, reverse=${reverse}, width=${width}`);
            }
            root.receive({ type: 'display-page', page: selectionPage(`A ${glyph} B appended`) }); await flush();
            assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph, 'append does not change a single wide selection');
          }
          await test.mockMouse.click(target, 4, 0, { modifiers: { ctrl: true } }); await flush();
          extended.push(test.renderer.getSelection()!.getSelectedText());
        }
        assert.equal(extended[1], extended[0], `single wide ${glyph}, reverse=${reverse}, Ctrl target=${target}`);
      }
    }
  }
  checks.push('single wide/emoji/ZWJ selections preserve both directions, exact text and Ctrl anchor through repeated reflow');
  for (const glyph of ['中', '🐈', '👨‍👩‍👧']) {
    for (const anchorX of [7, 8]) for (const focusX of [5, 10]) for (const ctrlX of [7, 8]) {
      const extended: string[] = [];
      for (const reflow of [false, true]) {
        test.renderer.clearSelection(); test.resize(80, 30);
        root.receive({ type: 'display-page', page: selectionPage(`A ${glyph} B`) }); await flush();
        await test.mockMouse.drag(anchorX, 4, focusX, 4); await flush();
        const original = test.renderer.getSelection()!.getSelectedText();
        if (reflow) { test.resize(60, 24); await flush(); test.resize(80, 30); await flush(); }
        assert.equal(test.renderer.getSelection()!.getSelectedText(), original, 'range keeps both halves of a selected glyph');
        assert.deepEqual(test.renderer.getSelection()!.anchor, { x: anchorX, y: 4 }, 'mouse anchor keeps its actual half-cell');
        await test.mockMouse.click(ctrlX, 4, 0, { modifiers: { ctrl: true } }); await flush();
        extended.push(test.renderer.getSelection()!.getSelectedText());
      }
      assert.equal(extended[1], extended[0], `${glyph}: anchor=${anchorX}, focus=${focusX}, Ctrl=${ctrlX}`);
    }
  }
  for (const behavior of ['word', 'line'] as const) {
    const extended: string[] = [];
    for (const reflow of [false, true]) {
      test.renderer.clearSelection();
      root.receive({ type: 'display-page', page: selectionPage('alpha beta gamma') }); await flush();
      await test.mockMouse.doubleClick(7, 4); await flush();
      if (behavior === 'line') {
        const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
        test.renderer.startSelection(leaf, 7, 4, 'line');
        test.renderer.updateSelection(leaf, 7, 4, { finishDragging: true }); await flush();
      }
      if (reflow) { test.resize(60, 24); await flush(); test.resize(80, 30); await flush(); }
      await test.mockMouse.click(12, 4, 0, { modifiers: { ctrl: true } }); await flush();
      extended.push(test.renderer.getSelection()!.getSelectedText());
    }
    assert.equal(extended[1], extended[0], `${behavior}: reflow preserves subsequent native expansion behavior`);
  }
  checks.push('wide-cell gesture endpoints and word/line behavior survive reflow independently of the exact highlight');
  const responseMs: Record<string, { samples: number[]; p95: number; max: number }> = {};
  const observe = async (name: string, action: () => void | Promise<void>, visible: () => boolean) => {
    const start = performance.now(); await action();
    // Action receipt through the first completed native test frame containing
    // its effect. This is renderer response, not OS input/physical pixel time.
    for (let frame = 0; frame < 8; frame++) {
      await test.renderOnce();
      if (visible()) {
        (responseMs[name] ??= { samples: [], p95: 0, max: 0 }).samples.push(performance.now() - start); return;
      }
    }
    throw Error(`${name}: effect absent after eight frames: ${JSON.stringify({ input: editor().plainText, cursor: editor().cursorOffset, frame: text() })}`);
  };
  for (const workload of ['long-block', 'history-page']) {
    test.renderer.clearSelection(); test.resize(100, 34);
    await show({ kind: 'conversation', title: '响应验收', conversationId: 'response' });
    editor().setText(''); await flush();
    const blockText = Array.from({ length: 350 }, (_, i) => `row ${i}: ${'abcdefgh '.repeat(9)}`).join('\n');
    const page: BodyPage = { first: 0, start: 0, last: workload === 'long-block' ? 1 : 4, follow: false,
      segments: Array.from({ length: workload === 'long-block' ? 1 : 4 }, (_, i) => ({ blockId: `response-${i}`, contentOffset: 0, role: 'assistant', text: blockText, final: true })) };
    root.receive({ type: 'display-page', page }); await flush();
    for (let i = 0; i < 30; i++) {
      const expected = editor().plainText + 'k';
      await observe(`${workload}/input`, () => test.mockInput.pressKey('k'), () => text().includes(expected));
      const beforeScroll = text();
      await observe(`${workload}/scroll`, () => test.mockMouse.scroll(20, 8, i % 2 ? 'up' : 'down'), () => text() !== beforeScroll);
      await show({ kind: 'configuration', title: '响应设置页', editId: `response-${i}` });
      await observe(`${workload}/return`, () => root!.receive({ type: 'view', view: { generation: ++generation, kind: 'conversation', title: '响应验收', conversationId: 'response' } }), () => text().includes(expected) && text().includes('row '));
      const width = i % 2 ? 100 : 60, height = i % 2 ? 34 : 24;
      await observe(`${workload}/resize`, () => test.resize(width, height), () => text().split('\n').length >= height && editor().width === width - 8 && text().includes(expected));
      await flush();
    }
  }
  for (const [name, result] of Object.entries(responseMs)) {
    const sorted = [...result.samples].sort((a, b) => a - b);
    result.p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!; result.max = sorted.at(-1)!;
    assert.ok(result.p95 <= (name.endsWith('/resize') ? 150 : 50) && result.max <= (name.endsWith('/resize') ? 300 : 150), JSON.stringify({ name, result }));
  }
  const active = { kind: 'conversation', title: '容量保护', conversationId: 'response' } as const;
  const keptDraft = editor().plainText;
  await observe('paused-feedback', () => root!.receive({ type: 'view', view: { ...active, generation: ++generation, displayGap: true, displayPaused: true } }), () => text().includes('正文保留已暂停'));
  test.mockInput.pressKey('r', { ctrl: true }); await flush();
  assert.ok(actions.some(action => action.kind === 'display-retry'));
  await show({ ...active, displayGap: true, displayPaused: false });
  assert.match(text(), /展示已恢复/); assert.equal(editor().plainText, keptDraft);
  assert.ok(responseMs['paused-feedback']!.samples[0]! <= 100);
  responseMs['paused-feedback']!.p95 = responseMs['paused-feedback']!.max = responseMs['paused-feedback']!.samples[0]!;
  checks.push('bounded long-block/history roots meet response budgets; capacity retry preserves input and explicit gap');
  assert.ok(test.renderer.listenerCount('selection') <= 2, 'disposed scrollboxes release selection listeners');
  shared.dispose();
  console.log(JSON.stringify({ checks, responseMs, renderMs: { max: Math.max(...frameTimes), samples: frameTimes.length }, frame: text() }, null, 2));
} finally { clearInterval(tick); if (root) await root.dispose(); else test.renderer.destroy(); }
