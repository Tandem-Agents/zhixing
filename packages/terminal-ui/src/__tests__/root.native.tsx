// Runs with the pinned Bun/native renderer via scripts/test-root.ts.
// This exercises actual layout/input; it does not claim OS IME or clipboard evidence.
import assert from 'node:assert/strict';
import path from 'node:path';
import { setRenderLibPath, resolveRenderLib, type TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import type { TerminalAction, TerminalView } from '../protocol.js';
import { interactionKey } from '../surface-layout.js';
import type { BodyNode, BodyPage } from '../body-model.js';
import type { TerminalPasteSink } from '../paste-stream.js';
// Exercise the producer/renderer seam, not a hand-authored diff node fixture.
import { TerminalOutputProjection } from '../../../cli/src/terminal/output.js';
import { projectBodyHistory } from '../../../cli/src/terminal/body-projection.js';
import { processArtifactLines, processArtifactSpans, processArtifactText } from '../../../cli/src/terminal/process-presentation.js';

process.env.OTUI_ASSET_ROOT = path.resolve(`dist/${process.platform}-${process.arch}/assets`);
const admittedLibrary = process.env.ZHIXING_TERMINAL_RENDER_LIB;
assert.ok(admittedLibrary, 'test runner supplies the rebuilt admitted native library');
setRenderLibPath(admittedLibrary);
assert.equal(typeof (resolveRenderLib() as any).editorViewSetNoBreakRanges, 'function', 'same bundled FFI binds the new native export');
const test = await createTestRenderer({ width: 80, height: 24, useThread: false, consoleMode: 'disabled', exitOnCtrlC: false, otherModifiersMode: true });
const actions: TerminalAction[] = [];
let generation = 0;
let exits = 0;
const checks: string[] = [];
const frameTimes: number[] = [];
let clipboardReply: (() => Promise<unknown>) | undefined;
let pasteReply: (() => unknown) | undefined;
let externalPaste: (() => TerminalPasteSink | undefined) | undefined;
let readingReply: ((action: TerminalAction) => Promise<unknown>) | undefined;
const pendingRead = () => {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const tick = setInterval(() => { void test.renderOnce(); }, 15);
let root: Awaited<ReturnType<typeof createTerminalRoot>> | undefined;
try {
  root = await createTerminalRoot({ signal: new AbortController().signal, exit: async () => { exits++; }, inputReady() {},
    request: async action => {
      actions.push(action);
      if (readingReply && (action.kind === 'display-page' || action.kind === 'history-previous')) return readingReply(action);
      if (action.kind === 'command-route' && ['help', 'clear'].includes(action.name)) return { route: 'local' };
      if (action.kind === 'input-candidates') {
        if (action.text === '\u3001he') return { revision: action.revision, start: 0, end: 3, ghost: { fullValue: '/help' }, items: [{ id: 'help:repl', label: '/help' }] };
        if (action.text === '/qui') return { revision: action.revision, start: 0, end: 4, ghost: { fullValue: '/quit' }, items: [{ id: 'exit:repl', label: '/exit' }] };
        if (action.text === '/resume ') return { revision: action.revision, start: 8, end: 8, argumentHint: '暂无可切换对话', items: [] };
        return { revision: action.revision, start: 0, end: 0, items: [] };
      }
      if (action.kind === 'candidate-ghost') {
        const query = actions.findLast(item => item.kind === 'input-candidates' && item.revision === action.revision) as Extract<TerminalAction, { kind: 'input-candidates' }> | undefined;
        return { text: query?.text === '\u3001he' ? '/help' : '/quit', execute: false };
      }
      if (action.kind === 'input-history') return { end: true };
      if (action.kind === 'clipboard-read') return clipboardReply ? clipboardReply() : { text: '字段粘贴' };
      if (action.kind === 'clipboard-write') return { state: 'copied' };
      if (action.kind === 'paste-finish') return pasteReply ? pasteReply() : { text: '右键中文🙂', handles: [], replacePastes: true };
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
  await show({ kind: 'conversation', title: '知行', connectionState: 'starting', connected: false, busy: true });
  assert.ok(!text().includes('离线'));
  assert.match(text().split('\n')[0]!, /^╭──── ╲ .*╮$/);
  await test.mockInput.typeText('启动时输入'); await flush();
  const startingActions = actions.length; test.mockInput.pressEnter(); await flush();
  assert.equal(editor().plainText, '启动时输入');
  assert.ok(!actions.slice(startingActions).some(action => action.kind === 'input-submit'));
  await show({ kind: 'conversation', title: '知行', connectionState: 'unavailable', connected: false, message: '连接暂未完成，输入保留。' });
  test.mockInput.pressEnter(); await flush();
  assert.equal(editor().plainText, '启动时输入');
  assert.equal(actions.at(-1)?.kind, 'retry-connection');
  for (const sequence of ['\x1bOQ', '\x1b[12~']) {
    test.mockInput.pressKey(sequence); await flush();
    assert.equal(actions.at(-1)?.kind, 'history-open');
    assert.equal(editor().plainText, '启动时输入');
  }
  for (const sequence of ['\x1bOR', '\x1b[13~']) {
    test.mockInput.pressKey(sequence); await flush();
    assert.equal(actions.at(-1)?.kind, 'configuration-open');
    assert.equal(editor().plainText, '启动时输入');
  }
  checks.push('framed startup, no false offline label; startup/failure keep the same editable draft and explicit retry');
  editor().setText(''); await flush();
  await show({ kind: 'conversation', title: '环境投影', conversationId: 'environment', connected: true,
    environment: { provider: 'provider-one', model: 'model-one', workspace: 'D:/workspace-one' } });
  assert.match(text(), /D:\/workspace-one/); assert.match(text(), /provider-one.*model-one/);
  await test.mockInput.typeText('保留草稿'); await flush();
  await show({ kind: 'conversation', title: '环境投影', conversationId: 'environment', connected: true,
    environment: { provider: 'provider-two', model: 'model-two', workspace: 'E:/workspace-two' } });
  assert.match(text(), /E:\/workspace-two/); assert.match(text(), /provider-two.*model-two/);
  assert.ok(!text().includes('workspace-one')); assert.equal(editor().plainText, '保留草稿');
  test.resize(40, 12); await flush(); assert.ok(editor().height > 0);
  test.resize(80, 24); await flush(); assert.match(text(), /workspace-two/);
  const longDraft = '中文多行草稿内容。'.repeat(80);
  editor().setText(longDraft); await flush();
  for (const height of [24, 20, 19, 18, 17, 16, 12, 24]) {
    test.resize(80, height); await flush();
    assert.match(text(), /Enter 发送/);
    assert.ok(editor().y + editor().height < height - 1, 'editor border and shared footer fit the viewport');
    assert.equal(editor().plainText, longDraft);
  }
  checks.push('measured action area keeps long drafts, input border and footer visible across chrome collapse thresholds');
  for (const busy of [false, true]) {
    await show({ kind: 'conversation', title: '展示暂停', conversationId: 'environment', connected: true,
      displayPaused: true, displayGap: true, busy,
      environment: { provider: 'provider-two', model: 'model-two', workspace: 'E:/workspace-two' } });
    for (const [width, height] of [[40, 12], [40, 16], [80, 24]]) {
      test.resize(width!, height!); await flush();
      assert.match(text(), /Enter 发送/);
      assert.ok(editor().y + editor().height < height! - 1);
      assert.equal(editor().plainText, longDraft);
    }
  }
  checks.push('multiline notices and busy state share the viewport with a scrollable draft and fixed footer');
  editor().setText(''); await flush();
  checks.push('public model and directory refresh in the main header without resetting draft or blocking small-screen input');
  await show({ kind: 'conversation', title: 'slash alias', conversationId: 'slash-alias' });
  for (const command of ['help', 'clear']) {
    const before = actions.length; await test.mockInput.typeText('\u3001' + command); await flush();
    assert.equal(editor().plainText, '\u3001' + command); test.mockInput.pressEnter(); await flush();
    assert.ok(actions.slice(before).some(action => action.kind === 'command-route' && action.name === command));
    assert.ok(actions.slice(before).some(action => action.kind === 'command' && action.name === command));
    assert.ok(!actions.slice(before).some(action => action.kind === 'input-submit'));
  }
  await test.mockInput.typeText('\u3001he'); await flush(); assert.equal(editor().plainText, '\u3001he');
  const aliasTab = actions.length; test.mockInput.pressTab(); await flush(); assert.equal(editor().plainText, '/help');
  assert.ok(actions.slice(aliasTab).some(action => action.kind === 'candidate-ghost'));
  assert.ok(!actions.slice(aliasTab).some(action => action.kind === 'command' || action.kind === 'input-submit'));
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  await test.mockInput.typeText('body\u3001clear'); await flush(); const bodyStart = actions.length;
  test.mockInput.pressEnter(); await flush();
  assert.ok(actions.slice(bodyStart).some(action => action.kind === 'input-submit'));
  assert.ok(!actions.slice(bodyStart).some(action => action.kind === 'command-route' || action.kind === 'command'));
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  checks.push('Chinese slash aliases preserve raw display, route locally, and complete without executing; middle punctuation stays body');
  await show({ kind: 'conversation', title: '补全提示', conversationId: 'hints' });
  await test.mockInput.typeText('/qui'); await flush();
  assert.match(text(), /Tab 补全 \/quit/); assert.equal(editor().plainText, '/qui'); assert.equal(editor().placeholder, null);
  const ghostStart = actions.length; test.mockInput.pressTab(); await flush();
  assert.equal(editor().plainText, '/quit');
  assert.ok(actions.slice(ghostStart).some(action => action.kind === 'candidate-ghost'));
  assert.ok(!actions.slice(ghostStart).some(action => action.kind === 'candidate-accept' || action.kind === 'input-submit' || action.kind === 'command'));
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  assert.equal(editor().plainText, '');
  await test.mockInput.typeText('/resume '); await flush();
  assert.match(text(), /暂无可切换对话/); assert.equal(editor().plainText, '/resume ');
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  checks.push('prefix Tab only fills alias; argument hint remains visible with no items and no inline placeholder');
  const selectionChoices = [{ id: 'disabled', label: '禁用', hotkey: 'x', disabled: true },
    { id: 'first', label: '第一项', hotkey: 'a', detailsActionId: 'detail-first' },
    { id: 'disabled-middle', label: '中间禁用', disabled: true }, { id: 'last', label: '末项', hotkey: 'z' }];
  await show({ kind: 'selection', title: '选择合同', requestId: 'selection-contract', selectionLayer: 'select', initialItemId: 'last', choices: selectionChoices });
  test.mockInput.pressEnter(); await flush();
  assert.ok(actions.at(-1)?.kind === 'selection' && (actions.at(-1) as any).itemId === 'last');
  test.mockInput.pressArrow('up'); await flush(); test.mockInput.pressEnter(); await flush();
  assert.equal((actions.at(-1) as any).itemId, 'first', 'navigation skips disabled item');
  const disabledStart = actions.length; test.mockInput.pressKey('x'); await flush();
  assert.equal(actions.length, disabledStart, 'disabled hotkey cannot activate');
  test.mockInput.pressKey('z'); await flush(); assert.equal((actions.at(-1) as any).itemId, 'last');
  test.mockInput.pressArrow('up'); test.mockInput.pressArrow('right'); await flush();
  assert.equal((actions.at(-1) as any).itemId, 'detail-first', 'Right is a read-only detail intent');
  for (const key of ['c', 'd'] as const) {
    test.mockInput.pressKey(key, { ctrl: true }); await flush();
    assert.equal((actions.at(-1) as any).cancelCause, key === 'c' ? 'ctrl-c' : 'ctrl-d');
  }
  await show({ kind: 'confirmation', title: '再次确认', requestId: 'confirmation-contract', selectionLayer: 'confirm', initialItemId: 'confirm', choices: [{ id: 'back', label: '返回' }, { id: 'confirm', label: '确认' }] });
  test.mockInput.pressEnter(); await flush(); assert.equal((actions.at(-1) as any).action, 'confirm');
  test.mockInput.pressKey('d', { ctrl: true }); await flush(); assert.equal((actions.at(-1) as any).cancelCause, 'ctrl-d');
  await show({ kind: 'selection', title: '详情', requestId: 'details-contract', selectionLayer: 'details', initialItemId: 'return', message: '正文\n'.repeat(30), choices: [{ id: 'next', label: '下一页' }, { id: 'return', label: '返回' }] });
  test.mockInput.pressArrow('down'); await flush(); test.mockInput.pressEnter(); await flush();
  assert.equal((actions.at(-1) as any).itemId, 'return', 'detail scrolling does not activate business choices');
  test.mockInput.pressKey('\x1b[6~'); await flush(); assert.equal((actions.at(-1) as any).itemId, 'next');
  test.mockInput.pressArrow('left'); await flush(); assert.equal((actions.at(-1) as any).itemId, 'return');
  checks.push('selection defaults, enabled navigation, hotkeys, detail intents, confirmation Enter, Ctrl+C/D causes');
  await show({ kind: 'conversation', title: '知行 · 交互验证', conversationId: 'test' });
  let lines = text().split('\n');
  assert.match(lines.at(-2) ?? '', /输入消息或/);
  assert.equal(editor().height, 1); assert.equal(editor().placeholder, null);
  checks.push('empty input: 3-row frame, common footer, no inline placeholder');
  // Enter admitted handles through the same paste completion path as N.
  const atomicText = '1234567890123[A B][C D]z';
  pasteReply = () => ({ text: atomicText, paste: true, handles: [
    { token: '[A B]', id: '11111111-1111-1111-1111-111111111111' },
    { token: '[C D]', id: '22222222-2222-2222-2222-222222222222' },
  ] });
  test.resize(22, 24); await flush();
  const atomicPaste = externalPaste?.(); assert.ok(atomicPaste);
  atomicPaste.write(Buffer.from('payload')); atomicPaste.end(); await flush(); await flush();
  assert.equal(editor().plainText, atomicText, 'paste receipt keeps exact text');
  assert.equal(editor().editorView.getTotalVirtualLineCount(), 2, 'multiple adjacent tokens stay on the continuation');
  // Offsets are ASCII here so native cell and UTF-16 coordinates coincide.
  editor().cursorOffset = 13; await flush();
  assert.equal(editor().editorView.getVisualCursor().visualCol, 0, 'first token starts next visual line');
  editor().cursorOffset = 18; await flush();
  assert.equal(editor().editorView.getVisualCursor().visualCol, 5, 'adjacent token shares row without splitting');
  editor().editorView.setSelection(13, 23);
  assert.equal(editor().getSelectedText(), '[A B][C D]');
  test.resize(12, 24); await flush();
  assert.equal(editor().plainText, atomicText, 'overwide fallback never inserts or truncates text');
  assert.equal(editor().getSelectedText(), '[A B][C D]', 'resize preserves exact selection copy');
  assert.ok(editor().editorView.getTotalVirtualLineCount() > 2, 'narrow token makes bounded char-wrap progress');
  test.resize(22, 24); await flush();
  editor().editorView.resetSelection(); editor().cursorOffset = atomicText.length;
  test.mockInput.pressKey('!'); await flush(); assert.equal(editor().plainText, atomicText + '!');
  assert.ok(editor().undo()); await flush(); assert.equal(editor().plainText, atomicText);
  editor().cursorOffset = 13; await flush(); assert.equal(editor().editorView.getVisualCursor().visualCol, 0, 'undo republishes atomic layout at current native epoch');
  assert.ok(editor().redo()); await flush(); assert.equal(editor().plainText, atomicText + '!');
  editor().cursorOffset = 13; await flush(); assert.equal(editor().editorView.getVisualCursor().visualCol, 0, 'redo republishes atomic layout');
  editor().cursorOffset = 13; test.mockInput.pressArrow('right'); await flush(); assert.equal(editor().cursorOffset, 18, 'same cached ranges drive atomic Right');
  checks.push('admitted multi-token paste, same native FFI, atomic wrap, narrow/wide resize, raw/copy preservation, undo/redo and atomic Right');
  pasteReply = undefined; editor().setText(''); test.resize(80, 24); await flush();
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
  await show({ kind: 'selection', title: '长说明确认', requestId: 'long-selection', message: '逐行核对说明。\n'.repeat(70), choices: [{ id: 'back', label: '暂不执行' }, { id: 'confirm', label: '确认执行', danger: true }] });
  assert.ok(text().includes('暂不执行') && text().includes('确认执行'), 'all actions visible on first long confirmation frame');
  test.resize(40, 16); await flush();
  assert.ok(text().includes('确认执行'), 'resize must preserve visible actions');
  test.resize(80, 24); await flush();
  test.mockInput.pressArrow('down'); await flush(); await flush();
  assert.ok(text().includes('确认执行'), 'keyboard selection must reveal the selected action after long content');
  await show({ kind: 'recovery', title: '保密显示', requestId: 'recovery-hint', recovery: { requestId: 'recovery-hint', pages: 1, input: false } });
  assert.ok(text().includes('Esc 返回')); assert.ok(!text().includes('Enter 确认'));
  checks.push('long selection scrolls the selected action into view; private display has truthful contextual hints');
  test.resize(40, 16); await flush();
  await show({ kind: 'configuration', title: '模型', editId: 'model-narrow', choices: [
    { id: 'flash', label: 'deepseek-ai/DeepSeek-V4-Flash', detail: 'main 推荐' },
    { id: 'pro', label: 'deepseek-ai/DeepSeek-V4-Pro', detail: 'main' },
  ] });
  assert.ok(text().includes('deepseek-ai/DeepSeek-V4-Flash'));
  assert.ok(text().includes('deepseek-ai/DeepSeek-V4-Pro'));
  test.mockInput.pressArrow('down'); await flush(); test.mockInput.pressEnter(); await flush();
  assert.ok(actions.at(-1)?.kind === 'configuration-action' && (actions.at(-1) as any).action === 'pro');
  test.resize(80, 24); await flush();
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
  const historyRows = text().split('\n').map((line, y) => ({ line, y })).filter(row => row.line.includes('history row'));
  assert.ok(historyRows.length >= 5);
  await test.mockMouse.drag(historyRows[2]!.line.indexOf('history row'), historyRows[2]!.y, historyRows[3]!.line.indexOf('history row') + 10, historyRows[3]!.y); await flush();
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
  const selectionOrigin = () => {
    const find = (node: any): any => node.constructor.name === 'BodyTextRenderable' ? node : node.getChildren?.().map(find).find(Boolean);
    const leaf = find(test.renderer.root); assert.ok(leaf, 'body text mounted'); return leaf;
  };
  const sx = (column: number) => selectionOrigin().x + column - 5;
  const sy = () => selectionOrigin().y;
  root.receive({ type: 'display-page', page: { first: 0, start: 0, last: 1, follow: false, segments: [{ blockId: 'single', contentOffset: 0, role: 'assistant', text: 'A 中 B', final: true }] } }); await flush();
  for (const [start, end, behavior, expected] of [[5, 5, 'word', 'A'], [7, 8, 'cell', '中']] as const) {
    await test.mockMouse.drag(sx(5), sy(), sx(9), sy()); await flush();
    const leaf = test.renderer.getSelection()!.selectedRenderables[0]!; assert.ok(leaf);
    test.renderer.startSelection(leaf, sx(start), sy(), behavior);
    test.renderer.updateSelection(leaf, sx(end), sy(), { finishDragging: true }); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), expected);
    test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), expected, 'single-grapheme selection');
  }
  const selectionPage = (text: string): BodyPage => ({ first: 0, start: 0, last: 1, follow: false,
    segments: [{ blockId: 'boundary', contentOffset: 0, role: 'assistant', text, final: false }] });
  test.renderer.clearSelection();
  root.receive({ type: 'display-page', page: selectionPage('alpha beta gamma delta\nsecond row unchanged') }); await flush();
  await test.mockMouse.drag(sx(5), sy(), sx(10), sy()); await flush();
  test.resize(60, 24); await flush();
  const restoredSelection = test.renderer.getSelection()!;
  assert.equal(restoredSelection.getSelectedText(), 'alpha ');
  await test.mockMouse.click(sx(22), sy(), 0, { modifiers: { ctrl: true } }); await flush();
  assert.equal(test.renderer.getSelection(), restoredSelection, 'Ctrl extends the existing native selection');
  const extendedText = restoredSelection.getSelectedText(); assert.equal(extendedText, 'alpha beta gamma d');
  test.resize(100, 34); await flush();
  assert.equal(test.renderer.getSelection()!.getSelectedText(), extendedText, 'Ctrl extension survives reflow');
  const reverseRanges: string[] = [];
  for (const reflow of [false, true]) {
    test.renderer.clearSelection();
    await test.mockMouse.drag(sx(22), sy(), sx(10), sy()); await flush();
    if (reflow) { test.resize(60, 24); await flush(); }
    await test.mockMouse.click(sx(7), sy(), 0, { modifiers: { ctrl: true } }); await flush();
    reverseRanges.push(test.renderer.getSelection()!.getSelectedText());
    test.resize(100, 34); await flush();
  }
  assert.equal(reverseRanges[1], reverseRanges[0], 'reflow preserves the anchor of a backward drag');
  for (const [initial, appended] of [['alpha', 'alphabet'], ['A', 'Abc'], ['中', '中文']] as const) {
    for (const behavior of ['word', 'line'] as const) {
      test.renderer.clearSelection();
      root.receive({ type: 'display-page', page: selectionPage(initial) }); await flush();
      await test.mockMouse.doubleClick(sx(5), sy()); await flush();
      if (behavior === 'line') {
        const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
        test.renderer.startSelection(leaf, sx(5), sy(), 'line');
        test.renderer.updateSelection(leaf, sx(5), sy(), { finishDragging: true }); await flush();
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
          await test.mockMouse.drag(sx(reverse ? 8 : 7), sy(), sx(reverse ? 7 : 8), sy()); await flush();
          assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph);
          if (reflow) {
            for (const width of [60, 100, 60, 80]) {
              test.resize(width, 30); await flush();
              assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph, `single wide ${glyph}, reverse=${reverse}, width=${width}`);
            }
            root.receive({ type: 'display-page', page: selectionPage(`A ${glyph} B appended`) }); await flush();
            assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph, 'append does not change a single wide selection');
          }
          await test.mockMouse.click(sx(target), sy(), 0, { modifiers: { ctrl: true } }); await flush();
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
        await test.mockMouse.drag(sx(anchorX), sy(), sx(focusX), sy()); await flush();
        const original = test.renderer.getSelection()!.getSelectedText();
        if (reflow) { test.resize(60, 24); await flush(); test.resize(80, 30); await flush(); }
        assert.equal(test.renderer.getSelection()!.getSelectedText(), original, 'range keeps both halves of a selected glyph');
        assert.deepEqual(test.renderer.getSelection()!.anchor, { x: sx(anchorX), y: sy() }, 'mouse anchor keeps its actual half-cell');
        await test.mockMouse.click(sx(ctrlX), sy(), 0, { modifiers: { ctrl: true } }); await flush();
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
      await test.mockMouse.doubleClick(sx(7), sy()); await flush();
      if (behavior === 'line') {
        const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
        test.renderer.startSelection(leaf, sx(7), sy(), 'line');
        test.renderer.updateSelection(leaf, sx(7), sy(), { finishDragging: true }); await flush();
      }
      if (reflow) { test.resize(60, 24); await flush(); test.resize(80, 30); await flush(); }
      await test.mockMouse.click(sx(12), sy(), 0, { modifiers: { ctrl: true } }); await flush();
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
      await observe(`${workload}/resize`, () => test.resize(width, height), () => text().split('\n').length >= height && editor().width === width - 6 && text().includes(expected));
      await flush();
    }
  }
  for (const [name, result] of Object.entries(responseMs)) {
    const sorted = [...result.samples].sort((a, b) => a - b);
    result.p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!; result.max = sorted.at(-1)!;
    assert.ok(result.p95 <= (name.endsWith('/resize') ? 150 : 50) && result.max <= (name.endsWith('/resize') ? 300 : 150), JSON.stringify({ name, result }));
  }
  const active = { kind: 'conversation', title: '容量保护', conversationId: 'response' } as const;
  test.renderer.clearSelection(); editor().setText(''); test.resize(80, 24); await flush();
  const many: BodyPage = { first: 0, start: 0, last: 4, follow: true, segments: Array.from({ length: 4 }, (_, page) => {
    let source = ''; const nodes: BodyNode[] = [];
    for (let row = 0; row < 100; row++) {
      const line = `viewport-${String(page * 100 + row).padStart(3, '0')} 中文🙂\n`, from = source.length; source += line;
      nodes.push({ from, to: source.length, kind: 'paragraph', runs: [{ from, to: source.length, text: line, style: 0 }] });
    }
    return { blockId: `viewport-page-${page}`, contentOffset: 0, text: source, role: 'assistant', final: true,
      body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes } } };
  }) };
  const descendants = (node: any): any[] => [node, ...(node.getChildren?.() ?? []).flatMap(descendants)];
  root.receive({ type: 'display-page', page: many }); await flush();
  assert.match(text(), /viewport-399/);
  assert.ok(descendants(test.renderer.root).filter(node => node.constructor.name === 'BodyTextRenderable').length < 100);
  const scroll = descendants(test.renderer.root).find(node => node.constructor.name === 'TerminalScrollBox'); assert.ok(scroll);
  scroll.scrollTo(0); await flush();
  assert.match(text(), /viewport-000/);
  assert.ok(descendants(test.renderer.root).filter(node => node.constructor.name === 'BodyTextRenderable').length < 100);
  checks.push('large semantic page keeps only viewport text leaves live and preserves first/last scroll reachability');
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
  // Reading failures are ordinary UI states across every input route, never
  // entry-level unhandled rejections. Latest intent supersedes pending reads.
  const unhandled: unknown[] = [], onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    test.resize(45, 20); test.renderer.clearSelection();
    const oldPage: BodyPage = { first: 0, last: 9, start: 4, follow: false,
      segments: [{ blockId: 'old', contentOffset: 0, role: 'assistant', text: 'OLD BODY', final: true }] };
    const latest: BodyPage = { first: 0, last: 9, start: 8, follow: true,
      segments: [{ blockId: 'latest', contentOffset: 0, role: 'assistant', text: 'LATEST BODY\n' + 'latest line\n'.repeat(10), final: true }] };
    for (const route of ['keyboard', 'wheel', 'bottom', 'click'] as const) {
      await show({ kind: 'conversation', title: '读取恢复', conversationId: `read-${route}`, connected: true });
      readingReply = undefined; root.receive({ type: 'display-page', page: oldPage }); await flush();
      const pending = pendingRead();
      readingReply = () => pending.promise;
      const start = actions.length;
      if (route === 'keyboard') test.mockInput.pressKey('\x1b[5~');
      else if (route === 'wheel') await test.mockMouse.scroll(20, 8, 'up');
      else if (route === 'bottom') test.mockInput.pressKey('\x1b[1;5F');
      else { const row = text().split('\n').findIndex(line => line.includes('下方还有内容')); assert.ok(row >= 0); await test.mockMouse.click(5, row); }
      await flush();
      assert.ok(actions.slice(start).some(a => a.kind === 'display-page' || a.kind === 'history-previous'));
      pending.reject(Error('synthetic read unavailable')); await flush(); await flush();
      assert.match(text(), /读取未完成/); assert.ok(editor());
      readingReply = async () => { root!.receive({ type: 'display-page', page: latest }); return { accepted: true }; };
      test.mockInput.pressKey('\x1b[1;5F'); await flush();
      assert.match(text(), /LATEST BODY|latest line/); assert.doesNotMatch(text(), /读取未完成/);
    }
    for (const failed of [true, false]) {
      readingReply = undefined;
      await show({ kind: 'conversation', title: '乱序读取', conversationId: `late-read-${failed}`, connected: true });
      root.receive({ type: 'display-page', page: oldPage }); await flush();
      const pending = pendingRead();
      readingReply = async action => {
        if (action.kind === 'display-page' && action.follow) { root!.receive({ type: 'display-page', page: latest }); return { accepted: true }; }
        return pending.promise;
      };
      test.mockInput.pressKey('\x1b[5~'); await flush();
      test.mockInput.pressKey('\x1b[1;5F'); await flush();
      if (failed) pending.reject(Error('late old-page failure')); else pending.resolve({ accepted: true });
      await flush(); await flush();
      assert.match(text(), /LATEST BODY|latest line/); assert.doesNotMatch(text(), /读取未完成|正在读取/);
    }
    assert.deepEqual(unhandled, []);
    checks.push('keyboard/wheel/latest read failures remain local and retryable; superseded success/failure cannot alter latest reading state');
  } finally { readingReply = undefined; process.off('unhandledRejection', onUnhandled); }
  const blankCases = { trailing: ['alpha();', ''], only: [''], onlyTwo: ['', ''], onlyThree: ['', '', ''],
    leading: ['', 'omega();'], middle: ['alpha();', '', 'omega();'], twoTrailing: ['alpha();', '', ''],
    wrapped: ['const 中文 = "🙂"; ' + 'value '.repeat(12), ''] };
  const beforeBlankInterrupts = actions.filter(action => action.kind === 'interrupt').length, beforeBlankExits = exits;
  for (const [name, contents] of Object.entries(blankCases)) for (const width of [45, 80]) for (const reverse of [false, true]) {
    test.renderer.clearSelection(); test.resize(width, 24);
    await show({ kind: 'conversation', title: '空白差异行', conversationId: `blank-diff-${name}-${width}-${reverse}`, connected: true });
    const segments: BodyPage['segments'][number][] = [];
    const producer = new TerminalOutputProjection(async segment => { segments.push(segment); }, async () => {}, async error => { throw error; },
      { work: action => action(), amend: async () => {}, seal: async () => {} });
    const artifact = { kind: 'file-diff' as const, path: 'blank.ts', operation: 'modified' as const,
      changeStats: { kind: 'exact' as const, addedLines: contents.length, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: contents.length,
        lines: contents.map((content, index) => ({ type: 'added' as const, newLineNumber: index + 1, content })) }] };
    producer.appendProcessBlock({ blockId: 'native-blank-diff', role: 'tool-diff', text: processArtifactText(artifact), lines: processArtifactLines(artifact), spans: processArtifactSpans(artifact) });
    await producer.drain(); await producer.close();
    const page = { first: 0, last: segments.length, start: 0, follow: false, segments };
    root.receive({ type: 'display-page', page }); await flush();
    const rows = text().split('\n'), displayed = rows.map((row, y) => ({ row, y })).filter(({ row }) => /\+ \d+  /u.test(row));
    assert.equal(displayed.length, contents.length, text());
    for (let i = 0; i < contents.length; i++) assert.ok(displayed[i]!.row.includes(`+ ${i + 1}  ${contents[i]!.slice(0, 10)}`), text());
    const expected = contents.join('\n');
    if (expected) {
      const x = displayed[0]!.row.indexOf('+ 1  ') + 5;
      const first = { x, y: displayed[0]!.y }, last = { x: x + contents.at(-1)!.length, y: displayed.at(-1)!.y };
      const from = reverse ? last : first, to = reverse ? first : last;
      await test.mockMouse.drag(from.x, from.y, to.x, to.y); await flush();
      const copy = async (stage: string) => {
        const count = actions.filter(a => a.kind === 'clipboard-write').length;
        test.mockInput.pressKey('c', { ctrl: true }); await flush();
        const copies = actions.filter(a => a.kind === 'clipboard-write');
        assert.equal(copies.length, count + 1, `${name}/${width}/${reverse}/${stage}: copy must win over interrupt`);
        assert.equal((copies.at(-1) as { text: string }).text, expected, `${name}/${width}/${reverse}/${stage}`);
      };
      await copy('initial');
      test.resize(width === 45 ? 80 : 45, 24); await flush(); await copy('reflow');
      root.receive({ type: 'display-page', page: JSON.parse(JSON.stringify(page)) }); await flush(); await copy('equivalent page');
      test.resize(width, 24); await flush(); await copy('reflow back');
    }
  }
  assert.equal(actions.filter(action => action.kind === 'interrupt').length, beforeBlankInterrupts);
  assert.equal(exits, beforeBlankExits);
  checks.push('production diff source selection: 28 copying cases + 4 single-empty display cases; forward/reverse, 45/80 columns, repeated reflow and equivalent pages; no interrupt or exit');
  // Diff decorations occupy a nonselectable gutter. Unicode source selection
  // and wrapped continuation use the same content column at both widths.
  for (const columns of [45, 80]) {
    test.resize(columns, 24); test.renderer.clearSelection();
    await show({ kind: 'conversation', title: '差异复制', conversationId: `diff-copy-${columns}`, connected: true });
    const code = 'const 中文 = "🙂"; ' + 'long_value '.repeat(7), source = code + '\n\nsecond();';
    const node = (from: number, to: number, decoration: string) => ({ from, to, origin: from, kind: 'paragraph' as const, decoration,
      runs: [{ from, to: to > from && source[to - 1] === '\n' ? to - 1 : to, text: source.slice(from, to).replace(/\n$/u, ''), style: 0, semantic: 'added' as const }] });
    root.receive({ type: 'display-page', page: { first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'diff-copy', contentOffset: 0,
      role: 'tool-diff', text: source, final: true, body: { version: 1, revision: 0, kind: 'plain', end: true,
        context: { nodes: [node(0, code.length + 1, '+ 12  '), node(code.length + 1, code.length + 2, '+ 13  '), node(code.length + 2, source.length, '+ 14  ')] } } }] } });
    await flush();
    const rows = text().split('\n'), first = rows.findIndex(row => row.includes('const 中文')), last = rows.findIndex(row => row.includes('second();'));
    assert.ok(first >= 0 && last > first);
    const x = rows[first]!.indexOf('const');
    assert.equal(rows[last]!.indexOf('second();'), x);
    assert.equal(rows[first + 1]!.slice(0, x).trim(), '', 'wrapped code aligns past the gutter');
    await test.mockMouse.drag(x, first, x + 'second();'.length, last); await flush();
    const start = actions.length; test.mockInput.pressKey('c', { ctrl: true }); await flush();
    const copied = actions.slice(start).find(a => a.kind === 'clipboard-write');
    assert.ok(copied?.kind === 'clipboard-write'); assert.equal(copied.text, source, JSON.stringify({ columns, frame: text() }));
  }
  checks.push('diff gutter excluded from Unicode multi-line copy and wrapped content aligned at 45/80 columns');
  const noBodyCopy = async (scenario: string) => {
    const count = actions.filter(action => action.kind === 'clipboard-write').length;
    assert.doesNotMatch(text(), /复制选区/, scenario);
    test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush();
    assert.equal(actions.filter(action => action.kind === 'clipboard-write').length, count, scenario);
  };
  test.renderer.clearSelection(); await flush();
  const gutterRow = text().split('\n').findIndex(row => row.includes('+ 12'));
  const gutterX = text().split('\n')[gutterRow]!.indexOf('+ 12');
  await test.mockMouse.drag(gutterX, gutterRow, gutterX + 3, gutterRow); await flush();
  await noBodyCopy('decoration alone is not source selection');
  test.renderer.clearSelection(); editor().setText('draft only'); editor().selectAll(); await flush();
  await noBodyCopy('editor selection is not body selection');
  editor().editorView.resetSelection();
  const bodyRows = text().split('\n'), bodyY = bodyRows.findIndex(row => row.includes('const 中文'));
  const bodyX = bodyRows[bodyY]!.indexOf('const');
  await test.mockMouse.drag(bodyX, bodyY, bodyX + 5, bodyY); await flush();
  assert.match(text(), /复制选区/);
  await show({ kind: 'conversation', title: '新对话', conversationId: 'copy-new-conversation', connected: true });
  root.receive({ type: 'display-page', page: { first: 0, start: 0, last: 1, follow: false,
    segments: [{ blockId: 'fresh-body', contentOffset: 0, role: 'assistant', text: 'New body', final: true }] } }); await flush();
  await noBodyCopy('old conversation selection cannot copy from the new page');
  await show({ kind: 'configuration', title: '字段复制边界', editId: 'copy-field', field: { id: 'copy-field', label: '字段', secret: false } });
  editor().setText('field only'); editor().selectAll(); await flush();
  await noBodyCopy('field selection never enters body copy');
  checks.push('source selection ownership excludes decoration-only, draft, field and previous conversation');
  test.renderer.clearSelection(); test.resize(80, 24);
  await show({ kind: 'conversation', title: 'Markdown 复制', conversationId: 'mapped-copy', connected: true });
  const mapped: BodyPage['segments'][number][] = [];
  for await (const part of projectBodyHistory('- **🙂甲**\t尾部\n', 'markdown', 'forward', async () => {}))
    mapped.push({ blockId: 'mapped-copy', contentOffset: part.contentOffset, role: 'assistant', text: part.text, body: part.body, final: part.body.end });
  root.receive({ type: 'display-page', page: { first: 0, last: mapped.length, start: 0, follow: false, segments: mapped } }); await flush();
  const mappedRows = text().split('\n'), mappedY = mappedRows.findIndex(row => row.includes('尾部'));
  const tabX = mappedRows[mappedY]!.indexOf('尾部') - 3;
  await test.mockMouse.drag(tabX, mappedY, tabX + 2, mappedY); await flush();
  const selectedSpaces = test.renderer.getSelection()!.getSelectedText();
  assert.match(selectedSpaces, /^ {1,3}$/u, 'only part of the four rendered spaces is selected');
  const mappedCount = actions.filter(action => action.kind === 'clipboard-write').length;
  test.mockInput.pressKey('c', { ctrl: true }); await flush();
  const mappedCopies = actions.filter(action => action.kind === 'clipboard-write');
  assert.equal(mappedCopies.length, mappedCount + 1, 'partial expanded tab retains a nonempty selection');
  assert.equal((mappedCopies.at(-1) as { text: string }).text, selectedSpaces, 'source mapping does not round away selected rendered text');
  for (const width of [45, 80]) {
    test.resize(width, 24); await flush();
    assert.equal(test.renderer.getSelection()!.getSelectedText(), selectedSpaces, 'expanded tab highlight survives reflow');
    const count = actions.filter(action => action.kind === 'clipboard-write').length;
    test.mockInput.pressKey('c', { ctrl: true }); await flush();
    const copies = actions.filter(action => action.kind === 'clipboard-write');
    assert.equal(copies.length, count + 1);
    assert.equal((copies.at(-1) as { text: string }).text, selectedSpaces);
  }
  checks.push('partial expanded Markdown tab keeps exact highlight and copied text through reflow');
  for (const reverse of [false, true]) for (const replacePage of [false, true]) for (const endCell of [1, 2, 7]) {
    test.renderer.clearSelection(); test.resize(80, 24);
    await show({ kind: 'conversation', title: '表格选区', conversationId: `table-selection-${reverse}-${replacePage}-${endCell}`, connected: true });
    const segments: BodyPage['segments'][number][] = [];
    const source = '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| alpha | beta | gamma | delta | eps | zeta | eta | theta |\n';
    for await (const part of projectBodyHistory(source, 'markdown', 'forward', async () => {}))
      segments.push({ blockId: 'table-selection', contentOffset: part.contentOffset, role: 'assistant', text: part.text, body: part.body, final: part.body.end });
    const page = { first: 0, last: segments.length, start: 0, follow: false, segments };
    root.receive({ type: 'display-page', page }); await flush();
    const point = (value: string) => {
      const rows = text().split('\n'), y = rows.findIndex(row => row.includes(value)); assert.ok(y >= 0, text());
      return { x: rows[y]!.indexOf(value), y };
    };
    const cells = ['alpha', 'beta', 'gamma', 'delta', 'eps', 'zeta', 'eta', 'theta'];
    const chosen = cells.slice(0, endCell + 1), expected = chosen.join('\t');
    const a = point('alpha'), b = point(cells[endCell]!); b.x += cells[endCell]!.length;
    await test.mockMouse.drag(reverse ? b.x : a.x, reverse ? b.y : a.y, reverse ? a.x : b.x, reverse ? a.y : b.y); await flush();
    const checkCopy = async (expected: string) => {
      const count = actions.filter(action => action.kind === 'clipboard-write').length;
      test.mockInput.pressKey('c', { ctrl: true }); await flush();
      const copies = actions.filter(action => action.kind === 'clipboard-write');
      assert.equal(copies.length, count + 1);
      assert.equal((copies.at(-1) as { text: string }).text, expected, `table reverse=${reverse} replace=${replacePage} end=${endCell}`);
    };
    await checkCopy(expected);
    for (const width of [45, 80, 45, 80]) {
      test.resize(width, 24); await flush();
      if (replacePage) { root.receive({ type: 'display-page', page: JSON.parse(JSON.stringify(page)) }); await flush(); }
      await checkCopy(expected);
      if (width === 80 || endCell === 1) {
        const leaves = test.renderer.getSelection()!.selectedRenderables.map(leaf => leaf.getSelectedText());
        assert.deepEqual(leaves, chosen, 'all source cells retain their highlight when visible again');
      }
    }
    const gamma = point('gamma');
    await test.mockMouse.drag(gamma.x, gamma.y, gamma.x + 5, gamma.y); await flush();
    await checkCopy('gamma');
    test.renderer.clearSelection(); await flush(); await noBodyCopy('cleared table selection must not reappear');
  }
  checks.push('production table cross-cell source selection survives repeated horizontal/stacked layout, equivalent pages, reverse gestures, replacement and clear');
  console.log(JSON.stringify({ checks, responseMs, renderMs: { max: Math.max(...frameTimes), samples: frameTimes.length }, frame: text() }, null, 2));
} finally { clearInterval(tick); if (root) await root.dispose(); else test.renderer.destroy(); }
