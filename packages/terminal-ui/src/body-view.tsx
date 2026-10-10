import { tone, spacing } from './theme.js';
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type JSX } from 'solid-js';
import { bodyBlockGeometry } from './body/geometry.js';
import { extend } from '@opentui/solid';
import { StyledText, TextBuffer, TextBufferView, resolveRenderLib, createTextAttributes, ScrollBoxRenderable,
  TextRenderable, type CliRenderer, type TextChunk, type MouseEvent,
} from '@opentui/core';
import { BODY_STYLE, sameBodyPageContent, sourceLineStarts, type BodyAnchor, type BodyPage, type BodySegment } from './body-model.js';
import { bodyCell, bodyRenderBlocks, retainBodyBlocks, renderedToSource, sourceToRendered, type BodyRenderBlock } from './body/layout.js';
import { BodyHighlighter } from './body/highlighting.js';
import { processBodyBlock, processBodyColor } from './process-model.js';

/** Core 0.5.14 scrolls even after a consumer prevented the wheel event. Respect
 * ownership here so a retained-body page operation cannot scroll a second time. */
export class TerminalScrollBox extends ScrollBoxRenderable {
  // Root owns keyboard navigation; clicking retained text must not steal the
  // editor focus and silently discard the next typed character.
  protected override _focusable = false;
  protected override onMouseEvent(event: MouseEvent): void {
    if (!event.defaultPrevented) super.onMouseEvent(event);
  }
}

type NativeSelection = NonNullable<ReturnType<CliRenderer['getSelection']>>;
type ScreenRange = { from: { x: number; y: number }; to: { x: number; y: number } };
type SourcePoint = { source: BodyAnchor; key: string; cellOffset: number; rowOffset: number };
/** A reflow restores the exact highlight separately from the original mouse
 * endpoints. The renderer keeps the real gesture for subsequent Ctrl extension;
 * the leaf projects its frozen range without replaying word/line expansion. */
class BodyTextRenderable extends TextRenderable {
  restoringSelection?: ScreenRange;
  #restored: NativeSelection | null = null;
  #range?: ScreenRange;
  override onSelectionChanged(selection: NativeSelection | null): boolean {
    if (selection && this.restoringSelection) { this.#restored = selection; this.#range = this.restoringSelection; }
    else if (selection !== this.#restored || selection?.isDragging) {
      // The native update API otherwise reuses the previous projected anchor.
      if (this.#restored) this.textBufferView.resetLocalSelection();
      this.#restored = null; this.#range = undefined;
    }
    if (selection && this.#range) {
      const { from, to } = this.#range;
      this.lastLocalSelection = { anchorX: from.x - this.x, anchorY: from.y - this.y,
        focusX: to.x - this.x, focusY: to.y - this.y, behavior: 'cell', isActive: true };
      const local = this.lastLocalSelection;
      this.textBufferView.setSelectionOccupancy('boundary');
      this.textBufferView.setLocalSelection(local.anchorX, local.anchorY, local.focusX, local.focusY,
        this._selectionBg, this._selectionFg, 'cell');
      this.requestRender();
      return this.hasSelection();
    }
    this.textBufferView.setSelectionOccupancy('cell');
    return super.onSelectionChanged(selection);
  }
}
declare module '@opentui/solid' { interface OpenTUIComponents { body_text: typeof BodyTextRenderable } }
extend({ body_text: BodyTextRenderable });

export interface BodyViewHandle {
  hasSelection(): boolean;
  selectedText(): string;
  selectionRange(): { from: BodyAnchor; to: BodyAnchor } | undefined;
  page(direction: -1 | 1, rows?: number): Promise<void>;
  bottom(): Promise<void>;
  anchor(): BodyAnchor | undefined;
  /** Root calls this immediately before replacing page/size signals. */
  beforeUpdate(): void;
  resetReading(): void;
  close(): Promise<void>;
}
export interface BodyViewProps {
  readonly header?: JSX.Element;
  readonly page: BodyPage; readonly width: number; readonly height: number;
  readonly renderer: CliRenderer;
  readonly anchor?: BodyAnchor;
  readonly hasEarlier?: boolean;
  readonly requestPage: (start: number | undefined, follow: boolean) => Promise<unknown>;
  readonly requestPrevious: () => Promise<unknown>;
  readonly onAnchor: (anchor: BodyAnchor | undefined) => void;
  readonly onError: (error: unknown) => void;
  readonly onReady?: (handle: BodyViewHandle | undefined) => void;
  readonly onReading?: (state: { below: boolean; loading: boolean; retry?: -1 | 1 }) => void;
}
const teal = tone.brand, gray = tone.dim, codeBackground = tone.history;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function styled(block: BodyRenderBlock): StyledText {
  return new StyledText(block.runs.map(run => ({ __isChunk: true, text: run.text,
    link: run.href ? { url: run.href } : undefined,
    fg: run.semantic ? tone[run.semantic === 'added' ? 'success' : run.semantic === 'removed' ? 'error' : 'brand'] :
      processBodyColor(block.role, '') ? tone[processBodyColor(block.role, '')!] : (run.style & BODY_STYLE.link) ? teal : block.role === 'thinking' ? gray : tone.text,
    bg: (run.style & BODY_STYLE.code) ? codeBackground : undefined,
    attributes: createTextAttributes({ bold: !!(run.style & BODY_STYLE.bold), italic: !!(run.style & BODY_STYLE.italic),
      strikethrough: !!(run.style & BODY_STYLE.strike), underline: !!(run.style & BODY_STYLE.link), dim: !!(run.style & BODY_STYLE.dim) }),
  } satisfies TextChunk)));
}

/** The existing root remains the only input/screen owner. This component owns
 * only a finite body page, its native measurements and its reading position. */
export function BodyView(props: BodyViewProps) {
  const contentWidth = () => Math.max(1, props.width - spacing.scrollbar - 2 * spacing.content);
  const [headerHeight, setHeaderHeight] = createSignal(0);
  const showHeader = () => props.header && props.page.start === props.page.first;
  const prefixHeight = () => showHeader() ? headerHeight() : 0;
  // Keep live range counters for navigation without reflowing unchanged text.
  const contentPage = createMemo<BodyPage>(previous => previous && sameBodyPageContent(previous, props.page) ? previous : props.page);
  const projected = new Map<BodySegment, readonly BodyRenderBlock[]>();
  const blocks = createMemo<readonly BodyRenderBlock[]>(previous => retainBodyBlocks(
    bodyRenderBlocks(contentPage(), projected).map(block => processBodyBlock(block, bodyBlockGeometry(block, contentWidth()).textWidth)), previous));
  const blockIndex = createMemo(() => new Map(blocks().map(block => [block.key, block])));
  const blockKeys = createMemo(() => [...blockIndex().keys()]);
  const mounted = new Map<string, { block: BodyRenderBlock; view: BodyTextRenderable }>();
  const [highlightRevision, setHighlightRevision] = createSignal(0);
  const highlighter = new BodyHighlighter(() => setHighlightRevision(value => value + 1), props.onError);
  const measure = TextBuffer.create(props.renderer.widthMethod);
  const measureView = TextBufferView.create(measure);
  measureView.setWrapMode('none');
  const wrapMeasure = TextBufferView.create(measure);
  wrapMeasure.setWrapMode('char');
  const measured = new WeakMap<BodyRenderBlock, { width: number; height: number }>();
  const [viewport, setViewport] = createSignal<{ page?: BodyPage; width: number; top: number; selecting: boolean }>({ width: 0, top: 0, selecting: false });
  let pendingScroll = 0, readError: -1 | 1 | undefined;
  let readingGeneration = 0;
  let prefetched: BodyPage | undefined;
  const reportReading = () => props.onReading?.({ below: !!box && (box.scrollTop + box.viewport.height < box.scrollHeight ||
    props.page.start + props.page.segments.length < props.page.last), loading: paging, retry: readError });
  // Measure the finite page without allocating a native text buffer, selection
  // store and reactive subtree for every offscreen paragraph. Fixed-height
  // placeholders preserve the same scroll geometry and source page.
  const geometry = createMemo(() => {
    const width = contentWidth(); let top = prefixHeight();
    return blocks().map(block => {
      let cached = measured.get(block);
      if (!cached || cached.width !== width) {
        const rows = (text: string, columns: number) => {
          measure.setText(text); wrapMeasure.setWrapWidth(Math.max(1, columns));
          return Math.max(1, wrapMeasure.getVirtualLineCount());
        };
        let height = 1;
        const layout = bodyBlockGeometry(block, width);
        if (block.node.kind === 'table') {
          const columns = block.node.columns ?? 1, { stacked, cellWidth } = layout;
          const sizes = Array.from({ length: columns }, (_, cell) => rows(bodyCell(block, cell).text, cellWidth - 1) +
            (stacked && !block.node.header ? rows(`${block.node.labels?.[cell] ?? `列 ${cell + 1}`}：`, cellWidth - 1) : 0));
          height = 1 + (stacked ? sizes.reduce((sum, size) => sum + size, 0) : Math.max(1, ...sizes));
        } else if (!['rule', 'space'].includes(block.node.kind)) {
          height = rows(block.text, layout.textWidth);
        }
        cached = { width, height }; measured.set(block, cached);
      }
      const item = { key: block.key, top, height: cached.height + (block.gapBefore ?? 0) }; top += item.height; return item;
    });
  });
  const visible = createMemo(() => {
    const items = geometry(), state = viewport(), height = Math.max(1, props.height);
    let top = state.top;
    const page = contentPage();
    if (state.page !== page || state.width !== props.width) {
      top = page.follow ? Math.max(0, (items.at(-1)?.top ?? 0) + (items.at(-1)?.height ?? 0) - height) : 0;
      const anchor = props.anchor;
      if (!page.follow && anchor) {
        const index = blocks().findIndex(block => sourceToRendered(block, anchor) !== undefined);
        if (index >= 0) top = items[index]!.top;
      }
    }
    // Keep the native selection owner intact throughout a gesture/reflow.
    return new Set(items.filter(item => state.selecting || (item.top + item.height >= top - height && item.top <= top + 2 * height)).map(item => item.key));
  });
  const heights = createMemo(() => new Map(geometry().map(item => [item.key, item.height])));
  let box: ScrollBoxRenderable | undefined, disposed = false, paging = false, pauseRequested = false;
  let saved: BodyAnchor | undefined = props.page.follow ? undefined : props.anchor, align: 'top' | 'bottom' | undefined;
  let lastPage: BodyPage | undefined, lastWidth = 0, lastHeight = 0;
  let restorePending = true;
  let layoutReady = false;
  let selection: { from: BodyAnchor; to: BodyAnchor; anchor: SourcePoint; focus: SourcePoint; behavior: NativeSelection['behavior'];
    parts: { key: string; from: BodyAnchor; to: BodyAnchor; fromBias: number; toBias: number }[] } | undefined;
  let selectionOwner: NativeSelection | undefined, selectionGesture: string | undefined;
  // Native lineStartCols are absolute buffer columns, not columns relative to
  // each logical line. Subtract that line's first wrapped-row origin.
  const lineBase = (info: TextRenderable['lineInfo'], logical: number) => info.lineStartCols[info.lineSources.indexOf(logical)] ?? 0;
  const position = (entry: { block: BodyRenderBlock; view: TextRenderable }, row: number, x = 0): BodyAnchor => {
    const info = entry.view.lineInfo, logical = info.lineSources[row] ?? 0;
    const lines = sourceLineStarts(entry.block.text), start = lines[logical] ?? 0;
    const end = lines[logical + 1] ?? entry.block.text.length;
    const text = entry.block.text.slice(start, end), column = Math.max(0, (info.lineStartCols[row] ?? 0) - lineBase(info, logical) + x);
    measure.setText(text);
    const lib = resolveRenderLib();
    const bytes = lib.textBufferGetTextRangeByCoords(measure.ptr, 0, 0, 0, column, Buffer.byteLength(text));
    let prefix = bytes ? lib.decoder.decode(bytes) : '';
    // A coordinate inside a wide cell belongs to that grapheme, not to the
    // next one. Native range extraction includes the entire partial grapheme.
    measure.setText(prefix);
    if ((measureView.logicalLineInfo.lineWidthCols[0] ?? 0) > column) {
      const last = graphemes.segment(prefix).containing(prefix.length - 1);
      prefix = prefix.slice(0, last?.index ?? prefix.length);
    }
    return renderedToSource(entry.block, start + prefix.length);
  };
  const selectedEntries = (current: NativeSelection) => [...mounted.values()].filter(entry => {
    if (entry.view.isDestroyed) return false;
    // Empty structured rows have no native text range. Their row boundary
    // still belongs to a gesture crossing it, including a final blank row.
    if (!entry.block.text && entry.block.node.decoration !== undefined)
      return current.anchor.y !== current.focus.y && entry.view.y >= Math.min(current.anchor.y, current.focus.y) &&
        entry.view.y <= Math.max(current.anchor.y, current.focus.y);
    if (!current.selectedRenderables.includes(entry.view)) return false;
    const range = entry.view.getSelection();
    return range && range.start !== range.end;
  }).sort((a, b) => a.view.y - b.view.y || a.view.x - b.view.x);
  const captureSelection = (current: NonNullable<ReturnType<CliRenderer['getSelection']>>) => {
    const owned = new Set([...mounted.values()].filter(entry => !entry.view.isDestroyed).map(entry => entry.view));
    // Empty source lines have touched leaves but no selected characters. Still
    // reject fields, stale leaves and mixed selections before claiming Ctrl+C.
    if (current.isDragging || current.selectedRenderables.some(leaf => !owned.has(leaf as BodyTextRenderable)) ||
        !current.touchedRenderables.some(leaf => owned.has(leaf as BodyTextRenderable))) return undefined;
    // Read native selected ranges, including word/line expansion and wide
    // graphemes. Pointer endpoints alone do not describe the selected text.
    const entries = selectedEntries(current);
    const first = entries[0], last = entries.at(-1);
    if (!first || !last) return undefined;
    const parts = entries.map(entry => {
      const range = entry.view.getSelection() ?? { start: 0, end: 0 };
      measure.setText(entry.block.text);
      const start = measure.getTextRange(0, Math.min(range.start, range.end)).length;
      const end = measure.getTextRange(0, Math.max(range.start, range.end)).length;
      const from = renderedToSource(entry.block, start), to = renderedToSource(entry.block, end);
      // A source tab can expand into several rendered spaces. Keep the exact
      // position within that expansion, not just its shared source coordinate.
      return { key: entry.block.key, from, to,
        fromBias: start - sourceToRendered(entry.block, from)!, toBias: end - sourceToRendered(entry.block, to)! };
    });
    const anchor = pointerSource(current.anchor), focus = pointerSource(current.focus);
    if (!anchor || !focus) return undefined;
    return { from: parts[0]!.from, to: parts.at(-1)!.to, anchor, focus, behavior: current.behavior, parts };
  };
  // Native anchor is derived from its leaf's CURRENT geometry; it moves even
  // without input. Focus changes only via updateSelection (user gesture or our
  // own restore, which explicitly rebinds the snapshot below). A new native
  // selection object identifies a new anchor; never infer one from layout.
  const gesture = (current: NativeSelection) => `${current.focus.x}:${current.focus.y}:${current.behavior}`;
  // Capture when the user changes the gesture, before any layout changes.
  // Resize and equivalent page updates must never reinterpret old pixels as a
  // new selection. Copy admission, payload and restoration share this source.
  const currentSelection = () => {
    const current = props.renderer.getSelection();
    if (disposed || !current) { selection = undefined; selectionOwner = undefined; selectionGesture = undefined; return undefined; }
    if (current.isDragging) return undefined;
    const identity = gesture(current);
    if (current !== selectionOwner || identity !== selectionGesture) {
      selection = captureSelection(current); selectionOwner = current; selectionGesture = identity;
    }
    if (!selection || selection.parts.some(part => {
      const block = mounted.get(part.key)?.block ?? blockIndex().get(part.key);
      if (!block) return true;
      const from = sourceToRendered(block, part.from), to = sourceToRendered(block, part.to);
      return from === undefined || to === undefined || from + part.fromBias > block.text.length || to + part.toBias > block.text.length;
    })) return undefined;
    return selection;
  };
  const sourcePoint = (anchor: BodyAnchor, key?: string, bias = 0) => {
    const preferred = key ? mounted.get(key) : undefined;
    for (const entry of preferred ? [preferred, ...mounted.values()] : mounted.values()) {
      const sourceOffset = sourceToRendered(entry.block, anchor);
      if (sourceOffset === undefined || entry.view.isDestroyed) continue;
      const offset = sourceOffset + bias;
      if (offset > entry.block.text.length) continue;
      const lines = sourceLineStarts(entry.block.text);
      let logical = 0;
      while (logical + 1 < lines.length && lines[logical + 1]! <= offset) logical++;
      measure.setText(entry.block.text.slice(lines[logical]!, offset));
      const column = measureView.logicalLineInfo.lineWidthCols[0] ?? 0, info = entry.view.lineInfo;
      let row = 0;
      const base = lineBase(info, logical);
      for (let i = 0; i < info.lineSources.length; i++) if (info.lineSources[i] === logical && info.lineStartCols[i]! - base <= column) row = i;
      return { view: entry.view, x: entry.view.x + column - ((info.lineStartCols[row] ?? 0) - base), y: entry.view.y + row };
    }
    return undefined;
  };
  const pointerSource = (point: { x: number; y: number }): SourcePoint | undefined => {
    const entries = [...mounted.values()].filter(entry => !entry.view.isDestroyed && (entry.block.text || entry.block.node.decoration !== undefined));
    // A drag may finish in the margin or outside a leaf; use the nearest body
    // leaf while retaining the actual cell offset, rather than snapping to an edge.
    const distance = (entry: typeof entries[number]) => {
      const v = entry.view, rows = Math.max(1, v.height, v.lineInfo.lineSources.length);
      return Math.max(v.y - point.y, 0, point.y - (v.y + rows - 1)) * Math.max(1, props.width)
        + Math.max(v.x - point.x, 0, point.x - (v.x + v.width - 1));
    };
    const entry = entries.sort((a, b) => distance(a) - distance(b))[0];
    if (!entry) return undefined;
    const source = position(entry, Math.max(0, Math.min(point.y - entry.view.y, entry.view.lineInfo.lineSources.length - 1)), point.x - entry.view.x);
    const origin = sourcePoint(source, entry.block.key);
    return origin ? { source, key: entry.block.key, cellOffset: point.x - origin.x, rowOffset: point.y - origin.y } : undefined;
  };
  const capture = (): BodyAnchor | undefined => {
    if (!box || disposed || restorePending) return saved;
    const top = box.viewport.y;
    let first: { block: BodyRenderBlock; view: TextRenderable } | undefined;
    for (const entry of mounted.values()) {
      if (entry.view.isDestroyed || !entry.block.text) continue;
      // Culled native leaves report height 0 until painted. Their line map
      // still defines the source newly exposed by this scroll operation.
      const rows = Math.max(entry.view.height, entry.view.lineInfo.lineSources.length);
      if (entry.view.y + rows <= top) continue;
      if (!first || entry.view.y < first.view.y) first = entry;
    }
    return first ? position(first, Math.max(0, Math.floor(top - first.view.y))) : saved;
  };
  const finishBodySelection = () => {
    const current = props.renderer.getSelection();
    if (disposed || !current || current.isDragging || ![...mounted.values()].some(entry => current.touchedRenderables.includes(entry.view))) return;
    const focus = pointerSource(current.focus), target = focus && mounted.get(focus.key)?.view;
    if (!target) return;
    // OpenTUI widens a selection container by one ancestor per movement.
    // A fast drag across sibling rows can finish before reaching their common
    // body container. Finish that same native gesture at its actual endpoint.
    let container = props.renderer.getSelectionContainer();
    for (let depth = 0; depth < 16; depth++) {
      props.renderer.updateSelection(target, current.focus.x, current.focus.y, { finishDragging: true });
      const next = props.renderer.getSelectionContainer();
      if (!next || next === container) break;
      container = next;
    }
    // Even a pure-newline selection belongs to this source range although the
    // renderer has no selected character leaf for it.
    selection = captureSelection(current); selectionOwner = current; selectionGesture = gesture(current);
  };
  const restore = () => {
    if (!box || disposed || !restorePending) return;
    // A parent size callback updates the child's explicit width after native
    // layout. Give that width one complete layout before reading its line map.
    // Otherwise a narrow/wide transition restores with the previous wrapping.
    if (!layoutReady) { layoutReady = true; props.renderer.requestRender(); return; }
    const scrollTop = box.scrollTop;
    if (align === 'bottom' || (props.page.follow && !saved)) box.scrollTo(box.scrollHeight);
    else if (align === 'top') box.scrollTo(0);
    else if (saved) {
      for (const entry of mounted.values()) {
        const offset = sourceToRendered(entry.block, saved);
        if (offset === undefined || entry.view.isDestroyed) continue;
        const lines = sourceLineStarts(entry.block.text);
        let logical = 0;
        while (logical + 1 < lines.length && lines[logical + 1]! <= offset) logical++;
        measure.setText(entry.block.text.slice(lines[logical]!, offset));
        const column = measureView.logicalLineInfo.lineWidthCols[0] ?? 0;
        const info = entry.view.lineInfo, base = lineBase(info, logical);
        let row = 0;
        for (let i = 0; i < info.lineSources.length; i++) {
          if (info.lineSources[i] === logical && info.lineStartCols[i]! - base <= column) row = i;
        }
        box.scrollTo(box.scrollTop + entry.view.y - box.viewport.y + row); break;
      }
    }
    align = undefined;
    // Scrolling changes ancestor positions in the next layout. Restoring a
    // global selection before that layout mixes old geometry with the new text.
    if (box.scrollTop !== scrollTop) { props.renderer.requestRender(); return; }
    if (pendingScroll) { box.scrollBy(pendingScroll); pendingScroll = 0; props.renderer.requestRender(); }
    restorePending = false;
    if (selection) {
      const first = selection.parts[0]!, last = selection.parts.at(-1)!;
      const from = sourcePoint(selection.from, first.key, first.fromBias), to = sourcePoint(selection.to, last.key, last.toBias);
      const anchor = sourcePoint(selection.anchor.source, selection.anchor.key), focus = sourcePoint(selection.focus.source, selection.focus.key);
      if (from && to && anchor && focus) {
        for (const entry of mounted.values()) entry.view.restoringSelection = { from, to };
        try {
          props.renderer.startSelection(anchor.view, anchor.x + selection.anchor.cellOffset, anchor.y + selection.anchor.rowOffset, selection.behavior);
          // A restored range jumps straight to its endpoint. Native mouse drags
          // normally widen the selection container one ancestor per move.
          let container = props.renderer.getSelectionContainer();
          while (true) {
            props.renderer.updateSelection(focus.view, focus.x + selection.focus.cellOffset, focus.y + selection.focus.rowOffset, { finishDragging: true });
            const next = props.renderer.getSelectionContainer();
            if (!next || next === container) break;
            container = next;
          }
        } finally {
          for (const entry of mounted.values()) entry.view.restoringSelection = undefined;
        }
        const restored = props.renderer.getSelection();
        selectionOwner = restored ?? undefined; selectionGesture = restored ? gesture(restored) : undefined;
      }
    }
  };
  const handle: BodyViewHandle = {
    hasSelection() { const current = currentSelection(); return !!current && (current.parts.length > 1 || current.parts.some(part =>
      part.from.contentOffset !== part.to.contentOffset || part.fromBias !== part.toBias)); },
    selectionRange() { return currentSelection(); },
    selectedText() {
      const current = currentSelection();
      if (!current) return '';
      const selected = current.parts.map(part => {
        const block = (mounted.get(part.key)?.block ?? blockIndex().get(part.key))!;
        return { block, text: block.text.slice(sourceToRendered(block, part.from)! + part.fromBias, sourceToRendered(block, part.to)! + part.toBias) };
      });
      return selected.map((item, index) => {
        const previous = selected[index - 1];
        if (!previous) return item.text;
        const sameSource = previous.block.blockId === item.block.blockId;
        const sameTableRow = sameSource && previous.block.node.kind === 'table' && item.block.node.kind === 'table' &&
          (previous.block.node.origin ?? previous.block.node.from) === (item.block.node.origin ?? item.block.node.from);
        const continuation = sameSource && previous.block.key === item.block.key;
        if (sameSource && previous.block.node.decoration && item.block.node.decoration && !continuation) {
          const rendered = blocks(), a = rendered.findIndex(block => block.key === previous.block.key), b = rendered.findIndex(block => block.key === item.block.key);
          const blank = a < 0 || b < 0 ? 0 : rendered.slice(a + 1, b).filter(block => block.blockId === item.block.blockId && block.node.decoration && !block.text).length;
          return '\n'.repeat(blank + (previous.text.endsWith('\n') ? 0 : 1)) + item.text;
        }
        return (sameTableRow ? '\t' : continuation || previous.text.endsWith('\n') ? '' : '\n') + item.text;
      }).join('');
    },
    anchor: capture,
    beforeUpdate() {
      if (disposed) return;
      if (!props.page.follow) { saved = capture(); props.onAnchor(saved); }
      if (!restorePending) {
        selection = currentSelection();
      }
      // Freeze this pre-layout source anchor. A resize can trigger several
      // nested size callbacks before the next frame; none may recapture from
      // the partially updated layout and replace it with a different row.
      restorePending = true;
      layoutReady = false;
      props.renderer.requestRender();
    },
    close() {
      release();
      return highlighter.close();
    },
    resetReading() {
      readingGeneration++; paging = false; pauseRequested = false; readError = undefined;
      pendingScroll = 0; saved = undefined; selection = undefined; selectionOwner = undefined; selectionGesture = undefined; align = undefined; prefetched = undefined;
      reportReading();
    },
    async page(direction, rows) {
      if (!box || disposed || paging) return;
      const generation = ++readingGeneration;
      const current = () => !disposed && generation === readingGeneration;
      saved = capture(); props.onAnchor(saved);
      paging = true;
      readError = undefined; reportReading();
      try {
        const atEdge = direction < 0 ? box.scrollTop <= 0 : box.scrollTop + box.viewport.height >= box.scrollHeight;
        if (!atEdge) {
          box.scrollBy(direction * Math.max(0, rows ?? box.viewport.height - 2));
          saved = capture(); props.onAnchor(saved);
          if (props.page.follow) await props.requestPage(props.page.start, false);
          return;
        }
        const before = props.page;
        align = undefined; pendingScroll = direction * Math.max(0, rows ?? box.viewport.height - 2);
        if (direction < 0 && props.page.start === props.page.first) await props.requestPrevious();
        else if (direction < 0) await props.requestPage(Math.max(props.page.first, props.page.start - 4), false);
        else if (props.page.start + props.page.segments.length < props.page.last) await props.requestPage(props.page.start + props.page.segments.length, false);
        else await handle.bottom();
        if (current() && props.page === before) pendingScroll = 0;
      } catch { if (current()) { pendingScroll = 0; readError = direction; } }
      finally { if (current()) { paging = false; reportReading(); } }
    },
    async bottom() {
      if (disposed) return;
      const generation = ++readingGeneration;
      readError = undefined; pendingScroll = 0;
      pauseRequested = false;
      saved = undefined; props.onAnchor(undefined); align = 'bottom';
      paging = true; reportReading();
      try { await props.requestPage(undefined, true); }
      catch { if (!disposed && generation === readingGeneration) readError = 1; }
      finally { if (!disposed && generation === readingGeneration) { paging = false; reportReading(); } }
    },
  };
  createEffect(() => {
    prefixHeight();
    const page = contentPage(), width = props.width, height = props.height;
    if (disposed) return;
    if (lastPage && (page !== lastPage || width !== lastWidth || height !== lastHeight)) {
      if (!page.follow && !align) saved = untrack(() => props.anchor ?? capture());
      else if (page.follow && !pauseRequested) saved = undefined;
    }
    lastPage = page; lastWidth = width; lastHeight = height; restorePending = true; layoutReady = false;
    props.renderer.requestRender();
  });
  createEffect(() => { if (!disposed) highlighter.setPage(blocks().filter(block => visible().has(block.key))); });
  const postFrame = () => {
    restore();
    if (!box || disposed) return;
    const state = viewport(), selecting = !!props.renderer.getSelection();
    const page = contentPage();
    if (state.page !== page || state.width !== props.width || state.top !== box.scrollTop || state.selecting !== selecting)
      setViewport({ page, width: props.width, top: box.scrollTop, selecting });
    reportReading();
    // A transport batch must not leave a short viewport looking like EOF.
    // Fetch one neighbour at a time; each accepted page is measured again.
    if (!paging && !readError && !selecting && !restorePending && page !== prefetched && box.scrollHeight < box.viewport.height && page.segments.length) {
      const direction = page.start + page.segments.length < page.last ? 1 : page.start > page.first || props.hasEarlier ? -1 : undefined;
      prefetched = page;
      if (direction) void handle.page(direction, 0).catch(props.onError);
    }
  };
  props.renderer.addPostProcessFn(postFrame);
  props.onReady?.(handle);
  function release() {
    if (disposed) return;
    disposed = true; readingGeneration++; props.onReady?.(undefined);
    props.renderer.removePostProcessFn(postFrame); mounted.clear(); projected.clear(); wrapMeasure.destroy(); measureView.destroy(); measure.destroy();
  }
  onCleanup(() => {
    release();
    void highlighter.close().catch(() => {}); // close() exposes the same promise to the root lifecycle owner.
  });
  const layout = (block: BodyRenderBlock) => bodyBlockGeometry(block, contentWidth());
  const stacked = (block: BodyRenderBlock) => layout(block).stacked;
  const cellWidth = (block: BodyRenderBlock) => layout(block).cellWidth;
  const Text = (value: { block: BodyRenderBlock; width?: number }) => {
    let current: BodyTextRenderable | undefined;
    const key = value.block.key;
    onCleanup(() => { if (mounted.get(key)?.view === current) mounted.delete(key); });
    const plain = createMemo(() => styled(value.block));
    const content = createMemo(() => { highlightRevision(); return highlighter.get(value.block.key) ?? plain(); });
    createEffect(() => {
      if (disposed || !current) return;
      mounted.set(key, { block: value.block, view: current });
      // The Solid content prop coerces objects to strings. The native setter
      // accepts StyledText and retains its runs, links and selection offsets.
      current.content = content();
    });
    return <body_text ref={view => { current = view; if (!disposed) mounted.set(key, { block: value.block, view }); }}
      width={value.width} minHeight={value.block.node.decoration !== undefined ? 1 : undefined} wrapMode="char" selectable />;
  };
  return <scrollbox ref={value => { box = value; }} width={Math.max(1, props.width)} height={Math.max(1, props.height)}
    scrollY scrollX={false} stickyScroll={false}
    verticalScrollbarOptions={{ width: spacing.scrollbar, showArrows: false }}
    onMouseUp={event => { if (event.button === 0) queueMicrotask(finishBodySelection); }}
    onMouseDown={event => {
      if (event.button !== 0) return;
      if (!props.page.follow || pauseRequested || disposed) return;
      const generation = ++readingGeneration;
      paging = false; readError = undefined; reportReading();
      saved = capture(); props.onAnchor(saved); pauseRequested = true;
      void props.requestPage(props.page.start, false).catch(() => {
        if (!disposed && generation === readingGeneration) { readError = -1; reportReading(); }
      }).finally(() => { if (!disposed && generation === readingGeneration) pauseRequested = false; });
    }}
    onMouseScroll={event => {
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;
      event.preventDefault(); event.stopPropagation();
      void handle.page(direction === 'up' ? -1 : 1, 3).catch(props.onError);
    }}>
    <Show when={showHeader()}><box width={Math.max(1, props.width - spacing.scrollbar)} flexShrink={0} onSizeChange={function(this: import('@opentui/core').BoxRenderable) { setHeaderHeight(this.height); }}>{props.header}</box></Show>
    <For each={blockKeys()}>{key => {
      const block = createMemo(() => blockIndex().get(key)!);
      return <box flexDirection="column" flexShrink={0} marginX={spacing.content} width={contentWidth()} paddingLeft={layout(block()).indent} paddingTop={block().gapBefore ?? 0}
      height={heights().get(key)}>
      <Show when={visible().has(key)}>
      <Show when={block().node.kind === 'rule'}><text marginLeft={layout(block()).leading} content={'─'.repeat(layout(block()).bodyWidth)} fg={tone.dim} selectable={false} /></Show>
      <Show when={!['rule', 'space'].includes(block().node.kind)}>
      <Show when={block().node.kind === 'table'} fallback={<box flexDirection="row" flexShrink={0} paddingRight={layout(block()).trailing} backgroundColor={block().role === 'user' ? tone.history : undefined}>
        <text width={layout(block()).leading} content={block().role === 'user' ? '' : block().node.anchor ? ' ◆ ' : block().node.kind === 'quote' ? ' │ ' : block().node.kind === 'heading' ? '# ' : ''}
          fg={block().node.anchor ? tone[processBodyColor(block().role, block().text) ?? 'brand'] : tone.dim} selectable={false} />
        <Show when={block().node.decoration}><text width={block().node.decoration?.length ?? 0}
          content={block().node.from === block().node.origin ? block().node.decoration : ''} fg={tone.dim} selectable={false} /></Show>
        <Text block={block()} width={layout(block()).textWidth} />
      </box>}>
        <box marginLeft={layout(block()).leading} width={layout(block()).bodyWidth} flexDirection={stacked(block()) ? 'column' : 'row'} flexShrink={0} border={['bottom']} borderColor={tone.border}>
          <For each={Array.from({ length: block().node.columns ?? 1 }, (_, i) => i)}>{cell =>
            <box width={cellWidth(block())} paddingRight={1} flexShrink={0} flexDirection="column">
              <Show when={stacked(block()) && !block().node.header}><text selectable={false} fg={tone.dim} wrapMode="char"
                width={Math.max(1, cellWidth(block()) - 1)}>{`${block().node.labels?.[cell] ?? `列 ${cell + 1}`}：`}</text></Show>
              <Text block={bodyCell(block(), cell)} width={Math.max(1, cellWidth(block()) - 1)} />
            </box>}
          </For>
        </box>
      </Show>
      </Show>
      </Show>
    </box>; }}</For>
  </scrollbox>;
}
