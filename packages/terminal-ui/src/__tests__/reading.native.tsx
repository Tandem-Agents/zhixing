import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setRenderLibPath, OptimizedBuffer, RGBA, TextAttributes, TextBuffer, TextBufferView } from '@opentui/core';
import { createTestRenderer } from '@opentui/core/testing';
import { createTerminalRoot } from '../root.js';
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
const flush = async () => { for (let i = 0; i < 8; i++) await test.renderOnce(); await new Promise<void>(resolve => queueMicrotask(resolve)); };
const show = async (value: Omit<TerminalView, 'generation'>) => { root!.receive({ type: 'view', view: { ...value, generation: ++generation } }); await flush(); };
const publish = async (value = page) => { page = value; root!.receive({ type: 'display-page', page }); await flush(); };
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
  console.log(JSON.stringify({ checks }));
} finally {
  clearInterval(tick);
  if (process.env.ZHIXING_READING_CAPTURE) { fs.mkdirSync(process.env.ZHIXING_READING_CAPTURE, { recursive: true }); fs.writeFileSync(path.join(process.env.ZHIXING_READING_CAPTURE, 'frames.json'), JSON.stringify(frames)); }
  await root?.dispose(); test.renderer.destroy();
}
