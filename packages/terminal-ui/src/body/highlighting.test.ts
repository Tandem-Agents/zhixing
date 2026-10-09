import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ requests: [] as { text: string; resolve: (value: unknown) => void; reject: (error: Error) => void }[],
  destroy: vi.fn(), styleDestroy: vi.fn(), styleCreate: vi.fn() }));
vi.mock('@opentui/core', () => ({
  RGBA: { fromIndex: (index: number) => index, defaultForeground: () => 'default' },
  SyntaxStyle: { fromStyles: () => { state.styleCreate(); return { destroy: state.styleDestroy }; } },
  StyledText: class { constructor(readonly chunks: unknown[]) {} },
  TreeSitterClient: class {
    on() { return this; }
    highlightOnce(text: string) { return new Promise((resolve, reject) => state.requests.push({ text, resolve, reject })); }
    async destroy() { state.destroy(); for (const request of state.requests) request.reject(Error('closed')); }
  },
  treeSitterToTextChunks: (text: string) => [{ __isChunk: true, text }],
}));
import { BodyHighlighter } from './highlighting.js';
import type { BodyRenderBlock } from './layout.js';
const block = (key: string): BodyRenderBlock => ({ key, blockId: key, role: 'assistant', text: key,
  runs: [{ from: 0, to: key.length, text: key, style: 0 }],
  node: { from: 0, to: key.length, kind: 'code', language: 'typescript', runs: [] } });
afterEach(() => { vi.unstubAllEnvs(); state.requests.length = 0; vi.clearAllMocks(); });
describe('body highlighter actual lifetime', () => {
  it('keeps unchanged current-page code across streaming updates without parsing or repainting it again', async () => {
    vi.stubEnv('OTUI_ASSET_ROOT', process.platform === 'win32' ? 'C:\\fixture\\assets' : '/fixture/assets');
    const changed = vi.fn(), highlighter = new BodyHighlighter(changed, vi.fn());
    const fixed = block('fixed'), tail = { ...block('tail'), node: { ...block('tail').node, kind: 'paragraph' as const } };
    highlighter.setPage([fixed, tail]);
    highlighter.setPage([structuredClone(fixed), { ...tail, text: 'longer' }]);
    state.requests[0]!.resolve({ highlights: [] });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const rendered = highlighter.get('fixed');
    expect(rendered).toBeDefined();
    for (let i = 0; i < 20; i++) highlighter.setPage([structuredClone(fixed), { ...tail, text: String(i) }]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(state.requests).toHaveLength(1); expect(changed).toHaveBeenCalledTimes(1);
    expect(highlighter.get('fixed')).toBe(rendered);
    highlighter.setPage([{ ...fixed, text: 'changed' }]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(highlighter.get('fixed')).toBeUndefined(); expect(state.requests.at(-1)!.text).toBe('changed');
    highlighter.setPage([]); state.requests.at(-1)!.resolve({ highlights: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(highlighter.get('fixed')).toBeUndefined();
    await highlighter.close();
  });
  it('retains one active request and only the newest page, and ignores a late old result', async () => {
    vi.stubEnv('OTUI_ASSET_ROOT', process.platform === 'win32' ? 'C:\\fixture\\assets' : '/fixture/assets');
    const changed = vi.fn(), failed = vi.fn(), highlighter = new BodyHighlighter(changed, failed);
    highlighter.setPage([block('old')]); highlighter.setPage([block('superseded')]); highlighter.setPage([block('current')]);
    expect(state.requests.map(request => request.text)).toEqual(['old']);
    state.requests[0]!.resolve({ highlights: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(state.requests.map(request => request.text)).toEqual(['old', 'current']);
    expect(changed).not.toHaveBeenCalled();
    state.requests[1]!.resolve({ highlights: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(highlighter.get('old')).toBeUndefined();
    expect(highlighter.get('current')).toBeDefined();
    expect(changed).toHaveBeenCalledTimes(1);
    await highlighter.close();
    expect(state.destroy).toHaveBeenCalledTimes(1);
    expect(state.styleDestroy).toHaveBeenCalledTimes(1);
    expect(failed).not.toHaveBeenCalled();
  });
  it('awaits worker destruction and suppresses redraw after close', async () => {
    vi.stubEnv('OTUI_ASSET_ROOT', process.platform === 'win32' ? 'C:\\fixture\\assets' : '/fixture/assets');
    const changed = vi.fn(), failed = vi.fn(), highlighter = new BodyHighlighter(changed, failed);
    highlighter.setPage([block('pending')]);
    const first = highlighter.close(), second = highlighter.close();
    expect(first).toBe(second);
    await first;
    highlighter.setPage([block('late')]);
    expect(state.requests).toHaveLength(1);
    expect(changed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
  });
  it('starts a page submitted after an empty job resolved but before its finalizer', async () => {
    vi.stubEnv('OTUI_ASSET_ROOT', process.platform === 'win32' ? 'C:\\fixture\\assets' : '/fixture/assets');
    const changed = vi.fn(), highlighter = new BodyHighlighter(changed, vi.fn());
    highlighter.setPage([]);
    highlighter.setPage([block('next')]);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(state.requests.map(request => request.text)).toEqual(['next']);
    state.requests[0]!.resolve({ highlights: [] });
    await Promise.resolve(); await Promise.resolve();
    expect(changed).toHaveBeenCalledTimes(1);
    await highlighter.close();
  });
  it('rejects missing bundled assets before allocating native style resources', () => {
    vi.stubEnv('OTUI_ASSET_ROOT', '');
    expect(() => new BodyHighlighter(vi.fn(), vi.fn())).toThrow('terminal-body-parser-assets');
    expect(state.styleCreate).not.toHaveBeenCalled();
    expect(state.destroy).not.toHaveBeenCalled();
  });
});
