import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { StyledText, TextBuffer, TextBufferView, resolveRenderLib, createTextAttributes, RGBA,
  type CliRenderer, type ScrollBoxRenderable, type TextRenderable, type TextChunk,
} from '@opentui/core';
import { BODY_STYLE, sourceLineStarts, type BodyAnchor, type BodyPage } from './body-model.js';
import { bodyCell, bodyRenderBlocks, renderedToSource, sourceToRendered, type BodyRenderBlock } from './body/layout.js';
import { BodyHighlighter } from './body/highlighting.js';
import { processBodyBlock, processBodyColor } from './process-model.js';

export interface BodyViewHandle {
  page(direction: -1 | 1): Promise<void>;
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
  const mounted = new Map<string, { block: BodyRenderBlock; view: TextRenderable }>();
  const [highlightRevision, setHighlightRevision] = createSignal(0);
  const highlighter = new BodyHighlighter(() => setHighlightRevision(value => value + 1), props.onError);
  const measure = TextBuffer.create(props.renderer.widthMethod);
  const measureView = TextBufferView.create(measure);
  measureView.setWrapMode('none');
  let box: ScrollBoxRenderable | undefined, disposed = false, paging = false, pauseRequested = false;
  let saved: BodyAnchor | undefined = props.page.follow ? undefined : props.anchor, align: 'top' | 'bottom' | undefined;
  let lastPage: BodyPage | undefined, lastWidth = 0, lastHeight = 0;
  let restorePending = true;
  let selection: { anchor: BodyAnchor; focus: BodyAnchor } | undefined;
  const position = (entry: { block: BodyRenderBlock; view: TextRenderable }, row: number, x = 0): BodyAnchor => {
    const info = entry.view.lineInfo, logical = info.lineSources[row] ?? 0;
    const lines = sourceLineStarts(entry.block.text), start = lines[logical] ?? 0;
    const end = lines[logical + 1] ?? entry.block.text.length;
    const text = entry.block.text.slice(start, end), column = (info.lineStartCols[row] ?? 0) + x;
    measure.setText(text);
    const lib = resolveRenderLib();
    const prefix = lib.textBufferGetTextRangeByCoords(measure.ptr, 0, 0, 0, column, Buffer.byteLength(text));
    return renderedToSource(entry.block, start + (prefix ? lib.decoder.decode(prefix).length : 0));
  };
  const pointToSource = (point: { x: number; y: number }): BodyAnchor | undefined => {
    for (const entry of mounted.values()) if (!entry.view.isDestroyed && point.y >= entry.view.y && point.y < entry.view.y + entry.view.height &&
        point.x >= entry.view.x && point.x < entry.view.x + entry.view.width) return position(entry, point.y - entry.view.y, point.x - entry.view.x);
    return undefined;
  };
  const sourcePoint = (anchor: BodyAnchor) => {
    for (const entry of mounted.values()) {
      const offset = sourceToRendered(entry.block, anchor);
      if (offset === undefined || entry.view.isDestroyed) continue;
      const lines = sourceLineStarts(entry.block.text);
      let logical = 0;
      while (logical + 1 < lines.length && lines[logical + 1]! <= offset) logical++;
      measure.setText(entry.block.text.slice(lines[logical]!, offset));
      const column = measureView.logicalLineInfo.lineWidthCols[0] ?? 0, info = entry.view.lineInfo;
      let row = 0;
      for (let i = 0; i < info.lineSources.length; i++) if (info.lineSources[i] === logical && info.lineStartCols[i]! <= column) row = i;
      return { view: entry.view, x: entry.view.x + column - (info.lineStartCols[row] ?? 0), y: entry.view.y + row };
    }
    return undefined;
  };
  const capture = (): BodyAnchor | undefined => {
    if (!box || disposed || restorePending) return saved;
    const top = box.viewport.y;
    for (const entry of mounted.values()) {
      if (entry.view.isDestroyed || entry.view.y + entry.view.height <= top) continue;
      return position(entry, Math.max(0, Math.floor(top - entry.view.y)));
    }
    return saved;
  };
  const restore = () => {
    if (!box || disposed || !restorePending) return;
    restorePending = false;
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
        const info = entry.view.lineInfo;
        let row = 0;
        for (let i = 0; i < info.lineSources.length; i++) {
          if (info.lineSources[i] === logical && info.lineStartCols[i]! <= column) row = i;
        }
        box.scrollTo(box.scrollTop + entry.view.y - box.viewport.y + row); break;
      }
    }
    align = undefined;
    if (selection) {
      const anchor = sourcePoint(selection.anchor), focus = sourcePoint(selection.focus);
      if (anchor && focus) {
        props.renderer.startSelection(anchor.view, anchor.x, anchor.y, 'cell');
        props.renderer.updateSelection(focus.view, focus.x, focus.y, { finishDragging: true });
      }
      selection = undefined;
    }
  };
  const handle: BodyViewHandle = {
    anchor: capture,
    beforeUpdate() {
      if (disposed) return;
      if (!props.page.follow) { saved = capture(); props.onAnchor(saved); }
      const current = props.renderer.getSelection();
      if (current) {
        const anchor = pointToSource(current.anchor), focus = pointToSource(current.focus);
        if (anchor && focus) selection = { anchor, focus };
      }
    },
    close() {
      release();
      return highlighter.close();
    },
    async page(direction) {
      if (!box || disposed || paging) return;
      saved = capture(); props.onAnchor(saved);
      const atEdge = direction < 0 ? box.scrollTop <= 0 : box.scrollTop + box.viewport.height >= box.scrollHeight;
      if (!atEdge) {
        box.scrollBy(direction * Math.max(1, box.viewport.height - 2));
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
      if (!page.follow && !align) saved = props.anchor ?? capture();
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
    let current: TextRenderable | undefined;
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
    return <text ref={view => { current = view; if (!disposed) mounted.set(key, { block: value.block, view }); }}
      width={value.width} wrapMode="char" selectable />;
  };
  return <scrollbox ref={value => { box = value; }} width={Math.max(1, props.width)} height={Math.max(1, props.height)}
    scrollY scrollX={false} stickyScroll={false}
    onMouseDown={() => {
      if (!props.page.follow || pauseRequested || disposed) return;
      saved = capture(); props.onAnchor(saved); pauseRequested = true;
      void props.requestPage(props.page.start, false).catch(error => { if (!disposed) props.onError(error); })
        .finally(() => { pauseRequested = false; });
    }}
    onMouseScroll={event => { event.preventDefault(); void handle.page(event.scroll?.direction === 'up' ? -1 : 1).catch(props.onError); }}>
    <For each={blocks()}>{block => <box flexDirection="column" flexShrink={0} paddingLeft={indent(block)}
      marginBottom={block.node.kind === 'space' ? 1 : 0}>
      <Show when={block.node.kind === 'rule'}><text content={'─'.repeat(Math.max(1, props.width - 2))} fg="#777777" selectable={false} /></Show>
      <Show when={block.node.kind === 'table'} fallback={<box flexDirection="row" flexShrink={0}>
        <text width={4} content={block.node.anchor ? ' ◆ ' : block.node.kind === 'quote' ? ' │ ' : block.node.kind === 'heading' ? '# ' : ''}
          fg={block.node.anchor ? '#69b5a5' : '#777777'} selectable={false} />
        <Text block={block} width={Math.max(1, props.width - 4 - indent(block))} />
      </box>}>
        <box flexDirection={stacked(block) ? 'column' : 'row'} flexShrink={0} border={['bottom']} borderColor="#555555">
          <For each={Array.from({ length: block.node.columns ?? 1 }, (_, i) => i)}>{cell =>
            <box width={cellWidth(block)} paddingRight={1} flexShrink={0}>
              <Text block={bodyCell(block, cell)} width={Math.max(1, cellWidth(block) - 1)} />
            </box>}
          </For>
        </box>
      </Show>
    </box>}</For>
  </scrollbox>;
}
