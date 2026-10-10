import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setRenderLibPath, OptimizedBuffer, RGBA, TextAttributes, TextBuffer, TextBufferView } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
import { scrollGeometry } from '../scroll-box.js';
import type { BodyPage } from '../body-model.js';
import type { TerminalView } from '../protocol.js';
setRenderLibPath(process.env.ZHIXING_TERMINAL_RENDER_LIB!);
const test = await createTestRenderer({ width: 120, height: 40, useThread: false, consoleMode: 'disabled', exitOnCtrlC: false, otherModifiersMode: true });
const frames: Record<string, unknown> = {}, checks: string[] = [];
const copies: string[] = [];
let root: Awaited<ReturnType<typeof createTerminalRoot>> | undefined, generation = 0;
let page: BodyPage = { first: 0, last: 1, start: 0, follow: true, segments: [{ blockId: 'body', role: 'assistant', contentOffset: 0, final: true,
  text: Array.from({ length: 80 }, (_, i) => `第 ${i} 行 · retained text ${i}`).join('\n') }] };
const view = { kind: 'conversation', title: '知行', conversationId: 'reading-contract', connected: true, message: '已恢复最近对话。', environment: { workspace: 'D:/example', provider: 'local', model: 'synthetic' } } as const;
const walk = (node: any): any[] => [node, ...(node.getChildren?.() ?? []).flatMap(walk)];
const find = (name: string) => walk(test.renderer.root).find(node => node.constructor.name === name)!;
const box = () => find('TerminalScrollBox'), editor = () => find('TerminalTextarea');
const flush = async () => { for (let i = 0; i < 8; i++) await test.renderOnce(); await new Promise<void>(resolve => queueMicrotask(resolve)); };
const show = async (value: Omit<TerminalView, 'generation'>) => { root!.receive({ type: 'view', view: { ...value, generation: ++generation } }); await flush(); };
const publish = async (value = page) => { page = value; root!.receive({ type: 'display-page', page }); await flush(); };
const latest = async () => { test.mockInput.pressKey('\x1b[1;5F'); await flush(); };
const capture = (name: string) => { frames[name] = test.captureSpans(); };
const tick = setInterval(() => void test.renderOnce(), 15);
try {
  root = await createTerminalRoot({ signal: new AbortController().signal, inputReady() {}, exit: async () => {}, request: async action => {
    if (action.kind === 'display-page') { page = { ...page, follow: !!action.follow }; root!.receive({ type: 'display-page', page }); }
    if (action.kind === 'input-candidates') return { revision: action.revision, start: 0, end: action.text.length, active: action.text.startsWith('/'), items: action.text.startsWith('/') ? [{ id: 'config', label: '/config' }] : [] };
    if (action.kind === 'clipboard-write') { copies.push(action.text); return { state: 'copied' }; }
    return { accepted: true };
  } }, async () => test.renderer);
  clearInterval(tick);
  await show(view); await publish();
  const geometry = () => { const s = box(); return { content: s.scrollHeight, viewport: s.viewport.height, scrollTop: s.scrollTop, ...scrollGeometry(s.scrollHeight, s.viewport.height, s.verticalScrollBar.slider.height, s.scrollTop) }; };
  const initial = geometry();
  assert.equal(box().verticalScrollBar.x, 119);
  assert.equal(box().verticalScrollBar.slider.getThumbRect().height, initial.height);
  capture('main');
  // Shared geometry covers tiny overflow, no overflow and a one-cell track.
  for (const [content, viewport, track] of [[34, 34, 34], [35, 34, 34], [90, 34, 34], [20, 1, 1]]) {
    const g = scrollGeometry(content!, viewport!, track!, content! - viewport!);
    if (content! <= viewport!) assert.equal(g.height, 0);
    else { assert.equal(g.top + g.height, track); if (track! > 1) assert.ok(g.height < track!); }
  }
  await test.mockInput.typeText('/config'); await flush(); editor().setText(''); await flush();
  await show({ kind: 'configuration', title: '配置', configurationHome: true, editId: 'cfg', chromeDetails: ['工作目录    D:/example'], choices: [
    { id: 'save', label: '完成', detail: '保存并启动', shortcut: 'Ctrl+S', primary: true, presentation: 'button', section: '操作' },
    { id: 'cancel', label: '取消', detail: '返回', shortcut: 'Esc', presentation: 'button' },
  ] });
  capture('configuration'); assert.equal(box().verticalScrollBar.x, 119);
  const configLines = test.captureCharFrame().split('\n');
  assert.equal(configLines.findIndex(row => row.includes('取消')), configLines.findIndex(row => row.includes('完成')) + 1);
  await show({ ...view, message: '已取消本次配置编辑。' });
  assert.deepEqual(geometry(), initial, 'same content and viewport after configuration');
  assert.equal(test.captureCharFrame().split('\n').findIndex(row => row.includes('已取消本次配置')), editor().parent.y - 1);
  capture('configuration-return'); checks.push('fixed candidate budget releases to auto; configuration round trip preserves all geometry and adjacent status');

  // A native wheel step is three rows and does not lose its first event.
  const beforeWheel = box().scrollTop;
  await test.mockMouse.scroll(20, 8, 'up'); await flush(); assert.equal(box().scrollTop, beforeWheel - 3);
  const afterWheel = box().scrollTop;
  await test.mockMouse.click(20, 8); await flush(); assert.equal(box().scrollTop, afterWheel);
  // Capture partly visible chrome through the same real navigation path.
  box().scrollTo(3); await flush(); await test.mockMouse.click(18, 8); await flush(); assert.equal(box().scrollTop, 3);
  checks.push('wheel consumes exactly once; ordinary body and partly visible header clicks do not move content');

  await latest();
  const slider = box().verticalScrollBar.slider, thumb = slider.getThumbRect();
  let pointer = thumb.y + Math.min(2, thumb.height - 1);
  await test.mockMouse.pressDown(slider.x, pointer); await flush();
  const positions: number[] = [box().scrollTop];
  for (let i = 0; i < 7; i++) {
    pointer--; await test.mockMouse.emitMouseEvent('drag', slider.x, pointer); await flush(); positions.push(box().scrollTop);
    await show({ ...view, message: '相同内容刷新' }); assert.equal(box().scrollTop, positions.at(-1));
  }
  assert.ok(positions.every((value, i) => !i || value <= positions[i - 1]!));
  assert.ok(new Set(positions).size >= 5, 'continuous drag has intermediate positions');
  capture('drag');
  test.resize(100, 36); await flush(); const resized = box().scrollTop;
  await test.mockMouse.emitMouseEvent('drag', box().verticalScrollBar.x, pointer); await flush(); assert.equal(box().scrollTop, resized, 'resize rebase without pointer movement');
  await test.mockMouse.release(box().verticalScrollBar.x, pointer); await flush();
  // Lose mouse-up while the native renderer holds the slider; a new press
  // must reach the editor rather than the stale capture target.
  const nextThumb = box().verticalScrollBar.slider.getThumbRect();
  await test.mockMouse.pressDown(box().verticalScrollBar.x, nextThumb.y + 1);
  await test.mockMouse.emitMouseEvent('drag', box().verticalScrollBar.x, nextThumb.y); await flush();
  await test.mockMouse.pressDown(editor().x, editor().y); await test.mockMouse.release(editor().x, editor().y); await flush();
  assert.ok(!test.renderer.getSelection()?.isDragging);
  assert.equal((test.renderer as any).capturedRenderable, undefined);
  checks.push('thumb drag is monotone across intermediate positions, same-content refresh and resize rebasing');

  await latest();
  const currentTop = box().scrollTop;
  await test.mockMouse.pressDown(8, 4); await flush();
  await publish({ ...page, segments: [{ ...page.segments[0]!, text: page.segments[0]!.text + '\nNEW ROW ONE' }] });
  assert.equal(box().scrollTop, currentTop, 'pointer hold protects current content');
  // Missing mouse-up must not leave follow locked after a real key takes over.
  test.mockInput.pressKey('x'); await flush();
  assert.equal(editor().plainText, 'x'); assert.equal(box().scrollTop + box().viewport.height, box().scrollHeight);
  editor().setText(''); test.renderer.clearSelection(); await flush();
  await test.mockMouse.drag(6, 4, 18, 5); await flush();
  const selected = test.renderer.getSelection()?.getSelectedText(); assert.ok(selected);
  const selectedTop = box().scrollTop; capture('selection');
  const styled = test.captureSpans().lines.flatMap(line => line.spans).filter(span => span.bg.buffer[0] === 185 && span.bg.buffer[1] === 217);
  assert.ok(styled.length > 0); assert.ok(styled.every(span => span.fg.buffer[0] === 17 && !(span.attributes & (2 | 32))));
  await publish({ ...page, segments: [{ ...page.segments[0]!, text: page.segments[0]!.text + '\nNEW ROW TWO' }] });
  assert.equal(box().scrollTop, selectedTop); assert.equal(test.renderer.getSelection()?.getSelectedText(), selected);
  checks.push('missing mouse-up is finished by real input; confirmed selection stays readable and stable through output');

  await latest();
  await test.mockMouse.drag(6, 4, 18, 5); await flush();
  await test.mockMouse.click(editor().x, editor().y); await flush();
  await publish({ ...page, segments: [{ ...page.segments[0]!, text: page.segments[0]!.text + '\nAFTER CLEAR' }] });
  assert.equal(box().scrollTop + box().viewport.height, box().scrollHeight, 'clearing a body selection at EOF restores follow');

  test.renderer.clearSelection(); await latest();
  const user = { blockId: 'user', role: 'user', contentOffset: 0, final: true, text: '你好' };
  const thinking = { blockId: 'thinking', role: 'thinking', contentOffset: 0, final: false, text: '\n\n正在核对事实\n\n' };
  await publish({ first: 0, start: 0, last: 1, follow: true, segments: [user], transient: thinking });
  const before = test.captureCharFrame(); capture('thinking-live');
  await publish({ first: 0, start: 0, last: 2, follow: true, segments: [user, { ...thinking, final: true }] });
  assert.equal(test.captureCharFrame(), before, 'final thinking replaces transient in place');
  const lines = before.split('\n'); assert.equal(lines.findIndex(row => row.includes('正在核对事实')) - lines.findIndex(row => row.includes('你好')), 2);
  root.receive({ type: 'process-status', status: { conversationId: view.conversationId, view: { revision: 1, activity: 'running', phase: '正在回复', thinking: { active: true, text: '不应出现在底部' }, tools: ['读取完成'], children: [], usage: { inputTokens: 8 } } } });
  await flush(); capture('process');
  const statusLines = test.captureCharFrame().split('\n'); assert.equal(statusLines.findIndex(row => row.includes('正在回复')), editor().parent.y - 1); assert.ok(!statusLines.join('\n').includes('不应出现在底部'));
  checks.push('live/final thinking has one source identity and position; boundary blanks collapse; footer status remains adjacent');
  // Copy omits the artificial overflow glyph and uses retained source text.
  await publish({ first: 0, start: 0, last: 2, follow: true, segments: [user, { ...thinking, text: '0123456789'.repeat(80), final: true }] });
  const thinkingLeaf = walk(test.renderer.root).find(node => node.constructor.name === 'BodyTextRenderable' && node.plainText?.startsWith('…'));
  assert.ok(thinkingLeaf, 'clipped thinking is visible');
  await test.mockMouse.drag(thinkingLeaf.x, thinkingLeaf.y, thinkingLeaf.x + 8, thinkingLeaf.y); await flush();
  test.mockInput.pressKey('\x03'); await flush();
  assert.ok(copies.at(-1)?.length); assert.ok(!copies.at(-1)!.includes('…'));
  checks.push('thinking overflow decoration is visible but never enters copied source');
  const fallback = OptimizedBuffer.create(6, 1, test.renderer.widthMethod);
  const nativeText = TextBuffer.create(test.renderer.widthMethod), nativeView = TextBufferView.create(nativeText);
  try {
    nativeText.setDefaultFg(RGBA.defaultForeground()); nativeText.setDefaultBg(RGBA.defaultBackground());
    nativeText.setDefaultAttributes(TextAttributes.DIM | TextAttributes.INVERSE); nativeText.setText('abcdef');
    nativeView.setViewport(0, 0, 6, 1); nativeView.setSelection(0, 6);
    fallback.drawTextBuffer(nativeView, 0, 0);
    // Read the actual native cell, including packed intent metadata.
    const fg = fallback.buffers.fg, bg = fallback.buffers.bg;
    assert.equal(fg[0]! & 255, 17); assert.equal(bg[0]! & 255, 185); assert.equal(bg[1]! & 255, 217);
    assert.ok(!(fallback.buffers.attributes[0]! & (TextAttributes.DIM | TextAttributes.INVERSE)));
  } finally { nativeView.destroy(); nativeText.destroy(); fallback.destroy(); }
  checks.push('default-color native selection fallback uses explicit contrasting RGB and clears dim/inverse');
  console.log(JSON.stringify({ checks, dragPositions: positions, initialGeometry: initial }));
} finally {
  clearInterval(tick);
  if (process.env.ZHIXING_READING_CAPTURE) { fs.mkdirSync(process.env.ZHIXING_READING_CAPTURE, { recursive: true }); fs.writeFileSync(path.join(process.env.ZHIXING_READING_CAPTURE, 'frames.json'), JSON.stringify(frames)); }
  await root?.dispose(); test.renderer.destroy();
}
