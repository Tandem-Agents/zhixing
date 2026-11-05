import assert from 'node:assert/strict';
import path from 'node:path';
import { setRenderLibPath, resolveRenderLib, OptimizedBuffer, RGBA, TextAttributes, type TextareaRenderable } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import { type TerminalAction, type TerminalView } from '../protocol.js';
import { interactionKey } from '../surface-layout.js';
import { type BodyNode, type BodyPage } from '../body-model.js';
import { type TerminalPasteSink } from '../paste-stream.js';
import { TerminalOutputProjection } from '../../../cli/src/terminal/output.js';
import { projectBodyHistory } from '../../../cli/src/terminal/body-projection.js';
import { processArtifactLines, processArtifactSpans, processArtifactText } from '../../../cli/src/terminal/process-presentation.js';
import { securityOverview, securityRulesDetail } from '../../../cli/src/security/security-summary.js';
// Runs with the pinned Bun/native renderer via scripts/test-root.ts.
// This exercises actual layout/input; it does not claim OS IME or clipboard evidence.









// 测试默认的阅读身份：视图声明与整页基准携带同一个，正文按匹配显示；切换会话类用例自行换代
const TEST_READING = { conversationId: 'test', generation: 1 };
let baselineRevision = 0;
const baseline = (reading = TEST_READING) => ({ revision: ++baselineRevision, reading });

// Exercise the producer/renderer seam, not a hand-authored diff node fixture.










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
let candidateReply: ((action: Extract<TerminalAction, { kind: 'input-candidates' }>) => Promise<unknown>) | undefined;
// 进页保持场景：按需延后候选应答、命令路由与命令本身
let entryReply: ((action: TerminalAction) => Promise<unknown> | undefined) | undefined;
// 复制场景：按需改写剪贴板写入的结果（失败、未确认）
let clipboardWriteReply: (() => Promise<unknown>) | undefined;
const usableFrames: number[] = [];
const pendingRead = () => {
  let resolve!: (value: unknown) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const tick = setInterval(() => { void test.renderOnce(); }, 15);
let root: Awaited<ReturnType<typeof createTerminalRoot>> | undefined;
try {
  root = await createTerminalRoot({ signal: new AbortController().signal, exit: async () => { exits++; }, inputReady() {},
    usableFrame(frameId) { usableFrames.push(frameId); },
    request: async action => {
      actions.push(action);
      if (readingReply && (action.kind === 'display-page' || action.kind === 'display-earlier')) return readingReply(action);
      const entry = entryReply?.(action); if (entry) return entry;
      if (action.kind === 'command-route' && ['help', 'clear'].includes(action.name)) return { route: 'local' };
      if (action.kind === 'input-candidates') {
        if (candidateReply) return candidateReply(action);
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
      if (action.kind === 'clipboard-write') return clipboardWriteReply ? clipboardWriteReply() : { state: 'copied' };
      if (action.kind === 'paste-finish') return pasteReply ? pasteReply() : { text: '右键中文🙂', handles: [], replacePastes: true };
      return { accepted: true };
    } }, async options => { externalPaste = (options as { externalPaste?: () => TerminalPasteSink | undefined })?.externalPaste; return test.renderer; });
  clearInterval(tick);
  const flush = async () => { const start = performance.now(); for (let frame = 0; frame < 4; frame++) await test.renderOnce(); await new Promise<void>(resolve => process.nextTick(resolve)); frameTimes.push(performance.now() - start); };
  const show = async (view: Omit<TerminalView, 'generation'>) => { root!.receive({ type: 'view', view: { reading: TEST_READING, ...view, generation: ++generation } }); await flush(); };
  const text = () => test.captureCharFrame();
  const editor = () => {
    const visit = (node: any): TextareaRenderable | undefined => node.constructor.name === 'TerminalTextarea' ? node : node.getChildren?.().map(visit).find(Boolean);
    const found = visit(test.renderer.root); assert.ok(found, 'mounted editor'); return found;
  };
  // Borders must obey the same nested viewport clip as text, on every edge.
  // Exercise the shipped native buffer directly, including its transparent fast path.
  const clippedBuffer = OptimizedBuffer.create(12, 8, test.renderer.widthMethod);
  try {
    const white = RGBA.fromValues(1, 1, 1, 1), transparent = RGBA.fromValues(0, 0, 0, 0);
    const fill = () => { clippedBuffer.clear(); for (let y = 0; y < 8; y++) clippedBuffer.drawText('.'.repeat(12), 0, y, white); };
    for (const border of [true, ['bottom']] as const) {
      const draw = () => clippedBuffer.drawBox({ x: 1, y: 1, width: 8, height: 5, border: border === true ? true : [...border], borderColor: white, backgroundColor: transparent });
      fill(); draw(); const full = [...clippedBuffer.buffers.char];
      for (const clips of [[[0, 0, 12, 8]], [[0, 0, 12, 2]], [[0, 4, 12, 4]], [[3, 0, 4, 8]], [[0, 0, 12, 7], [2, 2, 5, 3]], [[10, 0, 2, 8]]]) {
        fill(); const before = [...clippedBuffer.buffers.char];
        for (const [x, y, width, height] of clips) clippedBuffer.pushScissorRect(x!, y!, width!, height!);
        draw();
        for (let y = 0; y < 8; y++) for (let x = 0; x < 12; x++) {
          const inside = clips.every(([left, top, width, height]) => x >= left! && y >= top! && x < left! + width! && y < top! + height!);
          assert.equal(clippedBuffer.buffers.char[y * 12 + x], (inside ? full : before)[y * 12 + x], `border clip at ${x},${y}: ${JSON.stringify(clips)}`);
        }
        for (const _ of clips) clippedBuffer.popScissorRect();
      }
    }
  } finally { clippedBuffer.destroy(); }
  checks.push('native transparent borders obey every viewport edge and nested clips without changing visible cells');
  await show({ kind: 'conversation', title: '知行', connectionState: 'starting', connected: false, busy: true });
  assert.ok(!text().includes('离线'));
  assert.match(text().split('\n')[0]!.slice(0, -1), /^ ╭──── ╲ .*╮$/);
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
  await show({ kind: 'conversation', title: '知行', connected: true, busy: true });
  test.mockInput.pressEnter(); await flush();
  await show({ kind: 'conversation', title: '知行', connected: true, busy: true, inputReceiptPending: true, message: '尚未确认原输入的接纳结果；草稿已保留。' });
  assert.ok(text().includes('原输入结果待核对'));
  assert.ok(text().includes('Ctrl+R 核对'));
  assert.ok(!text().includes('正在保存并提交输入'));
  test.mockInput.pressKey('\x12'); await flush();
  assert.equal(actions.at(-1)?.kind, 'retry-connection');
  test.mockInput.pressKey('\x03'); await flush();
  assert.equal(actions.at(-1)?.kind, 'interrupt');
  checks.push('pending input receipt overrides stale submit hints and exposes actual recovery/cancel actions');
  const receiptSubmission = actions.findLast(action => action.kind === 'input-submit') as Extract<TerminalAction, {kind: 'input-submit'}>;
  assert.ok(receiptSubmission);
  root.receive({type: 'submission', inputId: receiptSubmission.inputId, version: receiptSubmission.version, accepted: false}); await flush();
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
  // 候选打开时第一次 Esc 只收起候选、保留草稿；第二次 Esc 才清空
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  assert.equal(editor().plainText, '/resume ');
  test.mockInput.pressEscape(); await new Promise(resolve => setTimeout(resolve, 25)); await flush();
  assert.equal(editor().plainText, '');
  checks.push('prefix Tab only fills alias; argument hint remains visible with no items and no inline placeholder; Esc collapses then clears');
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
  // 权限确认外层 Esc 即拒绝；内层二次确认仍先返回
  await show({ kind: 'confirmation', title: '工具权限', requestId: 'permission-hint', choices: [{ id: 'allow', label: '允许这一次' }, { id: 'deny', label: '拒绝本次操作' }] });
  assert.ok(text().includes('Esc 拒绝') && !text().includes('Esc 返回'), 'outer permission page names Esc as deny');
  await show({ kind: 'confirmation', title: '保存这条授权规则？', requestId: 'permission-inner', selectionLayer: 'confirm', choices: [{ id: 'return', label: '返回' }, { id: 'confirm', label: '确认保存并允许' }] });
  assert.ok(text().includes('Esc 返回') && !text().includes('Esc 拒绝'), 'inner confirmation still returns first');
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
  // 缩放后配置页的选中项仍在可视区：标签随宽度重新折行，新尺寸布局要多帧才落定，落定后再定位
  await show({ kind: 'configuration', title: '长配置', editId: 'resize-follow', choices: Array.from({ length: 30 }, (_, index) => ({ id: `row-${index}`, label: `配置项 ${index} ${'说明'.repeat(14)}` })) });
  for (let step = 0; step < 25; step++) { test.mockInput.pressArrow('down'); await flush(); }
  assert.match(text(), /配置项 25 说/);
  test.resize(60, 12); await flush(); await flush();
  assert.match(text(), /配置项 25 说/, 'selected configuration row stays visible after the window shrinks and labels rewrap');
  test.resize(80, 24); await flush(); await flush();
  assert.match(text(), /配置项 25 说/, 'selected configuration row stays visible after the window grows back');
  checks.push('configuration selection stays visible across window resize');
  await show({ kind: 'configuration', title: '配置', editId: 'edit', choices: [{ id: 'a', label: '第一项' }, { id: 'b', label: '第二项' }] });
  test.mockInput.pressArrow('down'); await flush();
  await show({ kind: 'configuration', title: '配置', editId: 'edit', choices: [{ id: 'a', label: '第一项' }, { id: 'b', label: '第二项' }], message: '状态更新' });
  test.mockInput.pressEnter(); await flush();
  assert.ok(actions.some(action => action.kind === 'configuration-action' && action.action === 'b'));
  // 预填字段（如改名）光标在末尾：退格直接删原值末字，不在开头插入
  await show({ kind: 'selection', title: '对话名称', requestId: 'rename-field', field: { id: 'name', label: '输入新名称', secret: false, value: '旧名称' }, choices: [{ id: 'save', label: '保存名称' }] });
  await flush();
  assert.equal(editor().cursorOffset, 6, 'prefilled field cursor starts at the end (three full-width cells each)');
  test.mockInput.pressBackspace(); await flush();
  assert.equal(editor().plainText, '旧名', 'backspace edits the prefilled value');
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
  // 选中行按迁移前的整行点阵：标签内的连续空白与行尾都铺纹理
  assert.ok(!text().includes('主场景公告')); assert.match(text(), /共享公告/); assert.match(text(), /» 普通░░行░{2,}/);
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
  root.receive({ type: 'display-page', ...baseline(), page: history }); await flush();
  const before = text(); await test.mockMouse.scroll(20, 8, 'up'); await flush();
  assert.notEqual(text(), before); assert.ok(actions.some(action => action.kind === 'display-page' && !action.follow));
  checks.push('wheel moves retained body without changing input');
  const anchorRow = text().match(/history row \d+/)?.[0]; assert.ok(anchorRow);
  root.receive({ type: 'display-page', ...baseline(), page: { ...history, follow: false } }); await flush();
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
  root.receive({ type: 'display-page', ...baseline(), page: paragraphs(30, true) }); await flush();
  await test.mockMouse.scroll(20, 8, 'up'); await flush();
  const paragraphAnchor = text().match(/paragraph \d+/)?.[0]; assert.ok(paragraphAnchor);
  root.receive({ type: 'display-page', ...baseline(), page: paragraphs(32, false) }); await flush();
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
    root.receive({ type: 'display-page', ...baseline(), page: page(40) }); await flush();
    const rows = text().split('\n').map((line, y) => ({ line, y })).filter(row => row.y >= 4 && /ROW\d+:|paragraph \d+/.test(row.line));
    assert.ok(rows.length >= 2, mode + ': selection rows');
    const x = (row: typeof rows[number]) => Math.max(row.line.indexOf('ROW'), row.line.indexOf('paragraph'));
    await test.mockMouse.drag(x(rows[0]!) + 2, rows[0]!.y, x(rows[1]!) + 18, rows[1]!.y); await flush();
    const selected = test.renderer.getSelection()?.getSelectedText(); assert.ok(selected, mode + ': initial selection');
    root.receive({ type: 'display-page', ...baseline(), page: page(42) }); await flush();
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
    root.receive({ type: 'display-page', ...baseline(), page: page(44) }); await flush();
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
  root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: false, segments: [{ blockId: 'single', contentOffset: 0, role: 'assistant', text: 'A 中 B', final: true }] } }); await flush();
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
  root.receive({ type: 'display-page', ...baseline(), page: selectionPage('alpha beta gamma delta\nsecond row unchanged') }); await flush();
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
      root.receive({ type: 'display-page', ...baseline(), page: selectionPage(initial) }); await flush();
      await test.mockMouse.doubleClick(sx(5), sy()); await flush();
      if (behavior === 'line') {
        const leaf = test.renderer.getSelection()!.selectedRenderables[0]!;
        test.renderer.startSelection(leaf, sx(5), sy(), 'line');
        test.renderer.updateSelection(leaf, sx(5), sy(), { finishDragging: true }); await flush();
      }
      assert.equal(test.renderer.getSelection()!.getSelectedText(), initial);
      root.receive({ type: 'display-page', ...baseline(), page: selectionPage(appended) }); await flush();
      assert.equal(test.renderer.getSelection()!.getSelectedText(), initial, `${behavior}: appended text is outside the frozen range`);
      test.resize(60, 24); await flush(); test.resize(100, 34); await flush();
      root.receive({ type: 'display-page', ...baseline(), page: selectionPage(appended + ' more') }); await flush();
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
          root.receive({ type: 'display-page', ...baseline(), page: selectionPage(`A ${glyph} B`) }); await flush();
          await test.mockMouse.drag(sx(reverse ? 8 : 7), sy(), sx(reverse ? 7 : 8), sy()); await flush();
          assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph);
          if (reflow) {
            for (const width of [60, 100, 60, 80]) {
              test.resize(width, 30); await flush();
              assert.equal(test.renderer.getSelection()!.getSelectedText(), glyph, `single wide ${glyph}, reverse=${reverse}, width=${width}`);
            }
            root.receive({ type: 'display-page', ...baseline(), page: selectionPage(`A ${glyph} B appended`) }); await flush();
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
        root.receive({ type: 'display-page', ...baseline(), page: selectionPage(`A ${glyph} B`) }); await flush();
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
      root.receive({ type: 'display-page', ...baseline(), page: selectionPage('alpha beta gamma') }); await flush();
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
  for (const [index, workload] of ['long-block', 'history-page'].entries()) {
    // 每个负载是一次新的打开：新的阅读代次，从最新处开始
    const reading = { conversationId: 'response', generation: 100 + index };
    test.renderer.clearSelection(); test.resize(100, 34);
    await show({ kind: 'conversation', title: '响应验收', conversationId: 'response', reading });
    editor().setText(''); await flush();
    const blockText = Array.from({ length: 350 }, (_, i) => `row ${i}: ${'abcdefgh '.repeat(9)}`).join('\n');
    const page: BodyPage = { first: 0, start: 0, last: workload === 'long-block' ? 1 : 4, follow: false,
      segments: Array.from({ length: workload === 'long-block' ? 1 : 4 }, (_, i) => ({ blockId: `response-${i}`, contentOffset: 0, role: 'assistant', text: blockText, final: true })) };
    root.receive({ type: 'display-page', ...baseline(reading), page }); await flush();
    for (let i = 0; i < 30; i++) {
      const expected = editor().plainText + 'k';
      await observe(`${workload}/input`, () => test.mockInput.pressKey('k'), () => text().includes(expected));
      const beforeScroll = text();
      // Each new conversation starts at latest; move away from that boundary
      // first so this measures real scrolling rather than a no-op at EOF.
      await observe(`${workload}/scroll`, () => test.mockMouse.scroll(20, 8, i % 2 ? 'down' : 'up'), () => text() !== beforeScroll);
      await show({ kind: 'configuration', title: '响应设置页', editId: `response-${i}`, reading });
      await observe(`${workload}/return`, () => root!.receive({ type: 'view', view: { reading, generation: ++generation, kind: 'conversation', title: '响应验收', conversationId: 'response' } }), () => text().includes(expected) && text().includes('row '));
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
  // 容量保护段是另一次打开：先声明它的阅读身份（默认测试身份），再装入大页
  await show(active);
  // Follow is now a U reading intent; installing fresh data cannot overwrite
  // the user's prior off-bottom navigation. Explicitly request latest first.
  test.mockInput.pressKey('\x1b[1;5F'); await flush();
  root.receive({ type: 'display-page', ...baseline(), page: many }); await flush();
  assert.match(text(), /viewport-399/);
  assert.ok(descendants(test.renderer.root).filter(node => node.constructor.name === 'BodyTextRenderable').length < 100);
  const scroll = descendants(test.renderer.root).find(node => node.constructor.name === 'TerminalScrollBox'); assert.ok(scroll);
  // 先经真实滚轮离开最新（阅读意图），再直接定位到顶：阅读导航行出现时正文按原意图保持位置，不被跟随拉回底部
  await test.mockMouse.scroll(20, 5, 'up'); await flush();
  scroll.scrollTo(0); await flush();
  assert.match(text(), /viewport-000/);
  assert.ok(descendants(test.renderer.root).filter(node => node.constructor.name === 'BodyTextRenderable').length < 100);
  checks.push('large semantic page keeps only viewport text leaves live and preserves first/last scroll reachability');
  const keptDraft = editor().plainText;
  await observe('paused-feedback', () => root!.receive({ type: 'view', view: { reading: TEST_READING, ...active, generation: ++generation, displayGap: true, displayPaused: true } }), () => text().includes('正文保留已暂停'));
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
      readingReply = undefined; root.receive({ type: 'display-page', ...baseline(), page: oldPage }); await flush();
      const pending = pendingRead();
      readingReply = () => pending.promise;
      const start = actions.length;
      if (route === 'keyboard') test.mockInput.pressKey('\x1b[5~');
      else if (route === 'wheel') await test.mockMouse.scroll(20, 8, 'up');
      else if (route === 'bottom') test.mockInput.pressKey('\x1b[1;5F');
      // 点阅读行右侧的“回到底部”（45 列下右侧文字占第 33–42 列）
      else { const row = text().split('\n').findIndex(line => line.includes('回到底部')); assert.ok(row >= 0); await test.mockMouse.click(40, row); }
      await flush();
      assert.ok(actions.slice(start).some(a => a.kind === 'display-page' || a.kind === 'display-earlier'));
      pending.reject(Error('synthetic read unavailable')); await flush(); await flush();
      assert.match(text(), /读取未完成/); assert.ok(editor());
      readingReply = async () => { root!.receive({ type: 'display-page', ...baseline(), page: latest }); return { accepted: true }; };
      test.mockInput.pressKey('\x1b[1;5F'); await flush();
      assert.match(text(), /LATEST BODY|latest line/); assert.doesNotMatch(text(), /读取未完成/);
    }
    for (const failed of [true, false]) {
      readingReply = undefined;
      await show({ kind: 'conversation', title: '乱序读取', conversationId: `late-read-${failed}`, connected: true });
      root.receive({ type: 'display-page', ...baseline(), page: oldPage }); await flush();
      const pending = pendingRead();
      readingReply = async action => {
        if (action.kind === 'display-page' && action.follow) { root!.receive({ type: 'display-page', ...baseline(), page: latest }); return { accepted: true }; }
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
      { get last() { return segments.length; }, work: action => action(), amend: async () => {}, seal: async () => {} });
    const artifact = { kind: 'file-diff' as const, path: 'blank.ts', operation: 'modified' as const,
      changeStats: { kind: 'exact' as const, addedLines: contents.length, removedLines: 0 },
      hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: contents.length,
        lines: contents.map((content, index) => ({ type: 'added' as const, newLineNumber: index + 1, content })) }] };
    producer.appendProcessBlock({ blockId: 'native-blank-diff', role: 'tool-diff', text: processArtifactText(artifact), lines: processArtifactLines(artifact), spans: processArtifactSpans(artifact) });
    await producer.drain(); await producer.close();
    const page = { first: 0, last: segments.length, start: 0, follow: false, segments };
    root.receive({ type: 'display-page', ...baseline(), page }); await flush();
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
      root.receive({ type: 'display-page', ...baseline(), page: JSON.parse(JSON.stringify(page)) }); await flush(); await copy('equivalent page');
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
    root.receive({ type: 'display-page', ...baseline(), page: { first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'diff-copy', contentOffset: 0,
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
  // 输入框的选区按输入框自己的文字复制，不当作正文源文：按钮出现，复制的正是输入框里选中的文字
  {
    const count = actions.filter(action => action.kind === 'clipboard-write').length;
    assert.match(text(), /复制选区/, 'editor selection is copyable');
    test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush();
    const copies = actions.filter(action => action.kind === 'clipboard-write') as Extract<TerminalAction, { kind: 'clipboard-write' }>[];
    assert.equal(copies.length, count + 1); assert.equal(copies.at(-1)!.text, 'draft only', 'editor selection copies the editor text, not body source');
  }
  editor().editorView.resetSelection();
  const bodyRows = text().split('\n'), bodyY = bodyRows.findIndex(row => row.includes('const 中文'));
  const bodyX = bodyRows[bodyY]!.indexOf('const');
  await test.mockMouse.drag(bodyX, bodyY, bodyX + 5, bodyY); await flush();
  assert.match(text(), /复制选区/);
  await show({ kind: 'conversation', title: '新对话', conversationId: 'copy-new-conversation', connected: true });
  root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: false,
    segments: [{ blockId: 'fresh-body', contentOffset: 0, role: 'assistant', text: 'New body', final: true }] } }); await flush();
  await noBodyCopy('old conversation selection cannot copy from the new page');
  await show({ kind: 'configuration', title: '字段复制边界', editId: 'copy-field', field: { id: 'copy-field', label: '字段', secret: false } });
  editor().setText('field only'); editor().selectAll(); await flush();
  // 字段的选区按字段自己的文字复制，不进正文源文映射
  {
    const count = actions.filter(action => action.kind === 'clipboard-write').length;
    assert.match(text(), /复制选区/, 'field selection is copyable');
    test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush();
    const copies = actions.filter(action => action.kind === 'clipboard-write') as Extract<TerminalAction, { kind: 'clipboard-write' }>[];
    assert.equal(copies.length, count + 1); assert.equal(copies.at(-1)!.text, 'field only', 'field selection copies the field text, not body source');
  }
  checks.push('body source copy excludes decoration-only and previous-conversation selections; draft and field selections copy their own text');
  test.renderer.clearSelection(); test.resize(80, 24);
  await show({ kind: 'conversation', title: 'Markdown 复制', conversationId: 'mapped-copy', connected: true });
  const mapped: BodyPage['segments'][number][] = [];
  for await (const part of projectBodyHistory('- **🙂甲**\t尾部\n', 'markdown', 'forward', async () => {}))
    mapped.push({ blockId: 'mapped-copy', contentOffset: part.contentOffset, role: 'assistant', text: part.text, body: part.body, final: part.body.end });
  root.receive({ type: 'display-page', ...baseline(), page: { first: 0, last: mapped.length, start: 0, follow: false, segments: mapped } }); await flush();
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
  // 8 列表：120 列时每列分到的宽度可读，走框线横排；45 列走带列名的纵排
  for (const reverse of [false, true]) for (const replacePage of [false, true]) for (const endCell of [1, 2, 7]) {
    test.renderer.clearSelection(); test.resize(120, 24);
    await show({ kind: 'conversation', title: '表格选区', conversationId: `table-selection-${reverse}-${replacePage}-${endCell}`, connected: true });
    const segments: BodyPage['segments'][number][] = [];
    const source = '| A | B | C | D | E | F | G | H |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| alpha | beta | gamma | delta | eps | zeta | eta | theta |\n';
    for await (const part of projectBodyHistory(source, 'markdown', 'forward', async () => {}))
      segments.push({ blockId: 'table-selection', contentOffset: part.contentOffset, role: 'assistant', text: part.text, body: part.body, final: part.body.end });
    const page = { first: 0, last: segments.length, start: 0, follow: false, segments };
    root.receive({ type: 'display-page', ...baseline(), page }); await flush();
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
    for (const width of [45, 120, 45, 120]) {
      test.resize(width, 24); await flush();
      if (replacePage) { root.receive({ type: 'display-page', ...baseline(), page: JSON.parse(JSON.stringify(page)) }); await flush(); }
      await checkCopy(expected);
      if (width === 120 || endCell === 1) {
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
  test.renderer.clearSelection(); editor().setText(''); await flush();
  assert.equal(usableFrames.length, 0, 'startup/connected views without real readiness must not report usable');
  await show({ kind: 'conversation', title: '可用帧', conversationId: 'usable', connected: true, readyForInput: true });
  await show({ kind: 'conversation', title: '可用帧', conversationId: 'usable', connected: true, readyForInput: true });
  assert.equal(usableFrames.length, 1, 'only one completed usable frame is reported');
  assert.ok(Number.isSafeInteger(usableFrames[0]));
  const candidateFrames: Record<string, string> = {};
  for (const height of [32, 20, 16]) {
    test.resize(100, height); editor().setText(''); await flush();
    await show({ kind: 'conversation', title: '候选稳定性', conversationId: `candidate-${height}`, connected: true,
      environment: { provider: 'example', model: 'model', workspace: 'D:/example' } });
    const items = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: `选择  ${i}`, detail: `说明 ${i}` }));
    candidateReply = async action => ({ revision: action.revision, active: true, start: 0, end: action.text.length, items });
    editor().setText('/candidate'); await flush(); await flush();
    const initialY = editor().y;
    candidateFrames[`h${height}-items`] = text();
    const pending = pendingRead(); let latest: Extract<TerminalAction, { kind: 'input-candidates' }> | undefined;
    candidateReply = action => { latest = action; return pending.promise; };
    editor().setText('/candidate-empty'); await flush();
    assert.equal(editor().y, initialY, `H${height}: loading must not move editor`);
    assert.ok(!text().includes('选择  0'), 'stale choices cannot remain selectable while loading');
    pending.resolve({ revision: latest!.revision, active: true, start: 0, end: latest!.text.length, items: [] });
    await flush(); assert.equal(editor().y, initialY, `H${height}: empty must not move editor`);
    candidateReply = async () => { throw Error('fixture unavailable'); };
    editor().setText('/candidate-error'); await flush(); await flush();
    assert.equal(editor().y, initialY, `H${height}: failure must not move editor`);
    candidateFrames[`h${height}-error`] = text();
    assert.ok(editor().y + editor().height < height - 1);
    test.mockInput.pressEscape(); await flush();
  }
  candidateReply = undefined; editor().setText(''); test.resize(100, 32); await flush();
  checks.push('usable-frame is post-render and exactly once; candidate loading/empty/error keep the same editor row at 32/20/16 physical rows');
  const spansFor = (value: string) => test.captureSpans().lines.flatMap(line => line.spans).filter(span => span.text.includes(value));
  const assertBold = (value: string, expected: boolean) => {
    const spans = spansFor(value); assert.ok(spans.length, `visible ${value}`);
    assert.ok(spans.every(span => !!(span.attributes & TextAttributes.BOLD) === expected), `${value}: bold=${expected}`);
  };
  for (const title of ['Configuration fixture', 'MCP fixture']) {
    for (const busy of [true, false, true]) {
      await show({ kind: 'configuration', title, configurationHome: true, busy,
        chromeDetails: ['workspace fixture', 'config fixture', 'secret store local'],
        ...(busy ? { message: 'Loading fixture' } : { choices: [{ id: 'one', label: 'ChoiceOne', detail: 'Ready', status: 'ready' as const }, { id: 'two', label: 'ChoiceTwo', detail: 'Pending', status: 'pending' as const }] }) });
      const rows = text().split('\n');
      assert.equal(rows[1]!.indexOf('知行'), 13, 'configuration brand retains the four-column gap');
      assert.equal(rows[2]!.indexOf(title), 13); assert.equal(rows[3]!.indexOf('配置你的知行'), 13);
      const nameSpans = test.captureSpans().lines[1]!.spans.filter(span => span.text.includes('知行'));
      assert.ok(nameSpans.length && nameSpans.every(span => span.attributes & TextAttributes.BOLD));
      assertBold(title, false);
      if (!busy) {
        assertBold('ChoiceOne', true); assertBold('ChoiceTwo', false);
        const texture = spansFor('░░'); assert.ok(texture.length);
        assert.ok(texture.every(span => (span.attributes & TextAttributes.DIM) && !(span.attributes & TextAttributes.BOLD)), 'texture is independently dim, never inherited bold');
        test.mockInput.pressArrow('down'); await flush();
        assertBold('ChoiceOne', false); assertBold('ChoiceTwo', true);
      }
    }
    await show({ kind: 'conversation', title: 'Brand fixture', conversationId: 'brand-fixture', connected: true });
    root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 0, follow: false, segments: [] } }); await flush();
    assertBold('知行', true); assertBold('当前对话 Brand fixture', false);
  }
  checks.push('configuration/MCP brand columns and native bold/dim attributes survive loading, selection and conversation transitions');
  candidateReply = async action => ({ revision: action.revision, active: true, start: 0, end: action.text.length, items: [{ id: 'clip', label: 'ClipChoice', detail: 'Detail' }] });
  test.resize(100, 16); editor().setText('/clip'); await flush(); await flush();
  assertBold('ClipChoice', true);
  const candidateShade = spansFor('░░');
  assert.ok(candidateShade.length && candidateShade.every(span => (span.attributes & TextAttributes.DIM) && !(span.attributes & TextAttributes.BOLD)));
  const clipSegments: BodyPage['segments'][number][] = [];
  // 4 列：100 列宽下走框线横排，覆盖框线跨过单行视口
  for await (const part of projectBodyHistory('| A | B | C | D |\n| --- | --- | --- | --- |\n| alpha | beta | gamma | delta |\n', 'markdown', 'forward', async () => {}))
    clipSegments.push({ blockId: 'clip-table', contentOffset: part.contentOffset, role: 'assistant', text: part.text, body: part.body, final: part.body.end });
  root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: clipSegments.length, follow: false, segments: clipSegments } }); await flush();
  const clippedBody = descendants(test.renderer.root).find(node => node.constructor.name === 'TerminalScrollBox'); assert.ok(clippedBody);
  assert.equal(clippedBody.viewport.height, 1, 'fixture exercises a one-row reading viewport');
  for (const top of [2, 3, 2]) {
    clippedBody.scrollTo(top); await flush();
    const notice = text().split('\n')[clippedBody.viewport.y + clippedBody.viewport.height]!;
    assert.match(notice.trim(), /^(↑ 更早的消息\s+)?↓ 回到底部 Ctrl\+End$/u, `table at ${top} cannot paint into the reading notice`);
  }
  candidateReply = undefined;
  checks.push('production table border crossing a one-row viewport never overwrites the adjacent reading notice');
  // 停止请求带上按键时屏上运行的身份；空闲时不带；页面上的 Ctrl+C 不算主对话双击退出的首击
  {
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const lastStop = () => actions.findLast(action => action.kind === 'interrupt' || action.kind === 'abort') as Extract<TerminalAction, { kind: 'interrupt' | 'abort' }> | undefined;
    const processView = (activity: 'running' | 'complete') => ({ revision: activity === 'running' ? 1 : 2, phase: activity === 'running' ? '正在回复' : '', activity, tools: [], children: [], usage: {} });
    await show({ kind: 'conversation', title: '知行', conversationId: 'conv-stop', connected: true, busy: true });
    root.receive({ type: 'process-status', status: { conversationId: 'conv-stop', turnId: 'turn-stop', runId: 'run-stop', view: processView('running') } }); await flush();
    await pause(800); const exitsBefore = exits;
    test.mockInput.pressKey('\x03'); await flush();
    assert.deepEqual(lastStop(), { kind: 'interrupt', stop: { conversationId: 'conv-stop', turnId: 'turn-stop', runId: 'run-stop' } });
    // 前面步骤留在输入框里的文字先被第一次 Esc 清空（既定行为），第二次才请求停止
    for (let press = 0; press < 2 && lastStop()?.kind !== 'abort'; press++) { test.mockInput.pressEscape(); await pause(25); await flush(); }
    assert.deepEqual(lastStop(), { kind: 'abort', stop: { conversationId: 'conv-stop', turnId: 'turn-stop', runId: 'run-stop' } });
    await pause(800);
    root.receive({ type: 'process-status', status: { conversationId: 'conv-stop', turnId: 'turn-stop', runId: 'run-stop', view: processView('complete') } });
    await show({ kind: 'conversation', title: '知行', conversationId: 'conv-stop', connected: true, busy: false });
    test.mockInput.pressKey('\x03'); await flush();
    assert.deepEqual(lastStop(), { kind: 'interrupt' }, 'an idle page carries no stop target');
    // 主对话刚按过一次：750 ms 内在确认页按 Ctrl+C、回到主对话再按，不得凑成双击退出
    const firstPress = performance.now();
    await show({ kind: 'confirmation', title: '确认', requestId: 'stop-confirm', choices: [{ id: 'allow', label: '允许' }] });
    test.mockInput.pressKey('\x03'); await flush();
    await show({ kind: 'conversation', title: '知行', conversationId: 'conv-stop', connected: true, busy: true });
    test.mockInput.pressKey('\x03'); await flush();
    assert.ok(performance.now() - firstPress < 750, 'the sequence stays inside the double-press window');
    assert.equal(exits, exitsBefore, 'a page Ctrl+C is not the first press of a double press');
    assert.equal(lastStop()?.kind, 'interrupt');
    checks.push('stop requests carry the shown run identity; idle carries none; a page Ctrl+C never arms the double-press exit');
  }
  // 进页保持：候选面板上按 Enter 后，来源页（面板与正文）冻结到命令结果送达再一次切换；
  // 编辑、Esc、切页让迟到的应答作废；重复 Enter 不二次提交；只补全不显示“正在打开”；无操作、失败均退出保持
  {
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    // 同一种请求可能同时挂着新旧两个（作废的进入与新的进入），按发出顺序排队、先到先答
    const waits = new Map<string, ReturnType<typeof pendingRead>[]>();
    entryReply = action => {
      if (action.kind !== 'candidate-accept' && action.kind !== 'command-route' && action.kind !== 'command') return undefined;
      const wait = pendingRead(); waits.set(action.kind, [...waits.get(action.kind) ?? [], wait]); return wait.promise;
    };
    const take = (kind: string) => { const wait = waits.get(kind)?.shift(); assert.ok(wait, `${kind} is pending`); return wait; };
    const reply = (kind: string, value: unknown) => take(kind).resolve(value);
    candidateReply = async action => action.text.startsWith('/adv') || action.text.startsWith('/res')
      ? { revision: action.revision, active: true, start: 0, end: action.text.length,
        items: [{ id: action.text.startsWith('/adv') ? 'advancement' : 'resume', label: action.text.startsWith('/adv') ? '/advancement' : '/resume', detail: '候选说明' }] }
      : { revision: action.revision, active: true, start: 0, end: action.text.length, items: [] };
    const count = (since: number, kind: TerminalAction['kind']) => actions.slice(since).filter(action => action.kind === kind).length;
    const conversation = { kind: 'conversation' as const, title: '进页保持', conversationId: 'entry-hold', connected: true };
    const open = async (draft: string) => {
      editor().setText(''); await flush(); await test.mockInput.typeText(draft); await flush(); await flush();
      assert.match(text(), /候选说明/, `${draft} opens candidates`);
    };
    // 冻结比较：除输入框文字行与信息行外逐行不变（输入框里补全成整条命令、信息行写“正在打开”属于预期变化）
    const frozen = (before: string, after: string, label: string) => {
      const info = after.split('\n').findIndex(line => line.includes('正在打开'));
      const rows = (frame: string) => frame.split('\n').map((line, index) => index === info || (index >= editor().y && index < editor().y + editor().height) ? '' : line);
      assert.deepEqual(rows(after), rows(before), label);
    };
    test.resize(100, 32); await show(conversation);

    // 主路径：四处依次延后，期间连按 Enter
    let start = actions.length;
    await open('/adv'); const before = text(), editorY = editor().y;
    test.mockInput.pressEnter(); await flush();
    assert.equal(text(), before, 'waiting for the candidate reply changes nothing on screen');
    test.mockInput.pressEnter(); await flush(); test.mockInput.pressArrow('down'); await flush();
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    assert.match(text(), /正在打开 \/advancement…/); frozen(before, text(), 'accepted: panel and body stay');
    assert.equal(editor().y, editorY);
    test.mockInput.pressEnter(); await flush();
    reply('command-route', { route: 'local' }); await flush();
    frozen(before, text(), 'routed: panel and body stay while the command runs');
    test.mockInput.pressEnter(); await flush();
    await show({ kind: 'selection', title: '任务推进', chromeDescription: '对话：示例', requestId: 'entry-advancement', choices: [{ id: 'done', label: '返回输入' }] });
    assert.match(text(), /╭─ 任务推进 ─/); assert.match(text(), /对话：示例/);
    reply('command', { accepted: true }); await flush();
    assert.deepEqual([count(start, 'candidate-accept'), count(start, 'command-route'), count(start, 'command')], [1, 1, 1], 'repeated Enter never submits twice');
    await show(conversation); await pause(25); await flush();
    assert.equal(editor().plainText, ''); assert.ok(!/候选说明|正在打开/.test(text()), 'returning shows no stale panel or opening notice');
    checks.push('candidate Enter freezes panel and body until the command result is delivered; repeated Enter submits once');

    // 等候选应答时改草稿：进入当场作废、立即解除冻结，不必等旧应答；新草稿上马上能再进入；旧应答迟到不改草稿、不执行
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); await test.mockInput.typeText('_new'); await flush(); await flush();
    assert.equal(editor().plainText, '/adv_new');
    test.mockInput.pressEnter(); await flush();
    assert.equal(count(start, 'candidate-accept'), 2, 'a new entry starts at once on the edited draft');
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.equal(editor().plainText, '/adv_new', 'the late reply of the voided entry changes nothing');
    reply('candidate-accept', { text: '/advancement', execute: false }); await flush(); await pause(25); await flush();
    editor().setText(''); await flush();
    // 光标停在中间时按 Delete：草稿变了、光标没动，同样作废这次进入，立即能再进入
    start = actions.length; await open('/advx');
    test.mockInput.pressArrow('left'); await flush(); await flush();
    assert.match(text(), /候选说明/);
    test.mockInput.pressEnter(); await flush(); test.mockInput.pressKey('\x1b[3~'); await flush(); await flush();
    assert.equal(editor().plainText, '/adv');
    test.mockInput.pressEnter(); await flush();
    assert.equal(count(start, 'candidate-accept'), 2, 'a forward delete voids the entry at once');
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.equal(editor().plainText, '/adv');
    reply('candidate-accept', { text: '/advancement', execute: false }); await flush(); await pause(25); await flush();
    editor().setText(''); await flush();
    // 等候选应答时 Esc：与平时一样收起候选、保留草稿，这次进入作废；迟到的应答不执行
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); test.mockInput.pressEscape(); await pause(25); await flush();
    assert.equal(editor().plainText, '/adv'); assert.ok(!text().includes('候选说明'), 'Esc collapses the candidates at once');
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.equal(editor().plainText, '/adv');
    editor().setText(''); await flush();
    // 路由途中编辑：进入当场作废（“正在打开”撤下），迟到的路由不发命令，草稿保留且不清空
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    await test.mockInput.typeText('y'); await flush();
    assert.ok(!text().includes('正在打开'), 'editing voids the entry before the route replies');
    reply('command-route', { route: 'local' }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command'), 0); assert.equal(editor().plainText, '/advancementy');
    editor().setText(''); await flush();
    // 路由途中 Esc（草稿未变）：进入作废，迟到的路由不发命令，草稿保留
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    test.mockInput.pressEscape(); await pause(25); await flush();
    assert.ok(!/候选说明|正在打开/.test(text()));
    reply('command-route', { route: 'local' }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command'), 0); assert.equal(editor().plainText, '/advancement');
    editor().setText(''); await flush();
    // 只补全：不显示“正在打开”、不路由
    start = actions.length; await open('/res');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/resume ', execute: false }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.equal(editor().plainText, '/resume '); assert.ok(!text().includes('正在打开'));
    editor().setText(''); await flush();
    // 路由为“作为输入发送”：不是打开页面，“正在打开”让位，不发 command
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    reply('command-route', { route: 'input' }); await flush(); await pause(25); await flush();
    assert.ok(!text().includes('正在打开')); assert.equal(count(start, 'command'), 0);
    // 走的是输入发送分支（本文件前面场景留有未完成的提交，夹具里这次发送报“仍在处理”，同样证明分支）
    assert.match(text(), /正在保存并提交输入|输入仍在处理/, 'took the send-as-input branch');
    editor().setText(''); await flush(); await show(conversation);
    checks.push('typing, Esc or editing during the hold voids the late reply and keeps the draft; completion-only shows no opening notice');

    // 被确认页抢占后再回到原会话，旧应答才返回：不路由、不改草稿、不出现“正在打开”；回来后马上能再进入
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush();
    await show({ kind: 'confirmation', title: '确认', requestId: 'entry-preempt', choices: [{ id: 'allow', label: '允许' }] });
    await show(conversation); await pause(25); await flush();
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.equal(editor().plainText, '/adv'); assert.ok(!text().includes('正在打开'));
    assert.match(text(), /候选说明/, 'candidates are live again after returning');
    test.mockInput.pressEnter(); await flush();
    assert.equal(count(start, 'candidate-accept'), 2, 'not frozen after the round trip');
    reply('candidate-accept', { text: '/advancement', execute: false }); await flush(); await pause(25); await flush();
    editor().setText(''); await flush();
    // 换会话：尚未发出的进入作废，迟到的应答不在新会话里执行
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush();
    await show({ ...conversation, conversationId: 'entry-other' });
    reply('candidate-accept', { text: '/advancement', execute: true }); await flush(); await pause(25); await flush();
    assert.equal(count(start, 'command-route'), 0); assert.ok(!text().includes('正在打开'));
    editor().setText(''); await flush(); await show(conversation);
    // 命令已发出后：打字保留在来源草稿，命令返回不清掉新草稿；Esc 只收起面板，“正在打开”留到命令返回
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    reply('command-route', { route: 'local' }); await flush();
    await test.mockInput.typeText('_after'); await flush();
    test.mockInput.pressEscape(); await pause(25); await flush();
    assert.ok(!text().includes('候选说明'), 'Esc collapses the frozen panel'); assert.match(text(), /正在打开 \/advancement…/);
    assert.equal(editor().plainText, '/advancement_after');
    reply('command', { accepted: true }); await flush(); await pause(25); await flush();
    assert.equal(editor().plainText, '/advancement_after', 'the command reply never clears a newer draft'); assert.ok(!text().includes('正在打开'));
    editor().setText(''); await flush();
    // 等待到上限：命令已受理、结果还没到。冻结解除、草稿清空，信息行按视图如实显示“正在打开”，页面迟到后回会话不再显示
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    reply('command-route', { route: 'local' }); await flush();
    await show({ ...conversation, commandPending: 'advancement' });
    reply('command', { accepted: true, pending: true }); await flush(); await pause(25); await flush();
    assert.equal(editor().plainText, ''); assert.ok(!text().includes('候选说明'));
    assert.match(text(), /正在打开 \/advancement…/, 'still opening is shown after the bounded wait');
    await show({ kind: 'selection', title: '任务推进', requestId: 'entry-late', choices: [{ id: 'done', label: '返回输入' }] });
    await show(conversation); await pause(25); await flush();
    assert.ok(!text().includes('正在打开'), 'no stale opening notice after the late page');
    // 就地结果：结果在保持中到达，命令返回后面板收起、草稿清空
    start = actions.length; await open('/adv');
    test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
    reply('command-route', { route: 'local' }); await flush();
    await show({ ...conversation, message: '当前对话没有结果待确认的运行。' });
    assert.match(text(), /候选说明/, 'the panel stays until the command returns');
    reply('command', { accepted: true }); await flush(); await pause(25); await flush();
    assert.match(text(), /当前对话没有结果待确认的运行/); assert.ok(!/候选说明|正在打开/.test(text())); assert.equal(editor().plainText, '');
    await show(conversation);
    // 就地结果收尾、正文贴底：面板收起、正文视口变高后的第一帧里，正文末行已在稳定后的位置（不先留空再贴底）
    {
      test.mockInput.pressKey('\x1b[1;5F'); await flush();
      // 多块正文（与实机一样逐块挂载）：视口一下子变高时，新露出的块不能晚一帧才就位
      let source = ''; const nodes: BodyNode[] = [];
      for (let row = 0; row < 80; row++) {
        const line = `entry-body-${String(row).padStart(2, '0')}\n`, from = source.length; source += line;
        nodes.push({ from, to: source.length, kind: 'paragraph', runs: [{ from, to: source.length, text: line, style: 0 }] });
      }
      root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'entry-body', contentOffset: 0,
        text: source, role: 'assistant', final: true, body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes } } }] } }); await flush();
      assert.match(text(), /entry-body-79/);
      start = actions.length; await open('/adv');
      test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
      reply('command-route', { route: 'local' }); await flush();
      await show({ ...conversation, message: '当前对话没有结果待确认的运行。' });
      reply('command', { accepted: true });
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
      await test.renderOnce();
      const lastRow = () => text().split('\n').findIndex(line => line.includes('entry-body-79'));
      const first = lastRow(), firstFrame = text();
      await flush(); await pause(25); await flush();
      assert.ok(!text().includes('候选说明'), 'panel collapsed');
      assert.equal(first, lastRow(), `the first frame after the panel collapses already shows the body at its settled place\n${firstFrame}`);
      // 首帧整个正文区与稳定后一致：新露出的块已在原位（不先错位一帧）
      const bodyRows = (frame: string) => frame.split('\n').slice(0, frame.split('\n').findIndex(line => line.includes('◆'))).join('\n');
      assert.equal(bodyRows(firstFrame), bodyRows(text()), 'the whole body region of the first frame equals the settled one');
      await show(conversation);
      // 向上阅读（不贴底、下方仍有足够内容）时视口同样变高：首帧起阅读位置不动，只在下方多显示内容
      const topRow = () => text().split('\n').find(line => /entry-body-\d+/u.test(line))?.trim();
      start = actions.length; await open('/adv');
      for (let wheel = 0; wheel < 16; wheel++) { await test.mockMouse.scroll(20, 3, 'up'); await flush(); }
      await pause(25); await flush();
      const reading = topRow(); assert.ok(reading && reading < 'entry-body-60', `reading well above the bottom: ${reading}`);
      test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
      reply('command-route', { route: 'local' }); await flush();
      reply('command', { accepted: true });
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
      await test.renderOnce();
      assert.equal(topRow(), reading, 'the first frame keeps the reading position');
      await flush(); await pause(25); await flush();
      assert.equal(topRow(), reading, 'the settled frame keeps the reading position');
      test.mockInput.pressKey('\x1b[1;5F'); await flush(); await show(conversation);
    }
    checks.push('in-place result: the first frame after the panel collapses keeps the followed body at its settled place');
    // 失败与不受理：退出保持，草稿保留
    for (const outcome of ['reject', 'refused'] as const) {
      start = actions.length; await open('/adv');
      test.mockInput.pressEnter(); await flush(); reply('candidate-accept', { text: '/advancement', execute: true }); await flush();
      reply('command-route', { route: 'local' }); await flush();
      const wait = take('command');
      if (outcome === 'reject') wait.reject(Error('命令暂不可用')); else wait.resolve({ accepted: false });
      await flush(); await pause(25); await flush();
      assert.ok(!text().includes('正在打开'), `${outcome}: opening notice cleared`); assert.equal(editor().plainText, '/advancement');
      if (outcome === 'reject') assert.match(text(), /命令暂不可用/);
      // 解除后 Enter 能再次发起（面板按真实状态重新出现时走候选接纳，否则直接路由）
      const attempts = () => count(start, 'candidate-accept') + count(start, 'command-route');
      const before = attempts(); test.mockInput.pressEnter(); await flush();
      assert.equal(attempts(), before + 1, `${outcome}: hold released, Enter starts again`);
      if (waits.get('candidate-accept')?.length) reply('candidate-accept', { text: '/advancement', execute: false }); else reply('command-route', undefined);
      await flush(); await pause(25); editor().setText(''); await flush(); await show(conversation);
    }
    // 无匹配项的 Enter：同样保持到命令返回，期间重复 Enter 不二次提交
    start = actions.length; editor().setText('/zzz'); await flush(); await flush();
    test.mockInput.pressEnter(); await flush(); test.mockInput.pressEnter(); await flush();
    reply('command-route', { route: 'local' }); await flush(); test.mockInput.pressEnter(); await flush();
    reply('command', { accepted: false }); await flush(); await pause(25); await flush();
    assert.deepEqual([count(start, 'command-route'), count(start, 'command')], [1, 1]);
    editor().setText(''); await flush();
    checks.push('preemption voids the late reply; in-place results, failures and refusals release the hold once the command returns');

    // 页头：有说明画框装说明，没有说明的子页用无框层级标题
    await show({ kind: 'selection', title: '命令帮助', requestId: 'entry-help', choices: [{ id: 'return', label: '返回输入' }] });
    assert.match(text(), /命令帮助 ─{8,}/); assert.ok(!text().includes('╭─ 命令帮助'), 'no empty framed header');
    // 横线补满到右侧，不靠截断收尾（截断会在横线中间放省略号）；窄窗口同样成立
    for (const width of [100, 40]) {
      test.resize(width, 32); await flush();
      const row = text().split('\n').find(line => line.includes('命令帮助'))!;
      assert.ok(!/[.…]/u.test(row), `title rule has no ellipsis at ${width}: ${row}`);
      assert.match(row.trimEnd(), /─$/u, `title rule reaches the right side at ${width}`);
    }
    test.resize(100, 32); await flush();
    await show(conversation);
    checks.push('subpage header frames only a description; a title-only page draws an unframed title rule');
    entryReply = undefined; candidateReply = undefined;
  }
  // 就地字段（改名）：底层会话的正文、欢迎区、阅读位置不动，只把输入区换成字段；Enter 以字段声明的提交动作应答，
  // 提交后锁住直到下一视图；N 带原因重开时按提交时的值继续编辑；Esc 取消；返回后主草稿原样
  {
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const conversation = { kind: 'conversation' as const, title: '就地改名', conversationId: 'inline-name', connected: true, readyForInput: true };
    const rename = (requestId: string, value: string, extra: Partial<TerminalView> = {}) => ({ kind: 'selection' as const, inline: true, title: '重命名对话',
      requestId, conversationId: 'inline-name', field: { id: 'name', label: '新名称', value, secret: false }, fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消', ...extra });
    const receiveOnly = async (view: Omit<TerminalView, 'generation'>) => {
      root!.receive({ type: 'view', view: { reading: TEST_READING, ...view, generation: ++generation } });
      for (let turn = 0; turn < 50; turn++) await Promise.resolve();
      await test.renderOnce();
    };
    // 输入框之上的全部行（正文、导航、过程区）：进入与返回时应逐行不变
    const above = (frame: string) => { const rows = frame.split('\n'); const top = rows.findLastIndex(line => line.trimStart().startsWith('╭')); return rows.slice(0, top).join('\n'); };
    const lastSelection = () => actions.findLast(action => action.kind === 'selection') as Extract<TerminalAction, { kind: 'selection' }> | undefined;
    test.resize(100, 32); await show(conversation);
    test.mockInput.pressKey('\x1b[1;5F'); await flush();
    let source = ''; const nodes: BodyNode[] = [];
    for (let row = 0; row < 80; row++) {
      const line = `inline-body-${String(row).padStart(2, '0')}\n`, from = source.length; source += line;
      nodes.push({ from, to: source.length, kind: 'paragraph', runs: [{ from, to: source.length, text: line, style: 0 }] });
    }
    root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'inline-body', contentOffset: 0,
      text: source, role: 'assistant', final: true, body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes } } }] } }); await flush();
    // 三行草稿：会话输入框占三行，就地字段沿用这个高度，正文区才不动
    editor().setText('draft-keep\nsecond line\nthird line'); await flush(); await pause(25); await flush();
    assert.match(text(), /inline-body-79/); assert.match(text(), /third line/);

    // 跟随底部时进入：首帧起输入框之上的行不变，标题在输入框边框上，没有动作列表
    const before = text();
    await receiveOnly(rename('rename-1', '旧名称'));
    assert.equal(above(text()), above(before), 'entering the inline field keeps the body, navigation and process rows on the first frame');
    await flush();
    assert.equal(above(text()), above(before), 'and on the settled frame');
    assert.match(text(), /╭─ 重命名对话 ─/); assert.equal(editor().plainText, '旧名称');
    assert.ok(!/保存名称|» 保存|› 取消/.test(text()), 'no duplicated action list'); assert.match(text(), /Enter 保存 · Esc 取消/);
    // ↑ 归输入框，不改变 Enter 的去向
    const start = actions.length;
    await test.mockInput.typeText('X'); await flush(); test.mockInput.pressArrow('up'); await flush();
    // （字段粘贴在途时 Enter 本就不提交，所以锁住之前不会有未返回的读取；锁判定仍在读取返回处兜底）
    const reads = () => actions.filter(action => action.kind === 'clipboard-read').length;
    test.mockInput.pressEnter(); await flush();
    assert.deepEqual(lastSelection(), { kind: 'selection', requestId: 'rename-1', itemId: 'save', input: '旧名称X' });
    // 提交后锁住：右键不发起剪贴板读取、不写入；打字、Enter、Esc、Ctrl+D 都不生效，不发第二次应答，不发取消
    const readsBefore = reads();
    await test.mockMouse.click(20, 30, 2); await flush(); await pause(25); await flush();
    assert.equal(reads(), readsBefore, 'no clipboard read while the field is locked'); assert.equal(editor().plainText, '旧名称X');
    const sink = externalPaste?.(); sink?.write(new TextEncoder().encode('外部粘贴')); sink?.end(); await flush(); await pause(25); await flush();
    assert.equal(editor().plainText, '旧名称X', 'an external paste never writes into the locked field');
    assert.match(text(), /正在提交…/); assert.match(text(), /Ctrl\+C 中止\/退出/); assert.ok(!/Enter 保存|Esc 取消/.test(text()), 'the hint shows only what works now');
    await test.mockInput.typeText('Y'); test.mockInput.pressEnter(); test.mockInput.pressEscape(); test.mockInput.pressKey('\x04'); await pause(25); await flush();
    assert.equal(editor().plainText, '旧名称X'); assert.equal(actions.slice(start).filter(action => action.kind === 'selection').length, 1);
    // Ctrl+C 走会话的中止/退出：交 N 一次 interrupt，不向已应答的请求发取消
    await pause(800); const exitsBefore = exits, interrupts = actions.filter(action => action.kind === 'interrupt').length;
    test.mockInput.pressKey('\x03'); await flush();
    assert.equal(actions.filter(action => action.kind === 'interrupt').length, interrupts + 1);
    assert.equal(actions.slice(start).filter(action => action.kind === 'selection').length, 1); assert.equal(exits, exitsBefore);
    await pause(800);
    // N 带原因重开：按提交时的值继续编辑，说明在信息行
    await show(rename('rename-2', '旧名称X', { field: { id: 'name', label: '新名称', value: '旧名称X', secret: false, error: '保存失败：暂不可用。可修改后再按 Enter 保存，或按 Esc 取消。' } }));
    assert.match(text(), /保存失败：暂不可用/); assert.equal(editor().plainText, '旧名称X');
    await test.mockInput.typeText('Z'); await flush(); assert.equal(editor().plainText, '旧名称XZ');
    // 字段期间正文照常阅读与追加：PgUp 上翻、Ctrl+End 回到底部、新内容跟随显示
    const followed = above(text());
    test.mockInput.pressKey('\x1b[5~'); await flush(); await pause(25); await flush();
    assert.notEqual(above(text()), followed, 'PgUp reads the conversation body while the field is open');
    test.mockInput.pressKey('\x1b[1;5F'); await flush(); await pause(25); await flush();
    const appended = source + 'inline-body-80\n';
    const appendedNodes: BodyNode[] = [...nodes, { from: source.length, to: appended.length, kind: 'paragraph', runs: [{ from: source.length, to: appended.length, text: 'inline-body-80\n', style: 0 }] }];
    root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'inline-body', contentOffset: 0,
      text: appended, role: 'assistant', final: true, body: { version: 1, revision: 1, kind: 'markdown', end: true, context: { nodes: appendedNodes } } }] } }); await flush();
    assert.match(text(), /inline-body-80/); assert.equal(editor().plainText, '旧名称XZ');
    // Esc 取消：选择取消应答
    test.mockInput.pressEscape(); await pause(25); await flush();
    assert.deepEqual(lastSelection(), { kind: 'selection', requestId: 'rename-2', cancelled: true, cancelCause: 'escape' });
    // 返回：首帧输入框之上不变，主草稿原样
    const beforeReturn = text();
    await receiveOnly(conversation);
    assert.equal(above(text()), above(beforeReturn), 'returning keeps the body on the first frame');
    await flush(); assert.equal(editor().plainText, 'draft-keep\nsecond line\nthird line');
    checks.push('inline rename keeps the conversation body, reading and process rows; one field with Enter/Esc, locked while saving, reopened with its value and reason');

    // 向上阅读时进入与返回：阅读位置不动
    for (let wheel = 0; wheel < 12; wheel++) { await test.mockMouse.scroll(20, 3, 'up'); await flush(); }
    await pause(25); await flush();
    const reading = text(); assert.ok(!reading.includes('inline-body-80'), 'reading above the bottom');
    await receiveOnly(rename('rename-3', '旧名称'));
    assert.equal(above(text()), above(reading), 'entering while reading keeps the reading position on the first frame');
    test.mockInput.pressEscape(); await pause(25); await flush();
    const readingField = text();
    await receiveOnly(conversation);
    assert.equal(above(text()), above(readingField), 'returning while reading keeps the reading position');
    test.mockInput.pressKey('\x1b[1;5F'); await flush();
    checks.push('inline field enters and returns without moving a followed or a read-up body');

    // 窄窗口与长名称：输入框服从可用高度上限，长名称在框内可编辑，信息行仍在
    for (const [width, height] of [[40, 16], [100, 32]] as const) {
      test.resize(width, height); await flush();
      await show(rename(`rename-${width}`, '很长的名称'.repeat(12)));
      assert.ok(editor().y + editor().height < height - 1, `field fits at ${width}x${height}`); assert.match(text(), /Esc 取消|Esc/);
      test.mockInput.pressEscape(); await pause(25); await flush(); await show(conversation);
    }
    // 没有同一会话可依托时按整页显示；整页单字段页同样没有动作列表，键位写各自的动词
    await show({ ...rename('rename-page', '旧名称'), conversationId: 'another' });
    assert.match(text(), /重命名对话 ─{8,}/); assert.ok(!text().includes('inline-body'), 'falls back to a page without another conversation behind it');
    test.mockInput.pressEscape(); await pause(25); await flush();
    await show({ kind: 'selection', title: '新建工作场景', requestId: 'scene-new', field: { id: 'scene', label: '描述用途和工作目录，或输入名称', value: '', secret: false },
      fieldSubmit: { id: 'save', label: '继续创建' }, cancelLabel: '取消' });
    assert.match(text(), /Enter 继续创建 · Esc 取消/); assert.ok(!text().includes('› 取消'));
    await test.mockInput.typeText('论文'); test.mockInput.pressEnter(); await flush();
    assert.deepEqual(lastSelection(), { kind: 'selection', requestId: 'scene-new', itemId: 'save', input: '论文' });
    await show(conversation); editor().setText(''); await flush();
    checks.push('inline field obeys the available height and falls back to a page; page fields show their own verbs without an action list');
  }
  // 复制意图（问题 6）：有当前选区时 Ctrl+C 只做复制——正文、输入框、字段、页面文字都一样；结果按实际写入说明，
  // 不中止、不退出、不取消，也不累计连按退出；没有选区时现有语义不变
  {
    const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    const writes = () => actions.filter(action => action.kind === 'clipboard-write') as Extract<TerminalAction, { kind: 'clipboard-write' }>[];
    const count = (kind: TerminalAction['kind']) => actions.filter(action => action.kind === kind).length;
    const rows = () => text().split('\n');
    const ctrlC = async () => { test.mockInput.pressKey('\x03'); await flush(); await pause(25); await flush(); };
    const conversation = { kind: 'conversation' as const, title: '复制', conversationId: 'copy-conv', connected: true, readyForInput: true };
    test.resize(100, 32); await show(conversation); test.mockInput.pressKey('\x1b[1;5F'); await flush();
    let source = ''; const nodes: BodyNode[] = [];
    for (let row = 0; row < 40; row++) {
      const line = `copy-body-${String(row).padStart(2, '0')}\n`, from = source.length; source += line;
      nodes.push({ from, to: source.length, kind: 'paragraph', runs: [{ from, to: source.length, text: line, style: 0 }] });
    }
    root.receive({ type: 'display-page', ...baseline(), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'copy-body', contentOffset: 0,
      text: source, role: 'assistant', final: true, body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes } } }] } }); await flush();
    editor().setText('draft-copy-test'); await flush(); await pause(25); await flush();

    // 会话输入框的鼠标选区：复制选中的那段，不发 interrupt、不退出，草稿与选区都在；提示与按钮随之出现
    const ex = editor().x, ey = editor().y;
    await test.mockMouse.drag(ex, ey, ex + 5, ey); await flush();
    const selectedDraft = editor().getSelectedText(); assert.ok(selectedDraft.length > 0 && 'draft-copy-test'.startsWith(selectedDraft), `editor selection: ${selectedDraft}`);
    assert.match(text(), /复制选区/); assert.match(text(), /Ctrl\+C 复制/);
    let before = writes().length, interrupts = count('interrupt'), exitsBefore = exits;
    await ctrlC();
    assert.equal(writes().length, before + 1); assert.equal(writes().at(-1)!.text, selectedDraft);
    assert.equal(count('interrupt'), interrupts); assert.equal(exits, exitsBefore); assert.match(text(), /已复制。/);
    assert.equal(editor().plainText, 'draft-copy-test'); assert.ok(editor().hasSelection(), 'selection kept after copying');
    // 复制后马上再按 Ctrl+C（已无选区）：不凑成连按退出，只是一次普通 Ctrl+C
    test.renderer.clearSelection(); await flush();
    await ctrlC();
    assert.equal(exits, exitsBefore); assert.equal(count('interrupt'), interrupts + 1);
    await pause(800);
    checks.push('a selection in the input copies on Ctrl+C without interrupting or exiting, keeps draft and selection, and does not arm a double-press exit');

    // 正文选区走源文映射；随后在输入框里用键盘扩选，当前选区换成输入框的
    const bodyRow = rows().findIndex(line => line.includes('copy-body-30'));
    const bodyCol = rows()[bodyRow]!.indexOf('copy-body-30');
    await test.mockMouse.drag(bodyCol, bodyRow, bodyCol + 12, bodyRow); await flush();
    before = writes().length; await ctrlC();
    assert.equal(writes().length, before + 1); assert.match(writes().at(-1)!.text, /copy-body-30/);
    test.mockInput.pressArrow('right', { shift: true }); await flush();
    const keyboardSelected = editor().getSelectedText();
    assert.ok(keyboardSelected.length > 0 && 'draft-copy-test'.includes(keyboardSelected), `keyboard selection replaced the body selection: ${keyboardSelected}`);
    before = writes().length; await ctrlC();
    assert.equal(writes().at(-1)!.text, keyboardSelected, 'the current selection is the input one, not the earlier body one');
    test.renderer.clearSelection(); await flush();
    // 同一显示行上的多个文字叶节点：按横向顺序直接拼接，不多出换行
    // 信息行：左侧状态与右侧键位是同一显示行上的两个文字叶节点（从左侧文字起点按下，内边距处不能开始选区）
    const last = rows().findIndex(line => line.includes('已复制')), lastStart = rows()[last]!.indexOf('已复制');
    await test.mockMouse.drag(lastStart, last, 99, last); await flush();
    before = writes().length; await ctrlC();
    const sameLine = writes().at(-1)!.text;
    assert.equal(writes().length, before + 1); assert.ok(!sameLine.includes('\n'), `one display line stays one line: ${JSON.stringify(sameLine)}`);
    assert.ok(/已复制/.test(sameLine) && /Enter 发送/.test(sameLine), `both leaves on the line are copied: ${JSON.stringify(sameLine)}`);
    test.renderer.clearSelection(); await flush();
    // 跨区域：正文是独立的选区容器，从正文开始的选区出不了正文；根级的选区可以从信息行连进输入框。
    // 这时输入框虽然也有选区，复制的仍是整段（输入框那部分加信息行那部分），不只复制输入框
    const infoRow = rows().findIndex(line => line.includes('已复制')), infoStart = rows()[infoRow]!.indexOf('已复制');
    await test.mockMouse.drag(infoStart + 2, infoRow, editor().x + 4, editor().y); await flush();
    assert.ok(editor().hasSelection(), 'the input takes part in the cross-region selection');
    before = writes().length; await ctrlC();
    const cross = writes().at(-1)!.text;
    assert.equal(writes().length, before + 1);
    assert.ok(cross.includes('copy-test') && cross.includes('已复'), `cross-region copy keeps both parts: ${JSON.stringify(cross)}`);
    test.renderer.clearSelection(); await flush();
    checks.push('body copies by source; keyboard selection takes over; one display line joins without newline; a cross-region selection copies all of it');

    // 拖动中：只说明，不复制、不中止
    await test.mockMouse.pressDown(bodyCol, bodyRow); await test.mockMouse.moveTo(bodyCol + 6, bodyRow); await flush();
    before = writes().length; interrupts = count('interrupt'); await ctrlC();
    assert.equal(writes().length, before); assert.equal(count('interrupt'), interrupts); assert.match(text(), /选择尚未完成/);
    await test.mockMouse.release(bodyCol + 6, bodyRow); await flush(); test.renderer.clearSelection(); await flush();
    // 写入失败与终端未确认：照实说明，仍不中止、不退出
    for (const [reply, expected] of [[async () => { throw Error('写入失败'); }, /复制请求未完成，选区已保留/], [async () => ({ state: 'other' }), /未能确认复制结果，选区已保留/]] as const) {
      clipboardWriteReply = reply;
      await test.mockMouse.drag(ex, ey, ex + 5, ey); await flush();
      interrupts = count('interrupt'); await ctrlC();
      assert.match(text(), expected); assert.equal(count('interrupt'), interrupts); assert.equal(exits, exitsBefore);
      test.renderer.clearSelection(); await flush();
    }
    clipboardWriteReply = undefined;
    // 纯空白也算可复制
    editor().setText('   tail'); await flush();
    await test.mockMouse.drag(ex, ey, ex + 2, ey); await flush();
    before = writes().length; await ctrlC();
    assert.equal(writes().at(-1)!.text, editor().getSelectedText());
    assert.ok(/^ +$/.test(writes().at(-1)!.text), `whitespace-only selection copies: ${JSON.stringify(writes().at(-1)!.text)}`);
    test.renderer.clearSelection(); editor().setText(''); await flush();
    // Ctrl+Shift+C 没有选区：只说明，不落到别的含义
    interrupts = count('interrupt'); test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush();
    assert.match(text(), /请先选择要复制的文字/); assert.equal(count('interrupt'), interrupts);
    checks.push('dragging, write failures, unconfirmed writes and empty Ctrl+Shift+C never interrupt or exit; whitespace-only selections copy');

    // 页面文字与字段：复制，不取消页面；换页后旧页面的文字不再算数
    const cancels = () => actions.filter(action => action.kind === 'selection' && (action as { cancelled?: boolean }).cancelled).length;
    await show({ kind: 'selection', title: '复制页', requestId: 'copy-page', message: 'page-copy-text', choices: [{ id: 'ok', label: '确定' }] });
    const pageRow = rows().findIndex(line => line.includes('page-copy-text')), pageCol = rows()[pageRow]!.indexOf('page-copy-text');
    await test.mockMouse.drag(pageCol, pageRow, pageCol + 14, pageRow); await flush();
    before = writes().length; let cancelled = cancels(); await ctrlC();
    assert.match(writes().at(-1)!.text, /page-copy-text/); assert.equal(cancels(), cancelled, 'copying does not cancel the page');
    await show({ kind: 'selection', title: '另一页', requestId: 'copy-page-2', choices: [{ id: 'ok', label: '确定' }] });
    before = writes().length; await ctrlC();
    assert.equal(writes().length, before, 'leaves of the previous page are not copied'); assert.equal(cancels(), cancelled + 1, 'without a selection Ctrl+C cancels the page as before');
    await show(conversation);
    await show({ kind: 'selection', inline: true, title: '重命名对话', requestId: 'copy-rename', conversationId: 'copy-conv',
      field: { id: 'name', label: '新名称', value: 'rename-copy', secret: false }, fieldSubmit: { id: 'save', label: '保存' }, cancelLabel: '取消' });
    await test.mockMouse.drag(editor().x, editor().y, editor().x + 6, editor().y); await flush();
    before = writes().length; cancelled = cancels(); await ctrlC();
    assert.equal(writes().at(-1)!.text, editor().getSelectedText()); assert.equal(cancels(), cancelled, 'copying in a field does not cancel the rename');
    test.renderer.clearSelection(); test.mockInput.pressEscape(); await pause(25); await show(conversation);
    // 保密掩码选不中：Ctrl+C 仍是取消配置编辑
    await show({ kind: 'configuration', title: '密钥', editId: 'copy-secret', field: { id: 'key', label: '密钥', secret: true } });
    await test.mockInput.typeText('s3cret'); await flush();
    const maskRow = rows().findIndex(line => line.includes('••••')), maskCol = rows()[maskRow]!.indexOf('••••');
    await test.mockMouse.drag(maskCol, maskRow, maskCol + 5, maskRow); await flush();
    before = writes().length; await ctrlC();
    assert.equal(writes().length, before, 'the secret mask is not selectable');
    assert.ok(actions.some(action => action.kind === 'configuration-action' && action.editId === 'copy-secret' && action.action === 'cancel'));
    // 恢复页：选区经它自己的终端通道复制，不经 N，也不取消
    // 快捷键与“复制选区”按钮是同一个复制入口：都只经它自己的终端通道（OSC52），不经 N，也不取消
    const terminalCopies: string[] = [], terminalCopy = test.renderer.copyToClipboardOSC52.bind(test.renderer);
    test.renderer.copyToClipboardOSC52 = (...args: Parameters<typeof terminalCopy>) => { terminalCopies.push(args[0]); return terminalCopy(...args); };
    try {
      await show({ kind: 'recovery', title: '保密显示', requestId: 'copy-recovery', recovery: { requestId: 'copy-recovery', pages: 1, input: false } });
      root.receive({ type: 'recovery-page', requestId: 'copy-recovery', page: 0, text: 'recovery-copy-text' }); await flush();
      const recoveryRow = rows().findIndex(line => line.includes('recovery-copy-text')), recoveryCol = rows()[recoveryRow]!.indexOf('recovery-copy-text');
      const selectRecovery = async () => { await test.mockMouse.drag(recoveryCol, recoveryRow, recoveryCol + 18, recoveryRow); await flush(); };
      const recoveryCancels = count('recovery-cancel');
      for (const route of ['shortcut', 'shift-shortcut', 'button'] as const) {
        await selectRecovery();
        before = writes().length; const terminalBefore = terminalCopies.length;
        if (route === 'shortcut') await ctrlC();
        else if (route === 'shift-shortcut') { test.mockInput.pressKey('c', { ctrl: true, shift: true }); await flush(); }
        else {
          // 按钮在信息行里；行内全角字符占两列，按显示宽度换算点击列
          const buttonRow = rows().findIndex(line => line.includes('复制选区')), buttonAt = rows()[buttonRow]!.indexOf('复制选区');
          assert.ok(buttonRow >= 0, 'recovery selection shows the copy button');
          const wide = rows()[buttonRow]!.slice(0, buttonAt).match(/[\p{Script=Han}　-〿＀-￯]/gu)?.length ?? 0;
          await test.mockMouse.click(buttonAt + wide + 1, buttonRow); await flush();
        }
        assert.equal(writes().length, before, `${route}: recovery content never goes through N`);
        assert.equal(terminalCopies.length, terminalBefore + 1, `${route}: recovery copies through its own terminal channel`);
        assert.match(terminalCopies.at(-1)!, /^recovery-copy/, `${route}: the selected recovery text is copied`);
        assert.equal(count('recovery-cancel'), recoveryCancels, `${route}: copying does not cancel the recovery page`);
        assert.match(text(), /已发送复制请求|当前终端无法执行复制请求/);
        test.renderer.clearSelection(); await flush();
      }
    } finally { test.renderer.copyToClipboardOSC52 = terminalCopy; }
    test.renderer.clearSelection(); await show(conversation); editor().setText(''); await flush();
    checks.push('page text and fields copy without cancelling; old page leaves expire; the secret mask is not selectable; recovery copies through its own channel from the shortcut and the button alike');

    // 新访问、进入提示仍在时第一次在正文上拖选：按下即是第一次操作，提示文字收起，但这一行留作占位直到松开，
    // 指针下的文字不移动，选中的就是按下的那段；松开后归还这一行（不留常驻空行），正文与选区随源文恢复，Ctrl+C 复制而不中止。
    // 上一次松开没有送达（如在窗口外松开）时再次按下，接续的新手势同样保留这一行
    for (const repress of [false, true]) {
      // 每次都是新的会话与阅读范围：正文从最新处开始，与真实的冷访问一致
      const firstReading = { conversationId: `copy-first-drag-${repress}`, generation: 1 };
      await show({ kind: 'conversation', title: '首次拖选', conversationId: firstReading.conversationId, reading: firstReading, connected: true, readyForInput: true });
      let firstSource = ''; const firstNodes: BodyNode[] = [];
      for (let row = 0; row < 55; row++) {
        const line = `first-body-${String(row).padStart(2, '0')} target text\n`, from = firstSource.length; firstSource += line;
        firstNodes.push({ from, to: firstSource.length, kind: 'paragraph', runs: [{ from, to: firstSource.length, text: line, style: 0 }] });
      }
      root.receive({ type: 'display-page', ...baseline(firstReading), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'first-drag', contentOffset: 0,
        text: firstSource, role: 'assistant', final: true, body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes: firstNodes } } }] } });
      await flush(); await flush();
      const rowOf = (needle: string) => rows().findIndex(line => line.includes(needle));
      assert.ok(rowOf('更早的消息') >= 0, `${repress}: a new visit shows the entry hint`);
      const y = rowOf('first-body-50'), x = rows()[y]!.indexOf('first-body-50'), lastRow = rowOf('first-body-54');
      assert.ok(y >= 0 && lastRow > y && !text().includes('回到底部'), `${repress}: the new visit starts at the latest content`);
      before = writes().length; interrupts = count('interrupt');
      await test.mockMouse.pressDown(x, y); await flush(); await flush();
      assert.ok(rowOf('更早的消息') < 0, `${repress}: the first press dismisses the hint text`);
      assert.equal(rowOf('first-body-50'), y, `${repress}: the text under the pointer stays in place while the button is held`);
      if (repress) { await test.mockMouse.pressDown(x, y); await flush(); await flush();
        assert.equal(rowOf('first-body-50'), y, 'a new press after a missed release keeps the held row'); }
      await test.mockMouse.moveTo(x + 12, y); await flush();
      assert.equal(rowOf('first-body-50'), y, `${repress}: the text stays in place throughout the drag`);
      await test.mockMouse.release(x + 12, y); await flush(); await flush(); await pause(25); await flush();
      assert.equal(rowOf('first-body-54'), lastRow + 1, `${repress}: after release the placeholder row is returned to the body`);
      const highlighted = test.renderer.getSelection()?.getSelectedText() ?? '';
      assert.ok(/^first-body-5/.test(highlighted) && 'first-body-50 target text'.startsWith(highlighted), `${repress}: the restored selection is the pressed text: ${JSON.stringify(highlighted)}`);
      await ctrlC();
      assert.equal(count('interrupt'), interrupts, `${repress}: Ctrl+C after the first drag copies instead of interrupting`);
      assert.equal(writes().length, before + 1); assert.equal(writes().at(-1)!.text, highlighted, `${repress}: the copied text is the selected text`);
      test.renderer.clearSelection(); await show(conversation); editor().setText(''); await flush();
    }
    // 在段落间的空白处单击（不产生选区）：松开即归还占位行，松开后的第一帧就不再留空行，不等别的输入或下一次刷新
    {
      const clickReading = { conversationId: 'copy-first-click', generation: 1 };
      await show({ kind: 'conversation', title: '首次单击', conversationId: clickReading.conversationId, reading: clickReading, connected: true, readyForInput: true });
      let clickSource = ''; const clickNodes: BodyNode[] = [];
      for (let row = 0; row < 55; row++) {
        const line = `click-body-${String(row).padStart(2, '0')}\n`, from = clickSource.length; clickSource += line;
        clickNodes.push({ from, to: clickSource.length, kind: 'paragraph', runs: [{ from, to: clickSource.length, text: line, style: 0 }] });
      }
      root.receive({ type: 'display-page', ...baseline(clickReading), page: { first: 0, start: 0, last: 1, follow: true, segments: [{ blockId: 'first-click', contentOffset: 0,
        text: clickSource, role: 'assistant', final: true, body: { version: 1, revision: 0, kind: 'markdown', end: true, context: { nodes: clickNodes } } }] } });
      await flush(); await flush();
      const rowOf = (needle: string) => rows().findIndex(line => line.includes(needle));
      const gap = rowOf('click-body-50') - 1, lastRow = rowOf('click-body-54');
      assert.ok(rowOf('更早的消息') >= 0 && gap > 0 && !rows()[gap]!.trim(), 'a new visit shows the hint above a blank gap row');
      await test.mockMouse.pressDown(20, gap); await flush(); await flush();
      assert.equal(rowOf('click-body-54'), lastRow, 'the row is held while the button is down');
      await test.mockMouse.release(20, gap); await test.renderOnce();
      assert.equal(rowOf('click-body-54'), lastRow + 1, 'the first frame after release no longer holds the row');
      assert.equal(test.renderer.getSelection()?.getSelectedText() ?? '', '', 'a click on a gap selects nothing');
      await show(conversation); await flush();
    }
    checks.push('first drag while the entry hint is shown keeps the text under the pointer (also after a missed release), returns the row on release and copies the pressed text; a first click returns the row in the first frame after release');

    // 信息页（/security）：N 的真实投影经结构化 summary 进页面，由 U 的公共分节组件呈现。宽屏侧注右对齐、窄屏换到标题下一行；
    // 章节标记不进复制；默认选中“返回输入”；规则说明页带每条规则的描述
    {
      const rule = (id: string, name: string, description: string, action: 'block' | 'confirm', bypassImmune: boolean, severity: 'high' | 'critical') =>
        ({ id, name, description, enabled: true, match: { type: 'command', pattern: id }, action, bypassImmune, severity, category: 'destructive_operation' });
      const snapshot = { contextId: { kind: 'main' }, workspacePath: null, permissionRules: [],
        builtinRules: [rule('bi-git', 'Git 内部文件写保护', '防止直接修改 .git/ 目录内部文件', 'block', true, 'critical'),
          rule('cf-rm', '破坏性命令', '检测可能导致不可逆数据删除的命令', 'confirm', false, 'high')],
        rateLimits: [{ key: 'bash', used: 86, limit: 100 }], confirmations: [{ key: 'bash::npm test *', count: 2, highestRisk: 'medium' }] } as never;
      const page = { kind: 'selection' as const, title: '安全状态', requestId: 'security-page', summary: securityOverview(snapshot), initialItemId: 'option:done',
        choices: [{ id: 'option:done', label: '返回输入' }, { id: 'option:rules', label: '查看规则说明' }] };
      test.resize(100, 40); await show(page); await flush();
      const header = rows().find(line => line.includes('直接拦截 · 1 项'))!;
      assert.ok(header?.includes('▎ 直接拦截 · 1 项') && header.trimEnd().endsWith('信任规则不能放行'), `wide aside aligned right: ${header}`);
      for (const expected of ['主模式 · 本对话的默认范围', '内置规则 2 条：直接拦截 1 · 需要确认 1', '86 / 100 · 接近上限', '浏览与撤销：在输入框输入 /trust 后加空格', '已允许 2 次 · 最高风险 中'])
        assert.ok(rows().some(line => line.includes(expected)), `security page shows: ${expected}`);
      // 从页首陈述开始拖，跨过整条标题行（含行首的章节标记）到下一行：标记不可选，复制结果里没有它
      const headerRow = rows().indexOf(header), titleColumn = header.indexOf('直接拦截');
      const leadRow = rows().findIndex(line => line.includes('内置规则 2 条')), leadColumn = rows()[leadRow]!.indexOf('内置规则');
      assert.ok(leadRow >= 0 && leadRow < headerRow, 'the lead sits above the first section');
      await test.mockMouse.drag(leadColumn, leadRow, titleColumn + 30, headerRow + 1); await flush();
      before = writes().length; await ctrlC();
      const copied = writes().at(-1)!.text;
      assert.equal(writes().length, before + 1);
      assert.ok(copied.includes('内置规则') && copied.includes('直接拦截') && copied.includes('\n') && !copied.includes('▎'),
        `copy keeps lines and excludes the section marker: ${JSON.stringify(copied)}`);
      test.renderer.clearSelection(); await flush();
      test.mockInput.pressEnter(); await flush();
      assert.equal((actions.findLast(action => action.kind === 'selection') as { itemId?: string } | undefined)?.itemId, 'option:done', 'Enter takes the default return action');
      // 45 列时内容宽 40 列，标题加侧注 35 列仍在同一行；36 列（内容宽 31 列）放不下，侧注换到标题下一行
      await show({ ...page, requestId: 'security-page-2' }); test.resize(45, 40); await flush();
      assert.ok(rows().find(line => line.includes('直接拦截 · 1 项'))?.trimEnd().endsWith('信任规则不能放行'), 'aside still fits at 45 columns');
      test.resize(36, 40); await flush();
      const narrow = rows(), at = narrow.findIndex(line => line.includes('直接拦截 · 1 项'));
      assert.ok(at >= 0 && !narrow[at]!.includes('信任规则不能放行') && narrow[at + 1]!.includes('信任规则不能放行'), 'narrow aside moves below the title');
      test.resize(100, 32);
      await show({ kind: 'selection', title: '规则说明', requestId: 'security-rules', summary: securityRulesDetail(snapshot)[0]!, initialItemId: 'option:back',
        choices: [{ id: 'option:back', label: '返回安全状态' }] }); await flush();
      assert.ok(rows().some(line => line.includes('检测可能导致不可逆数据删除的命令')), 'the explanation page shows rule descriptions');
      assert.ok(rows().some(line => line.includes('风险 极高 · bi-git · 不可覆盖')), 'the explanation page keeps severity, id and the override mark');
      // 复制只取源文：同一段含中文、英文单词、双空格、长路径的文字，在不同宽度下拖选整段后复制，与源文逐字一致（软折行与缩进不进复制、空格不丢）；
      // 标签与值之间是制表符
      const source = '开头 START alpha  beta gamma delta epsilon zeta eta theta iota kappa lambda mu 中文句子，标点。D:\\very\\long\\path\\segment\\to\\file.txt END';
      const names = ['Git 内部文件写保护', 'SSH 密钥保护', '环境变量注入防护', '知行秘密存储隔离', '系统凭据库隔离', '宿主秘密路径隔离'];
      const copyPage = { kind: 'selection' as const, title: '复制', initialItemId: 'option:done', choices: [{ id: 'option:done', label: '返回输入' }],
        summary: { lead: [[{ text: source }]], sections: [{ title: '允许累计', rows: [{ label: 'bash · npm test *', value: '已允许 2 次 · 最高风险 中' }] },
          { title: '直接拦截 · 6 项', items: names }] } };
      for (const columns of [45, 60, 100]) {
        test.resize(columns, 32); await show({ ...copyPage, requestId: `copy-summary-${columns}` }); await flush();
        const lines = rows(), first = lines.findIndex(line => line.includes('开头')), last = lines.findIndex(line => line.includes('END'));
        assert.ok(columns === 100 || last > first, `${columns}: the paragraph wraps on screen`);
        await test.mockMouse.drag(lines[first]!.indexOf('开头'), first, lines[last]!.indexOf('END') + 2, last); await flush();
        before = writes().length; await ctrlC();
        assert.equal(writes().length, before + 1); assert.equal(writes().at(-1)!.text, source, `${columns}: copy equals the source text exactly`);
        test.renderer.clearSelection(); await flush();
        const labelRow = rows().findIndex(line => line.includes('bash · npm test')), valueRow = rows().findIndex(line => line.includes('已允许 2 次'));
        await test.mockMouse.drag(rows()[labelRow]!.indexOf('bash'), labelRow, columns - 3, valueRow); await flush();
        before = writes().length; await ctrlC();
        assert.equal(writes().at(-1)!.text, 'bash · npm test *\t已允许 2 次 · 最高风险 中', `${columns}: label and value copy with a tab, no padding`);
        test.renderer.clearSelection(); await flush();
        // 并列条目按项换行：每个名称完整出现在某一行里；整串复制得到“甲 · 乙 · …”，不含换行
        for (const name of names) assert.ok(rows().some(line => line.includes(name)), `${columns}: ${name} is never split across lines`);
        const itemsFirst = rows().findIndex(line => line.includes(names[0]!)), itemsLast = rows().findIndex(line => line.includes(names.at(-1)!));
        await test.mockMouse.drag(rows()[itemsFirst]!.indexOf('Git'), itemsFirst, columns - 3, itemsLast); await flush();
        before = writes().length; await ctrlC();
        assert.equal(writes().at(-1)!.text, names.join(' · '), `${columns}: items copy as one list`);
        test.renderer.clearSelection(); await flush();
      }
      test.resize(100, 32); await show(conversation); await flush();
      checks.push('information page: real security projection, right-aligned asides wide, wrapped asides narrow, copy without the section marker, default return action, rule explanations, source-exact copy at 45/60/100 columns');
    }

    // 45 列信息行：有选区时键位改用短版、复制按钮仍在；复制成功与失败的说明都完整可读；没有选区时导航键位照常
    {
      const narrowPage = { kind: 'selection' as const, title: '窄屏反馈', requestId: 'narrow-feedback', message: 'narrow-copy-text 用于窄屏复制反馈', choices: [{ id: 'ok', label: '确定' }] };
      test.resize(45, 24); await show(narrowPage); await flush();
      const bottom = () => rows().filter(line => line.trim()).at(-1)!;
      assert.ok(bottom().includes('Esc 返回') && !bottom().includes('复制选区'), `navigation keys without a selection: ${bottom()}`);
      const textRow = rows().findIndex(line => line.includes('narrow-copy-text')), textColumn = rows()[textRow]!.indexOf('narrow-copy-text');
      await test.mockMouse.drag(textColumn, textRow, textColumn + 15, textRow); await flush();
      // 键位按扣掉按钮后的实际宽度选短版，不出现被截断的“PgUp/P…”
      assert.ok(bottom().includes('复制选区') && bottom().includes('Enter 确认') && !bottom().includes('…'), `a selection shows the short keys and the copy button: ${bottom()}`);
      await ctrlC();
      assert.ok(bottom().includes('已复制。'), `success is readable at 45 columns: ${bottom()}`);
      clipboardWriteReply = async () => { throw Error('写入失败'); };
      await ctrlC();
      assert.ok(bottom().includes('复制请求未完成，选区已保留。'), `failure is fully readable at 45 columns: ${bottom()}`);
      // 更长的说明（38 列）：键位用短版仍放不下，让出“复制选区”按钮（Ctrl+C 照样复制），说明完整可读
      const terminalCopy = test.renderer.copyToClipboardOSC52.bind(test.renderer);
      test.renderer.copyToClipboardOSC52 = () => false;
      clipboardWriteReply = async () => ({ state: 'unavailable' });
      try {
        await ctrlC();
        assert.ok(bottom().includes('当前终端无法执行复制请求，选区已保留。') && !bottom().includes('复制选区'), `a long failure takes the copy button's room: ${bottom()}`);
      } finally { test.renderer.copyToClipboardOSC52 = terminalCopy; }
      clipboardWriteReply = undefined;
      test.renderer.clearSelection(); await flush();
      test.resize(100, 32); await show(conversation); await flush();
      checks.push('45-column information row keeps copy success and failure readable, short keys with a selection, navigation keys without');
    }

  }
  console.log(JSON.stringify({ checks, responseMs, renderMs: { max: Math.max(...frameTimes), samples: frameTimes.length }, candidateFrames, frame: text() }, null, 2));
} finally { clearInterval(tick); if (root) await root.dispose(); else test.renderer.destroy(); }
