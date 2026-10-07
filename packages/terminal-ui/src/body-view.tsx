import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from 'solid-js';
import { extend } from '@opentui/solid';
import { StyledText, TextBuffer, TextBufferView, resolveRenderLib, createTextAttributes, RGBA, ScrollBoxRenderable,
  TextRenderable, type CliRenderer, type TextChunk, type MouseEvent,
} from '@opentui/core';
import { BODY_STYLE, sourceLineStarts, type BodyAnchor, type BodyPage } from './body-model.js';
import { bodyCell, bodyRenderBlocks, renderedToSource, sourceToRendered, type BodyRenderBlock } from './body/layout.js';
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
  page(direction: -1 | 1, rows?: number): Promise<void>;
  bottom(): Promise<void>;
  anchor(): BodyAnchor | undefined;
  /** Root calls this immediately before replacing page/size signals. */
  beforeUpdate(): void;
  close(): Promise<void>;
}
export interface BodyViewProps {
  readonly page: BodyPage; readonly width: number; readonly height: number;
  readonly renderer: CliRenderer;
  readonly anchor?: BodyAnchor;
  readonly requestPage: (start: number | undefined, follow: boolean) => Promise<unknown>;
  readonly requestPrevious: () => Promise<unknown>;
  readonly onAnchor: (anchor: BodyAnchor | undefined) => void;
  readonly onError: (error: unknown) => void;
  readonly onReady?: (handle: BodyViewHandle | undefined) => void;
}
const teal = RGBA.fromHex('#69b5a5'), gray = RGBA.fromHex('#9b9b9b'), codeBackground = RGBA.fromHex('#303030');
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function styled(block: BodyRenderBlock): StyledText {
  return new StyledText(block.runs.map(run => ({ __isChunk: true, text: run.text,
    link: run.href ? { url: run.href } : undefined,
    fg: processBodyColor(block.role, run.text) ? RGBA.fromHex(processBodyColor(block.role, run.text)!) : (run.style & BODY_STYLE.link) ? teal : block.role === 'user' ? gray : undefined,
    bg: (run.style & BODY_STYLE.code) ? codeBackground : undefined,
    attributes: createTextAttributes({ bold: !!(run.style & BODY_STYLE.bold), italic: !!(run.style & BODY_STYLE.italic),
      strikethrough: !!(run.style & BODY_STYLE.strike), underline: !!(run.style & BODY_STYLE.link), dim: !!(run.style & BODY_STYLE.dim) }),
  } satisfies TextChunk)));
}

/** The existing root remains the only input/screen owner. This component owns
 * only a finite body page, its native measurements and its reading position. */
export function BodyView(props: BodyViewProps) {
  const blocks = createMemo(() => bodyRenderBlocks(props.page).map(block => processBodyBlock(block, Math.max(1, props.width - 4))));
  const blockIndex = createMemo(() => new Map(blocks().map(block => [block.key, block])));
  const blockKeys = createMemo(() => [...blockIndex().keys()]);
  const mounted = new Map<string, { block: BodyRenderBlock; view: BodyTextRenderable }>();
  const [highlightRevision, setHighlightRevision] = createSignal(0);
  const highlighter = new BodyHighlighter(() => setHighlightRevision(value => value + 1), props.onError);
  const measure = TextBuffer.create(props.renderer.widthMethod);
  const measureView = TextBufferView.create(measure);
  measureView.setWrapMode('none');
  let box: ScrollBoxRenderable | undefined, disposed = false, paging = false, pauseRequested = false;
  let saved: BodyAnchor | undefined = props.page.follow ? undefined : props.anchor, align: 'top' | 'bottom' | undefined;
  let lastPage: BodyPage | undefined, lastWidth = 0, lastHeight = 0;
  let restorePending = true;
  let selection: { from: BodyAnchor; to: BodyAnchor; anchor: SourcePoint; focus: SourcePoint; behavior: NativeSelection['behavior'] } | undefined;
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
  const captureSelection = (current: NonNullable<ReturnType<CliRenderer['getSelection']>>) => {
    // Read native selected ranges, including word/line expansion and wide
    // graphemes. Pointer endpoints alone do not describe the selected text.
    const entries = [...mounted.values()].filter(entry => {
      if (entry.view.isDestroyed || !current.selectedRenderables.includes(entry.view)) return false;
      const range = entry.view.getSelection();
      return range && range.start !== range.end;
    })
      .sort((a, b) => a.view.y - b.view.y || a.view.x - b.view.x);
    const first = entries[0], last = entries.at(-1);
    if (!first || !last) return undefined;
    const start = first.view.getSelection()!, end = last.view.getSelection()!;
    measure.setText(first.block.text);
    const from = measure.getTextRange(0, Math.min(start.start, start.end)).length;
    measure.setText(last.block.text);
    const prefix = measure.getTextRange(0, Math.max(end.start, end.end));
    const anchor = pointerSource(current.anchor), focus = pointerSource(current.focus);
    if (!anchor || !focus) return undefined;
    return { from: renderedToSource(first.block, from), to: renderedToSource(last.block, prefix.length),
      anchor, focus, behavior: current.behavior };
  };
  const sourcePoint = (anchor: BodyAnchor, key?: string) => {
    const preferred = key ? mounted.get(key) : undefined;
    for (const entry of preferred ? [preferred, ...mounted.values()] : mounted.values()) {
      const offset = sourceToRendered(entry.block, anchor);
      if (offset === undefined || entry.view.isDestroyed) continue;
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
    const entries = [...mounted.values()].filter(entry => !entry.view.isDestroyed && entry.block.text);
    // A drag may finish in the margin or outside a leaf; use the nearest body
    // leaf while retaining the actual cell offset, rather than snapping to an edge.
    const distance = (entry: typeof entries[number]) => {
      const v = entry.view, rows = Math.max(v.height, v.lineInfo.lineSources.length);
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
  const restore = () => {
    if (!box || disposed || !restorePending) return;
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
    restorePending = false;
    if (selection) {
      const from = sourcePoint(selection.from), to = sourcePoint(selection.to);
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
      }
    }
  };
  const handle: BodyViewHandle = {
    anchor: capture,
    beforeUpdate() {
      if (disposed) return;
      if (!props.page.follow) { saved = capture(); props.onAnchor(saved); }
      if (!restorePending) {
        const current = props.renderer.getSelection();
        selection = current ? captureSelection(current) : undefined;
      }
      // Freeze this pre-layout source anchor. A resize can trigger several
      // nested size callbacks before the next frame; none may recapture from
      // the partially updated layout and replace it with a different row.
      restorePending = true;
      props.renderer.requestRender();
    },
    close() {
      release();
      return highlighter.close();
    },
    async page(direction, rows) {
      if (!box || disposed || paging) return;
      saved = capture(); props.onAnchor(saved);
      const atEdge = direction < 0 ? box.scrollTop <= 0 : box.scrollTop + box.viewport.height >= box.scrollHeight;
      if (!atEdge) {
        box.scrollBy(direction * Math.max(1, rows ?? box.viewport.height - 2));
        saved = capture(); props.onAnchor(saved);
        if (props.page.follow) await props.requestPage(props.page.start, false);
        return;
      }
      paging = true;
      try {
        align = direction < 0 ? 'bottom' : 'top';
        if (direction < 0 && props.page.start === props.page.first) await props.requestPrevious();
        else if (direction < 0) await props.requestPage(Math.max(props.page.first, props.page.start - 4), false);
        else if (props.page.start + props.page.segments.length < props.page.last) await props.requestPage(props.page.start + props.page.segments.length, false);
        else await handle.bottom();
      } finally { paging = false; }
    },
    async bottom() {
      if (disposed) return;
      saved = undefined; props.onAnchor(undefined); align = 'bottom';
      await props.requestPage(undefined, true);
    },
  };
  createEffect(() => {
    const page = props.page, width = props.width, height = props.height;
    if (disposed) return;
    if (lastPage && (page !== lastPage || width !== lastWidth || height !== lastHeight)) {
      if (!page.follow && !align) saved = untrack(() => props.anchor ?? capture());
      else if (page.follow && !pauseRequested) saved = undefined;
    }
    lastPage = page; lastWidth = width; lastHeight = height; restorePending = true;
    props.renderer.requestRender();
  });
  createEffect(() => { if (!disposed) highlighter.setPage(blocks()); });
  const postFrame = () => { restore(); };
  props.renderer.addPostProcessFn(postFrame);
  props.onReady?.(handle);
  function release() {
    if (disposed) return;
    disposed = true; props.onReady?.(undefined);
    props.renderer.removePostProcessFn(postFrame); mounted.clear(); measureView.destroy(); measure.destroy();
  }
  onCleanup(() => {
    release();
    void highlighter.close().catch(() => {}); // close() exposes the same promise to the root lifecycle owner.
  });
  const indent = (block: BodyRenderBlock) => block.node.kind === 'list' || block.node.kind === 'quote' ? Math.min(12, block.node.depth ?? 0) : 0;
  const stacked = (block: BodyRenderBlock) => props.width < (block.node.columns ?? 1) * 6;
  const cellWidth = (block: BodyRenderBlock) => stacked(block) ? Math.max(1, props.width - 2) : Math.max(1, Math.floor((props.width - 2) / (block.node.columns ?? 1)));
  const Text = (value: { block: BodyRenderBlock; width?: number }) => {
    let current: BodyTextRenderable | undefined;
    const key = value.block.key;
    onCleanup(() => { if (mounted.get(key)?.view === current) mounted.delete(key); });
    createEffect(() => {
      highlightRevision();
      if (disposed || !current) return;
      mounted.set(key, { block: value.block, view: current });
      // The Solid content prop coerces objects to strings. The native setter
      // accepts StyledText and retains its runs, links and selection offsets.
      current.content = highlighter.get(value.block.key) ?? styled(value.block);
    });
    return <body_text ref={view => { current = view; if (!disposed) mounted.set(key, { block: value.block, view }); }}
      width={value.width} wrapMode="char" selectable />;
  };
  return <scrollbox ref={value => { box = value; }} width={Math.max(1, props.width)} height={Math.max(1, props.height)}
    scrollY scrollX={false} stickyScroll={false}
    onMouseDown={event => {
      if (event.button !== 0) return;
      if (!props.page.follow || pauseRequested || disposed) return;
      saved = capture(); props.onAnchor(saved); pauseRequested = true;
      void props.requestPage(props.page.start, false).catch(error => { if (!disposed) props.onError(error); })
        .finally(() => { pauseRequested = false; });
    }}
    onMouseScroll={event => {
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;
      event.preventDefault(); event.stopPropagation();
      void handle.page(direction === 'up' ? -1 : 1, 3).catch(props.onError);
    }}>
    <For each={blockKeys()}>{key => {
      const block = () => blockIndex().get(key)!;
      return <box flexDirection="column" flexShrink={0} paddingLeft={indent(block())} backgroundColor={block().role === 'user' ? '#303030' : undefined}
      height={block().node.kind === 'space' ? 1 : undefined}>
      <Show when={block().node.kind === 'rule'}><text content={'─'.repeat(Math.max(1, props.width - 2))} fg="#777777" selectable={false} /></Show>
      <Show when={!['rule', 'space'].includes(block().node.kind)}>
      <Show when={block().node.kind === 'table'} fallback={<box flexDirection="row" flexShrink={0}>
        <text width={4} content={block().role === 'user' ? '' : block().node.anchor ? ' ◆ ' : block().node.kind === 'quote' ? ' │ ' : block().node.kind === 'heading' ? '# ' : ''}
          fg={block().node.anchor ? processBodyColor(block().role, block().text) ?? '#69b5a5' : '#777777'} selectable={false} />
        <Text block={block()} width={Math.max(1, props.width - 4 - indent(block()))} />
      </box>}>
        <box flexDirection={stacked(block()) ? 'column' : 'row'} flexShrink={0} border={['bottom']} borderColor="#555555">
          <For each={Array.from({ length: block().node.columns ?? 1 }, (_, i) => i)}>{cell =>
            <box width={cellWidth(block())} paddingRight={1} flexShrink={0}>
              <Text block={bodyCell(block(), cell)} width={Math.max(1, cellWidth(block()) - 1)} />
            </box>}
          </For>
        </box>
      </Show>
      </Show>
    </box>; }}</For>
  </scrollbox>;
}
