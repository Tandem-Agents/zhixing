import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as model from '../body-model.js';
import * as layout from './layout.js';
import * as processModel from '../process-model.js';
import type { BodyViewHandle, BodyViewProps } from '../body-view.js';

// Execute the production component's lifecycle with deterministic native
// coordinates. JSX compilation stays in memory; this is not an OS/TTY test.
const emitted = ts.transpileModule(readFileSync(new URL('../body-view.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
}).outputText;
function mount(anchor?: model.BodyAnchor, follow = false) {
  const effects: (() => void)[] = [], cleanups: (() => void)[] = [], frames = new Set<() => void>();
  const textViews: { content: string | { chunks: { text: string }[] } }[] = [];
  let handle: BodyViewHandle | undefined, reported = anchor, measurement = '';
  const scroll = { scrollTop: 0, scrollHeight: 3, viewport: { y: 0, height: 1 },
    scrollTo(value: number) { this.scrollTop = Math.max(0, Math.min(2, value)); }, scrollBy(value: number) { this.scrollTo(this.scrollTop + value); } };
  const For = (props: { each: unknown[]; children: (value: unknown) => unknown }) => props.each.map(props.children);
  const Show = (props: { when: unknown; children: unknown; fallback: unknown }) => props.when ? props.children : props.fallback;
  const core = {
    TextRenderable: class {},
    ScrollBoxRenderable: class { protected onMouseEvent() {} },
    StyledText: class { constructor(readonly chunks: unknown[]) {} },
    createTextAttributes: () => 0, RGBA: { fromHex: (value: string) => value },
    TextBuffer: { create: () => ({ ptr: 1, setText: (text: string) => { measurement = text; }, destroy: vi.fn() }) },
    TextBufferView: { create: () => ({ setWrapMode: vi.fn(), setWrapWidth: vi.fn(), getVirtualLineCount: () => measurement.split('\n').length, destroy: vi.fn(),
      get logicalLineInfo() { return { lineWidthCols: [measurement.length] }; } }) },
    resolveRenderLib: () => ({ decoder: new TextDecoder(),
      textBufferGetTextRangeByCoords: (_ptr: number, _row: number, _from: number, _endRow: number, column: number) =>
        new TextEncoder().encode(measurement.slice(0, column)) }),
  };
  const solid = {
    untrack: (read: () => unknown) => read(),
    createMemo: (read: () => unknown) => read,
    createSignal: (initial: unknown) => { let value = initial; return [() => value, (update: unknown) => { value = typeof update === 'function' ? update(value) : update; }]; },
    createEffect: (effect: () => void) => { effects.push(effect); }, onCleanup: (cleanup: () => void) => { cleanups.push(cleanup); }, For, Show,
  };
  const dependencies: Record<string, unknown> = { 'solid-js': solid, '@opentui/core': core, '@opentui/solid': { extend() {} },
    './theme.js': { tone: { brand: 'cyan', dim: 'gray', history: 'gray', text: 'white' }, spacing: { marker: 4, nested: 2 } },
    './body-model.js': model, './body/layout.js': layout, './process-model.js': processModel,
    './body/highlighting.js': { BodyHighlighter: class { setPage() {} get() {} async close() {} } } };
  const jsx = (type: string | ((props: Record<string, unknown>) => unknown), props: Record<string, unknown> | null, ...children: unknown[]) => {
    const values = { ...props, children: children.length === 1 ? children[0] : children };
    if (typeof type === 'function') return type(values);
    const ref = props?.ref as ((value: unknown) => void) | undefined;
    if (type === 'scrollbox') ref?.(scroll);
    else if (type === 'text' || type === 'body_text') {
      // Match the pinned Solid adapter's text/content prop coercion. The
      // native TextRenderable setter itself accepts StyledText without it.
      const view = { content: props?.content === undefined ? '' : String(props.content),
        isDestroyed: false, x: 0, get y() { return -scroll.scrollTop; }, width: 20, height: 3,
        lineInfo: { lineSources: [0, 1, 2], lineStartCols: [0, 5, 11] } };
      textViews.push(view); ref?.(view);
    }
    return undefined;
  };
  const exports: { BodyView?: (props: BodyViewProps) => unknown } = {};
  new Function('require', 'exports', 'jsx', emitted)((name: string) => {
    if (!(name in dependencies)) throw Error(`Unexpected component dependency: ${name}`);
    return dependencies[name];
  }, exports, jsx);
  const renderer = { widthMethod: 'wcwidth', getSelection: () => undefined, requestRender: vi.fn(),
    addPostProcessFn: (frame: () => void) => frames.add(frame), removePostProcessFn: (frame: () => void) => frames.delete(frame) };
  exports.BodyView!({ page: { first: 0, last: 1, start: 0, follow, segments: [
    { blockId: 'body', contentOffset: 0, role: 'assistant', text: 'first\nsecond\nthird', final: true },
  ] }, width: 20, height: 1, renderer: renderer as unknown as BodyViewProps['renderer'], anchor,
    requestPage: async () => {}, requestPrevious: async () => {}, onAnchor: value => { reported = value; },
    onError: error => { throw error; }, onReady: value => { handle = value; } });
  for (const effect of effects) effect();
  return { handle: handle!, scroll, get reported() { return reported; },
    text: () => textViews.map(view => typeof view.content === 'string' ? view.content : view.content.chunks.map(chunk => chunk.text).join('')).join(''),
    frame: () => { for (const frame of frames) frame(); },
    async close() { await handle?.close(); for (const cleanup of cleanups) cleanup(); expect(frames.size).toBe(0); } };
}

describe('body component initial reading position', () => {
  it('renders styled source text through the native port instead of Solid object coercion', async () => {
    const view = mount();
    expect(view.text()).toContain('first\nsecond\nthird');
    expect(view.text()).not.toContain('[object Object]');
    await view.close();
  });
  it('restores the supplied source anchor on first layout and after an owner-controlled remount', async () => {
    const anchor = { blockId: 'body', contentOffset: 6 };
    const first = mount(anchor);
    // The root may capture while a new layout is still pending.
    first.handle.beforeUpdate();
    expect(first.reported).toEqual(anchor);
    first.frame();
    expect(first.scroll.scrollTop).toBe(1);
    first.handle.beforeUpdate();
    expect(first.reported).toEqual(anchor);
    await first.close();
    const second = mount(first.reported);
    second.frame();
    expect(second.scroll.scrollTop).toBe(1);
    expect(second.handle.anchor()).toEqual(anchor);
    await second.close();
  });
  it('starts a following page at the bottom instead of reviving a stale reading anchor', async () => {
    const view = mount({ blockId: 'body', contentOffset: 6 }, true);
    view.frame();
    expect(view.scroll.scrollTop).toBe(2);
    await view.close();
  });
});
