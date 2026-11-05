import { tone, spacing } from './theme.js';
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack, type JSX } from 'solid-js';
import { bodyBlockGeometry, bodyWrapMode, bodyTableGeometry, bodyTableRule } from './body/geometry.js';
import { extend } from '@opentui/solid';
import { StyledText, TextBuffer, TextBufferView, resolveRenderLib, createTextAttributes, TextRenderable, type CliRenderer, type TextChunk } from '@opentui/core';
import { BODY_STYLE, BODY_PAGE_BYTES, BODY_PAGE_FRAGMENTS, bodyPageSegments, bodyWindows, sameBodyPageContent, sourceLineStarts, type BodyAnchor, type BodyPage, type BodySegment } from './body-model.js';
import { BODY_WINDOW_BYTES, BODY_WINDOW_FRAGMENTS, BODY_WINDOW_NODES } from './body-window.js';
import { type TerminalEarlierReply } from './protocol.js';
import { bodyCell, bodyBlockGaps, bodyRenderBlocks, retainBodyBlocks, renderedToSource, sourceToRendered, type BodyRenderBlock } from './body/layout.js';
import { BodyHighlighter } from './body/highlighting.js';
import { processBodyBlock, processBodyColor } from './process-model.js';
import { TerminalScrollBox } from './scroll-box.js';
import { ReadingQueue } from './reading-queue.js';

export { TerminalScrollBox } from './scroll-box.js';

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
  /** 输入接管：结束当前手势。press 为一次新的按下（新手势随后在同一次事件处理里开始），这期间的阅读报告仍算按住 */
  inputTakeover(press?: boolean): void;
  close(): Promise<void>;
}
/**
 * 阅读导航所需的事实。below 用不含导航行的完整高度判定（决定导航行要不要出现）；belowShown 用实际视口判定
 * （导航行已出现时，视口下面是否还有正文）；above 为“上方还有可读正文”：视口顶边以上的正文（欢迎框不算）、
 * 挂载窗口之前的已备页或 N 已存片段、源端还有更早历史，三者任一。holding 为正文里按下的指针手势（拖选、点按）尚未结束，
 * 或一次新的按下正在开始：这期间正文外的布局不应改变正文视口，否则指针下的文字会在手势中途移动。
 */
export interface BodyReadingState { readonly below: boolean; readonly belowShown: boolean; readonly above: boolean; readonly loading: boolean; readonly retry?: -1 | 1; readonly holding: boolean }
export interface BodyViewProps {
  readonly header?: JSX.Element;
  readonly page: BodyPage; readonly width: number; readonly height: number;
  /** 阅读范围的身份（会话与代次，或壳态）；变化时重置阅读状态 */
  readonly readingKey?: string;
  readonly renderer: CliRenderer;
  readonly anchor?: BodyAnchor;
  readonly hasEarlier?: boolean;
  /** 正文与阅读导航行共有的区域高度（不随导航行显隐变化）；判断“下方还有内容”用它，导航行不会因自己的显隐反复出现消失 */
  readonly fullHeight?: number;
  /** 视口可能长到的上限（终端行数）。挂载窗口按它预留：视口一下子变高（如候选面板收起）时要露出的块已经挂好、
   *  在上一帧完成布局，首帧即在原位；否则它们在本帧布局之后才挂上，第一帧会错位 */
  readonly extent?: number;
  readonly requestPage: (start: number | undefined, follow: boolean) => Promise<unknown>;
  /** 取显示序号 before 之前紧邻的一页（回复为 TerminalEarlierReply）；不改 N 的显示游标、跟随与补丁基准 */
  readonly requestEarlier: (before: number) => Promise<unknown>;
  /** 把紧邻挂载窗口起点之前的已备页并入挂载窗口：只在用户向上阅读时调用 */
  readonly reveal: (page: BodyPage) => void;
  /** 可以在后台补邻页（可输入、空闲、输入框为空、无待受理提交、无候选） */
  readonly prefetch?: boolean;
  readonly onAnchor: (anchor: BodyAnchor | undefined) => void;
  readonly onError: (error: unknown) => void;
  readonly onReady?: (handle: BodyViewHandle | undefined) => void;
  readonly onReading?: (state: BodyReadingState) => void;
  /** 正文上的鼠标按下与滚轮是用户操作；这两处阻止冒泡，由此告知外层（外层据此收起进入提醒） */
  readonly onOperation?: () => void;
}
const teal = tone.brand, gray = tone.dim, codeBackground = tone.history;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/**
 * 正文阅读层级：标题按级别、表头、强调各有语义色（颜色是主通道，终端里中文粗体几乎不改变字重）。
 * 优先级：语义色 > 过程类角色 > 链接 > 深灰底上的文字（行内代码、用户消息） > 思考 > 列表记号 > 标题与表头 > 强调 > 正文。
 */
function readingColor(block: BodyRenderBlock, style: number) {
  if (style & BODY_STYLE.marker) return tone.listMarker;
  // 一、二级标题取品牌色；三级及以下用正文前景色（随宿主明暗，浅色背景下也可读），靠加粗区分
  if (block.node.kind === 'heading') return (block.node.depth ?? 1) <= 2 ? tone.heading : tone.text;
  if (block.node.kind === 'table' && block.node.header) return tone.tableHeader;
  return style & BODY_STYLE.bold ? tone.strong : tone.text;
}
/** 片段可能从表格行中间开始：只有含该行源头（from 等于 origin）的表头块才画上边线 */
function tableTop(block: BodyRenderBlock) {
  return !!block.node.header && block.node.from === (block.node.origin ?? block.node.from);
}
function styled(block: BodyRenderBlock): StyledText {
  const h1 = block.node.kind === 'heading' && (block.node.depth ?? 1) === 1;
  return new StyledText(block.runs.map(run => ({ __isChunk: true, text: run.text,
    link: run.href ? { url: run.href } : undefined,
    fg: run.semantic ? tone[run.semantic === 'added' ? 'success' : run.semantic === 'removed' ? 'error' : 'brand'] :
      processBodyColor(block.role, '') ? tone[processBodyColor(block.role, '')!] : (run.style & BODY_STYLE.link) ? teal :
      // 行内代码与用户消息压在固定深灰底上：前景也取固定浅灰，明暗宿主下都可读
      (run.style & BODY_STYLE.code) || block.role === 'user' ? tone.shadeText : block.role === 'thinking' ? gray : readingColor(block, run.style),
    bg: (run.style & BODY_STYLE.code) ? codeBackground : undefined,
    attributes: createTextAttributes({ bold: !!(run.style & BODY_STYLE.bold), italic: !!(run.style & BODY_STYLE.italic),
      strikethrough: !!(run.style & BODY_STYLE.strike), underline: !!(run.style & BODY_STYLE.link) || (h1 && !(run.style & BODY_STYLE.code)), dim: !!(run.style & BODY_STYLE.dim) }),
  } satisfies TextChunk)));
}

/** The existing root remains the only input/screen owner. This component owns
 * only a finite body page, its native measurements and its reading position. */
export function BodyView(props: BodyViewProps) {
  const [following, setFollowing] = createSignal(props.page.follow);
  // 会话正文不画应用竖条，原竖条列还给正文
  const contentWidth = () => Math.max(1, props.width - 2 * spacing.content);
  const [headerHeight, setHeaderHeight] = createSignal(0);
  // Do not evaluate the JSX-valued header getter from pointer callbacks, or
  // cache native nodes across a Show unmount (destroyed nodes cannot remount).
  // 欢迎框跟随本阅读范围里最早挂载过的起点：后台预取让 N 的 first 前移时不隐去它（不挪动正在读的画面）；
  // 只有窗口从前端被裁掉时才隐去
  const [scope, setScope] = createSignal(0);
  const earliest = createMemo<{ scope: number; start: number } | undefined>(previous => {
    const current = scope(), start = props.page.start;
    return !previous || previous.scope !== current ? { scope: current, start } : { scope: current, start: Math.min(previous.start, start) };
  });
  const showHeader = () => props.page.start <= (earliest()?.start ?? props.page.start);
  // 已备页：紧邻挂载窗口起点之前、已取到但尚未挂载的片段；只在用户向上阅读时并入
  const [prepared, setPrepared] = createSignal<{ start: number; segments: readonly BodySegment[] }>();
  const [replyFirst, setReplyFirst] = createSignal(Number.POSITIVE_INFINITY);
  const [sourceEnded, setSourceEnded] = createSignal(false);
  const storeFirst = () => Math.min(props.page.first, replyFirst());
  const preparedStart = () => prepared()?.start ?? props.page.start;
  const storeBefore = () => preparedStart() > storeFirst();
  const sourceMore = () => props.hasEarlier === true && !sourceEnded();
  // 确证到头：窗口已挂到 N 已存的最早处、没有未揭示的已备页、源端已无更早历史，且有消息（空新会话不标）
  const atStart = () => props.page.segments.length > 0 && props.page.start <= storeFirst() && !prepared()?.segments.length &&
    (props.hasEarlier === false || sourceEnded());
  const prefixHeight = () => showHeader() ? headerHeight() : 0;
  // Keep live range counters for navigation without reflowing unchanged text.
  const contentPage = createMemo<BodyPage>(previous => {
    const page = { ...props.page, follow: following() };
    return previous && sameBodyPageContent(previous, page) ? previous : page;
  });
  const projected = new Map<BodySegment, readonly BodyRenderBlock[]>();
  const blocks = createMemo<readonly BodyRenderBlock[]>(previous => retainBodyBlocks(
    bodyBlockGaps(bodyRenderBlocks(contentPage(), projected).map(block => processBodyBlock(block, bodyBlockGeometry(block, contentWidth()).textWidth)).filter(block => block.role !== 'thinking' || block.text.length > 0)), previous));
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
  // 表格分栏只由可见表头与宽度决定（见 bodyTableGeometry）：标签显示宽度用正文原生测量，同一组标签与宽度只算一次
  const labelWidth = (text: string) => { measure.setText(text); return Math.max(0, ...measureView.logicalLineInfo.lineWidthCols); };
  const tableGeometries = new Map<string, ReturnType<typeof bodyTableGeometry>>();
  const tableGeometry = (block: BodyRenderBlock, bodyWidth: number) => {
    const columns = block.node.columns ?? 1, key = `${bodyWidth}\u0000${columns}\u0000${(block.node.labels ?? []).join('\u0001')}`;
    let value = tableGeometries.get(key);
    if (!value) {
      if (tableGeometries.size >= 256) tableGeometries.clear();
      value = bodyTableGeometry(block.node.labels ?? [], columns, bodyWidth, labelWidth); tableGeometries.set(key, value);
    }
    return value;
  };
  // 表格收边只看同一来源块的确定后继：下一个同源块不是本表的行，或本行是来源真实结尾（终态片段的最后节点）。
  // 窗口或挂载边缘、插入的其他消息都不算证据，未定时按“未完”画行分隔
  const tableEnds = createMemo(() => {
    const ends = new Set<string>(), open = new Map<string, BodyRenderBlock>();
    for (const block of blocks()) {
      const pending = open.get(block.blockId);
      if (pending && !(block.node.kind === 'table' && block.node.table === pending.node.table)) { ends.add(pending.key); open.delete(block.blockId); }
      if (block.node.kind !== 'table') continue;
      open.delete(block.blockId);
      if (block.sourceEnd) ends.add(block.key); else open.set(block.blockId, block);
    }
    return ends;
  });
  const [viewport, setViewport] = createSignal<{ page?: BodyPage; width: number; top: number; selecting: boolean }>({ width: 0, top: 0, selecting: false });
  let pendingScroll = 0, readError: -1 | 1 | undefined;
  let readingGeneration = 0;
  // 内容的自然高度（欢迎框＋各块，不含为填满视口的撑高）与不含导航行的完整视口高度一起判断下方是否还有正文
  const natural = () => { const last = geometry().at(-1); return last ? last.top + last.height : prefixHeight(); };
  let pagingSince = 0, pagingTimer: ReturnType<typeof setTimeout> | undefined;
  // 读取在 200 ms 内完成时不显示“正在读取…”：已备页揭示、翻页同步都很快，避免导航行文字闪动
  const beginPaging = () => {
    paging = true; pagingSince = performance.now(); clearTimeout(pagingTimer);
    pagingTimer = setTimeout(() => { if (paging && !disposed) props.renderer.requestRender(); }, 220);
  };
  const reportReading = () => {
    const later = props.page.start + props.page.segments.length < props.page.last;
    const loading = paging && performance.now() - pagingSince >= 200;
    if (!box) return props.onReading?.({ below: later, belowShown: later, above: !!prepared()?.segments.length || storeBefore() || sourceMore(), loading, retry: readError, holding: gestureHold || pressing });
    const content = natural();
    props.onReading?.({
      below: box.scrollTop + Math.max(box.viewport.height, props.fullHeight ?? 0) < content || later,
      belowShown: box.scrollTop + box.viewport.height < content || later,
      // 跟随最新时，正文（不含欢迎框）高过完整视口，顶边以上就有正文：布局之前即可判定
      above: box.scrollTop > prefixHeight() || (following() && natural() - prefixHeight() >= Math.max(box.viewport.height, props.fullHeight ?? 0)) ||
        !!prepared()?.segments.length || storeBefore() || sourceMore(),
      loading, retry: readError, holding: gestureHold || pressing });
  };
  // 不依赖滚动位置的阅读事实一变就报告（布局之前）：导航行与正文在同一帧出现，跟随最新时正文不会因它晚一帧出现而上移一行
  createEffect(() => {
    natural(); props.fullHeight; prepared(); replyFirst(); sourceEnded(); props.hasEarlier; props.page; following();
    untrack(reportReading);
  });
  // Measure the finite page without allocating a native text buffer, selection
  // store and reactive subtree for every offscreen paragraph. Fixed-height
  // placeholders preserve the same scroll geometry and source page.
  const measureBlock = (block: BodyRenderBlock, width: number) => {
      let cached = measured.get(block);
      if (!cached || cached.width !== width) {
        // 测量与显示用同一折行模式（见 bodyWrapMode）；表格单元仍逐字断行
        const rows = (text: string, columns: number, mode: 'word' | 'char' = 'char') => {
          measure.setText(text); wrapMeasure.setWrapMode(mode); wrapMeasure.setWrapWidth(Math.max(1, columns));
          return Math.max(1, wrapMeasure.getVirtualLineCount());
        };
        let height = 1;
        const layout = bodyBlockGeometry(block, width);
        if (block.node.kind === 'table') {
          // 分栏：真实表头起点另占一条上边线，内容取各列最高者，真实行尾再占一条下边线（行分隔、表头分隔或收边）；
          // 窄布局：各列依次带列名排开，真实行尾一条分隔线
          const columns = block.node.columns ?? 1, table = tableGeometry(block, layout.bodyWidth), below = block.rowEnd ? 1 : 0;
          if (table.stacked) {
            const sizes = Array.from({ length: columns }, (_, cell) => rows(bodyCell(block, cell).text, layout.bodyWidth - 1) +
              (!block.node.header ? rows(`${block.node.labels?.[cell] ?? `列 ${cell + 1}`}：`, layout.bodyWidth - 1) : 0));
            height = below + sizes.reduce((sum, size) => sum + size, 0);
          } else {
            const sizes = table.widths.map((width, cell) => rows(bodyCell(block, cell).text, width));
            height = (tableTop(block) ? 1 : 0) + Math.max(1, ...sizes) + below;
          }
        } else if (!['rule', 'space'].includes(block.node.kind)) {
          height = rows(block.text, layout.textWidth, bodyWrapMode(block));
        }
        cached = { width, height }; measured.set(block, cached);
      }
      return cached.height;
  };
  const geometry = createMemo(() => {
    const width = contentWidth(); let top = prefixHeight();
    return blocks().map(block => {
      const item = { key: block.key, top, height: measureBlock(block, width) + (block.gapBefore ?? 0) }; top += item.height; return item;
    });
  });
  // 已备页按当前宽度的自然行高（含块间距，另加与挂载窗口之间的一行间距）计入补读目标
  const preparedHeight = createMemo(() => {
    const p = prepared(), width = contentWidth();
    if (!p?.segments.length) return 0;
    const page: BodyPage = { first: p.start, last: p.start + p.segments.length, start: p.start, follow: false, segments: p.segments };
    const rendered = bodyBlockGaps(bodyRenderBlocks(page).map(block => processBodyBlock(block, bodyBlockGeometry(block, width).textWidth))
      .filter(block => block.role !== 'thinking' || block.text.length > 0));
    return rendered.reduce((sum, block) => sum + measureBlock(block, width) + (block.gapBefore ?? 0), 1);
  });
  const visible = createMemo(() => {
    const items = geometry(), state = viewport(), height = Math.max(1, props.height);
    let top = state.top;
    const page = contentPage();
    if (state.page !== page || state.width !== props.width) {
      top = page.follow ? Math.max(0, (items.at(-1)?.top ?? 0) + (items.at(-1)?.height ?? 0) - height) : 0;
      const anchor = props.anchor;
      if (!page.follow && anchor) {
        let index = blocks().findIndex(block => sourceToRendered(block, anchor) !== undefined);
        if (index < 0) index = blocks().findIndex(block => block.blockId === anchor.blockId && block.node.from > anchor.contentOffset);
        if (index >= 0) top = items[index]!.top;
      }
    }
    // Keep the native selection owner intact throughout a gesture/reflow.
    const reach = Math.max(height, props.extent ?? 0);
    return new Set(items.filter(item => state.selecting || (item.top + item.height >= top - reach && item.top <= top + height + reach)).map(item => item.key));
  });
  const heights = createMemo(() => new Map(geometry().map(item => [item.key, item.height])));
  let box: TerminalScrollBox | undefined, disposed = false, paging = false;
  let gestureHold = false, gestureIntent = false, gestureHadSelection = false, navigationVersion = 0, heldVersion = 0, pressing = false;
  let selectionClearPending = false;
  // headerTop 只对记录它时横幅下的那一块有效：之后若在它前面载入了更早内容，横幅位置已不是用户在读的地方
  // headerStart：记录时的窗口起点。同一条长回复的多个承载片段共用一个块键，只比首块键识别不了“前面又载入了内容”
  let anchorOffset = 0, headerTop: number | undefined, headerFirst: string | undefined, headerStart: number | undefined;
  let heldContent: BodyPage | undefined;
  const readQueue = new ReadingQueue(intent => disposed || intent.kind !== 'page' ? Promise.resolve() : props.requestPage(intent.start, intent.follow));
  // 取更早页单飞：后台补读与用户上翻共用；不进翻页队列，源读不阻塞翻页同步
  // earlierStale：最近一次回复属于已被替换的阅读代次（N 未读源）；这次读取安静结束，不算原地踏步、不再补读，等新代基准重置
  let earlierRead: Promise<void> | undefined, earlierScope = 0, earlierProgressed = true, earlierStale = false;
  let fill = { steps: 0, fragments: 0, done: false };
  // 用户正在等更早的内容（上翻到顶）：取到的页超出窗口上限时不保留为已备页，直接交给揭示（窗口从较新的一侧裁剪后移动）
  let intentWaiting = false, overflow: { start: number; segments: readonly BodySegment[] } | undefined;
  // 挂载窗口与已备页合计须守住阅读窗口上限（字节、节点、片数），保留之前就核算
  const usage = (segments: readonly BodySegment[]) => segments.reduce((sum, segment) => ({ bytes: sum.bytes + Buffer.byteLength(JSON.stringify(segment)),
    nodes: sum.nodes + (segment.body?.context.nodes.length ?? 1), count: sum.count + 1 }), { bytes: 0, nodes: 0, count: 0 });
  const fitsWindow = (extra: readonly BodySegment[]) => {
    const total = usage([...bodyPageSegments(props.page), ...extra]);
    return total.count + (props.page.interrupted?.length ?? 0) <= BODY_WINDOW_FRAGMENTS && total.bytes <= BODY_WINDOW_BYTES - 256 && total.nodes <= BODY_WINDOW_NODES;
  };
  const readEarlier = (): Promise<void> => {
    if (earlierRead) return earlierRead;
    const scopeAt = earlierScope, before = preparedStart();
    const work: Promise<void> = props.requestEarlier(before).then(value => {
      if (disposed || scopeAt !== earlierScope) return;
      const reply = value as Partial<TerminalEarlierReply> | undefined;
      earlierStale = reply?.stale === true;
      if (earlierStale) return;
      if (reply?.hasEarlier === false) setSourceEnded(true);
      const page = reply?.page as BodyPage | undefined;
      earlierProgressed = !!page?.segments.length || reply?.progressed !== false;
      if (!page) return;
      if (!Array.isArray(page.segments) || page.segments.length > BODY_PAGE_FRAGMENTS || Buffer.byteLength(JSON.stringify(page)) > BODY_PAGE_BYTES) throw Error('terminal-display-wire-size');
      bodyWindows(page);
      setReplyFirst(first => Math.min(first, page.first));
      // 只接紧邻当前已备起点的一页；期间窗口已变（揭示、裁剪、换窗）就丢弃，下次按新起点重取
      if (!page.segments.length || preparedStart() !== before || page.start + page.segments.length !== before) return;
      const segments = [...page.segments, ...(prepared()?.segments ?? [])];
      if (fitsWindow(segments)) setPrepared({ start: page.start, segments });
      else if (intentWaiting) { setPrepared(undefined); overflow = { start: page.start, segments }; }
      else fill.done = true;
    }).finally(() => { if (earlierRead === work) earlierRead = undefined; if (!disposed) props.renderer.requestRender(); });
    earlierRead = work;
    return work;
  };
  const revealPrepared = () => {
    const p = overflow ?? prepared();
    overflow = undefined;
    if (!p?.segments.length) return false;
    setPrepared(undefined);
    // 揭示在窗口前面插入了内容：欢迎框位置不再是用户在读的地方，按原文锚点恢复
    headerTop = undefined; headerFirst = undefined;
    restorePending = true; layoutReady = false;
    props.reveal({ first: Math.min(storeFirst(), p.start), last: props.page.last, start: p.start, follow: false, segments: p.segments });
    props.renderer.requestRender();
    return true;
  };
  // 窗口起点变了（揭示、裁剪、换窗）而已备页不再紧邻，就丢弃已备页
  createEffect(() => { const start = props.page.start, p = untrack(prepared); if (p && p.start + p.segments.length !== start) setPrepared(undefined); });
  // 后台补读：可输入且空闲时，按当前宽度的自然行高补到“已挂载＋已备 ≥ 两屏”；每次进入至多 16 步、40 片
  const fillStep = () => {
    if (!props.prefetch || fill.done || earlierRead || paging || gestureHold || restorePending || !box || disposed) return;
    if (props.renderer.getSelection()?.isDragging) return;
    const rows = Math.max(box.viewport.height, props.fullHeight ?? 0);
    if (natural() - prefixHeight() + preparedHeight() >= 2 * rows) return;
    if (!storeBefore() && !sourceMore()) return;
    const count = prepared()?.segments.length ?? 0;
    if (fill.steps >= 16 || fill.fragments >= 40 || count + props.page.segments.length >= BODY_WINDOW_FRAGMENTS - BODY_PAGE_FRAGMENTS) { fill.done = true; return; }
    if (!fitsWindow(prepared()?.segments ?? [])) { fill.done = true; return; }
    fill.steps++;
    // 无进展（同一源游标原地踏步）就停，不把步数耗完；失败也停，入口仍在
    void readEarlier().then(() => { fill.fragments += Math.max(0, (prepared()?.segments.length ?? 0) - count); if (earlierStale || !earlierProgressed) fill.done = true; }, () => { fill.done = true; });
  };
  let failedIntent: { start: number | undefined; follow: boolean } | undefined;
  const readingOwner = () => {
    // Pointer takeover retires mouse callbacks, not an in-flight reading
    // intent. Only a new reading intent or scope supersedes this owner.
    const generation = readingGeneration;
    return () => !disposed && generation === readingGeneration;
  };
  const requestPage = (start: number | undefined, follow: boolean): Promise<void> => {
    const current = readingOwner();
    // The physical queue still drains in order. Each caller owns only its
    // current interaction: an old rejection must not affect its successor.
    return readQueue.request({ kind: 'page', start, follow }).catch(error => { if (current()) throw error; });
  };
  const commitReadingIntent = (follow: boolean) => {
    readingGeneration++; paging = false;
    const current = readingOwner();
    const target = { start: follow ? undefined : props.page.start, follow };
    readError = undefined; failedIntent = undefined;
    void requestPage(target.start, target.follow).catch(() => {
      if (!current()) return;
      saved = capture(); props.onAnchor(saved); setFollowing(false);
      failedIntent = target; readError = 1; reportReading();
    });
  };
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
  // 居中、居右的文本（表格单元格）每个显示行按自身行宽对齐，行首不在叶子左边：屏幕列与行内列互换时扣除这段偏移
  const alignShift = (view: TextRenderable, row: number) => {
    const free = Math.max(0, view.width - (view.lineInfo.lineWidthCols[row] ?? 0));
    return view.textAlign === 'right' ? free : view.textAlign === 'center' ? Math.floor(free / 2) : 0;
  };
  const position = (entry: { block: BodyRenderBlock; view: TextRenderable }, row: number, x = 0): BodyAnchor => {
    const info = entry.view.lineInfo, logical = info.lineSources[row] ?? 0;
    const lines = sourceLineStarts(entry.block.text), start = lines[logical] ?? 0;
    const end = lines[logical + 1] ?? entry.block.text.length;
    const text = entry.block.text.slice(start, end);
    const column = Math.max(0, (info.lineStartCols[row] ?? 0) - lineBase(info, logical) + x - alignShift(entry.view, row));
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
      return { view: entry.view, x: entry.view.x + alignShift(entry.view, row) + column - ((info.lineStartCols[row] ?? 0) - base), y: entry.view.y + row };
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
    headerTop = prefixHeight() > box.scrollTop ? box.scrollTop : undefined; headerStart = props.page.start;
    headerFirst = headerTop === undefined ? undefined : blocks()[0]?.key;
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
    if (!first) return saved;
    const row = Math.max(0, Math.floor(top - first.view.y));
    anchorOffset = first.view.y + row - top;
    return position(first, row);
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
    if (align === 'bottom' || (following() && !gestureHold && !saved)) box.scrollTo(box.scrollHeight);
    else if (align === 'top') box.scrollTo(0);
    else if (headerTop !== undefined && showHeader() && blocks()[0]?.key === headerFirst && props.page.start === headerStart) box.scrollTo(headerTop);
    else if (saved) {
      // A bounded thinking tail may have evicted the old anchor. Keep its
      // viewport offset at that same block's first retained source position.
      if (!blocks().some(block => sourceToRendered(block, saved!) !== undefined)) {
        const retained = blocks().find(block => block.blockId === saved!.blockId);
        if (retained && saved.contentOffset < retained.node.from) saved = { blockId: saved.blockId, contentOffset: retained.node.from };
      }
      let restored = false;
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
        box.scrollTo(box.scrollTop + entry.view.y - box.viewport.y + row - anchorOffset); restored = true; break;
      }
      // A retained source position may still be awaiting its native leaf's
      // layout. Do not report a completed restoration from the old pixel top.
      if (!restored && blocks().some(block => sourceToRendered(block, saved!) !== undefined)) {
        props.renderer.requestRender(); return;
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
      } else {
        selection = undefined; selectionOwner = undefined; selectionGesture = undefined;
        props.renderer.clearSelection(); props.onError('所选内容已离开保留窗口，选区已解除；剪贴板未改变。');
      }
    }
  };
  const handle: BodyViewHandle = {
    inputTakeover(press = false) {
      // Retire queued mouse callbacks and finish the held gesture. Plain
      // editing must preserve a current reading request and its loading state.
      // 新的按下（包括上一次松开没有送达）：旧手势在这里结束，按在正文上的新手势在同一次事件处理里开始；
      // 两者之间的报告仍算按住，按住期间保留的布局不先归还。按下落在正文之外时，下一次报告即归还
      if (press) { pressing = true; queueMicrotask(() => { pressing = false; }); }
      const ownsGesture = heldVersion === navigationVersion;
      navigationVersion++;
      if (ownsGesture) heldVersion = navigationVersion;
      selectionClearPending ||= handle.hasSelection();
      box?.cancelPointer();
      props.renderer.releasePointerCapture?.();
      const current = props.renderer.getSelection();
      if (current?.isDragging && [...mounted.values()].some(entry => current.touchedRenderables.includes(entry.view))) {
        const target = pointerSource(current.focus), view = target && mounted.get(target.key)?.view;
        if (view) props.renderer.updateSelection(view, current.focus.x, current.focus.y, { finishDragging: true });
      }
      finishBodySelection();
      endGesture();
    },
    hasSelection() { const current = currentSelection(); return !!current && (current.parts.length > 1 || current.parts.some(part =>
      part.from.contentOffset !== part.to.contentOffset || part.fromBias !== part.toBias)); },
    selectionRange() { return currentSelection(); },
    selectedText() {
      const current = currentSelection();
      if (!current) return '';
      const selected = current.parts.map(part => {
        const block = (mounted.get(part.key)?.block ?? blockIndex().get(part.key))!;
        if (block.role === 'thinking') {
          // Thinking hides source blank lines and inserts visual soft wraps.
          // Copy the retained source interval, not those transformed runs.
          const text = bodyPageSegments(contentPage()).filter(segment => segment.blockId === block.blockId).map(segment =>
            segment.text.slice(Math.max(0, part.from.contentOffset - segment.contentOffset),
              Math.max(0, Math.min(segment.text.length, part.to.contentOffset - segment.contentOffset)))).join('');
          return { block, text };
        }
        const from = sourceToRendered(block, part.from)! + part.fromBias, to = sourceToRendered(block, part.to)! + part.toBias;
        let at = 0;
        const text = block.runs.map(run => {
          const start = at; at += run.text.length;
          return run.text.slice(Math.max(0, from - start), Math.max(0, Math.min(run.text.length, to - start)));
        }).join('');
        return { block, text };
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
      if (!following() || gestureHold) { saved = capture(); props.onAnchor(saved); }
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
      readingGeneration++; navigationVersion++; paging = false; gestureHold = false; readError = undefined; failedIntent = undefined;
      // 新的阅读范围（换代或进出壳态）一律从最新处开始，不论视图与正文谁先到；上一范围的意图、选区和位置都不带过来
      setFollowing(true); box?.cancelPointer(); props.renderer.releasePointerCapture?.(); props.renderer.clearSelection();
      selectionClearPending = false; readQueue.reset(); headerTop = undefined; anchorOffset = 0;
      pendingScroll = 0; saved = undefined; selection = undefined; selectionOwner = undefined; selectionGesture = undefined; align = undefined;
      // 新的阅读范围：旧的已备页、在途的取更早页结果与补读预算都作废
      earlierScope++; earlierRead = undefined; earlierStale = false; fill = { steps: 0, fragments: 0, done: false };
      setPrepared(undefined); setReplyFirst(Number.POSITIVE_INFINITY); setSourceEnded(false); setScope(value => value + 1);
      restorePending = true; layoutReady = false; props.onAnchor(undefined); props.renderer.requestRender();
      reportReading();
    },
    async page(direction, rows) {
      if (!box || disposed) return;
      const retryIntent = readError === direction ? failedIntent : undefined;
      failedIntent = undefined;
      navigationVersion++; gestureHold = false; setFollowing(false);
      // Changing follow intent is not a layout operation. Native scrollTo
      // already updates child coordinates; keep this navigation's new anchor.
      restorePending = false;
      readingGeneration++;
      const current = readingOwner();
      if (pendingScroll && Math.sign(pendingScroll) !== direction) pendingScroll = 0;
      saved = capture(); props.onAnchor(saved);
      beginPaging();
      readError = undefined; reportReading();
      try {
        if (retryIntent) {
          await requestPage(retryIntent.start, retryIntent.follow);
          if (current() && retryIntent.follow && !handle.hasSelection()) {
            setFollowing(true); saved = undefined; headerTop = undefined; props.onAnchor(undefined);
            restorePending = true; layoutReady = false; props.renderer.requestRender();
          }
          return;
        }
        const atEdge = direction < 0 ? box.scrollTop <= 0 : box.scrollTop + box.viewport.height >= box.scrollHeight;
        if (!atEdge) {
          box.scrollBy(direction * Math.max(0, rows ?? box.viewport.height - 1));
          saved = capture(); props.onAnchor(saved);
          if (direction > 0 && atBottom() && !handle.hasSelection()) await handle.bottom();
          else {
            // 接近顶边时先把更早一页取进已备页（不挂载），到顶时即可直接揭示
            if (direction < 0 && box.scrollTop < box.viewport.height && !prepared()?.segments.length && (storeBefore() || sourceMore()))
              void readEarlier().catch(() => {});
            await requestPage(props.page.start, false);
          }
          return;
        }
        const before = props.page;
        align = undefined;
        pendingScroll = Math.max(-2 * box.viewport.height, Math.min(2 * box.viewport.height,
          pendingScroll + direction * Math.max(0, rows ?? box.viewport.height - 2)));
        if (direction < 0) {
          // 向上到顶：已备页直接揭示；取更早页在途就等它（不吞这次手势）；都没有才读。源端准备中或回空页时保留同一个意图，
          // 有界退让后继续，直到能显示、到头或明确失败；换向、回到底部、切会话都会让 current() 失效而结束
          let delay = 0, stalls = 0;
          try {
            intentWaiting = true;
            while (current() && !overflow && !prepared()?.segments.length && (earlierRead || storeBefore() || sourceMore())) {
              await readEarlier();
              if (!current() || overflow || prepared()?.segments.length || earlierStale) break;
              if (!earlierProgressed && ++stalls >= 5) throw Error('terminal-history-no-progress');
              if (earlierProgressed) stalls = 0;
              delay = Math.min(400, delay ? delay * 2 : 50);
              await new Promise(resolve => setTimeout(resolve, delay));
            }
          } finally { intentWaiting = false; }
          if (current()) revealPrepared(); else overflow = undefined;
        }
        else if (props.page.start + props.page.segments.length < props.page.last) await requestPage(props.page.start + props.page.segments.length, false);
        else if (!handle.hasSelection()) await handle.bottom();
        else { pendingScroll = 0; await requestPage(props.page.start, false); }
        if (current() && props.page === before) pendingScroll = 0;
      } catch { if (current()) { pendingScroll = 0; readError = direction; failedIntent = retryIntent; } }
      finally { if (current()) { paging = false; reportReading(); } }
    },
    async bottom() {
      if (disposed) return;
      readingGeneration++;
      readError = undefined; failedIntent = undefined; pendingScroll = 0;
      navigationVersion++; gestureHold = false; setFollowing(true); box?.cancelPointer();
      const current = readingOwner();
      selection = undefined; selectionOwner = undefined; selectionGesture = undefined; props.renderer.clearSelection(); headerTop = undefined;
      saved = undefined; props.onAnchor(undefined); align = 'bottom';
      beginPaging(); reportReading();
      restorePending = true; layoutReady = false; props.renderer.requestRender();
      try { await requestPage(undefined, true); }
      catch { if (current()) { setFollowing(false); readError = 1; } }
      finally { if (current()) { paging = false; reportReading(); } }
    },
  };
  const atBottom = () => !!box && box.scrollTop + box.viewport.height >= box.scrollHeight && props.page.start + props.page.segments.length >= props.page.last;
  function beginGesture() {
    // The renderer has already started the NEW native selection before this
    // bubbled callback. Retire only our previous hold, never finish that new drag.
    box?.cancelPointer(); endGesture();
    gestureIntent = following(); heldVersion = navigationVersion; gestureHold = true;
    gestureHadSelection = selectionClearPending; selectionClearPending = false;
    heldContent = props.page;
    saved = capture(); props.onAnchor(saved);
  }
  function endGesture() {
    if (!gestureHold || disposed) return;
    gestureHold = false;
    // 手势结束当即报告：按住期间保留的布局（如进入提示的导航行）据此归还，不等下一帧
    try { settleGesture(); } finally { reportReading(); }
  }
  function settleGesture() {
    if (heldVersion !== navigationVersion) return;
    if (handle.hasSelection()) {
      setFollowing(false); commitReadingIntent(false);
    } else if (gestureIntent || gestureHadSelection && atBottom()) {
      const changed = !following();
      setFollowing(true);
      if (changed) commitReadingIntent(true);
      if (!sameBodyPageContent(heldContent, props.page)) {
        saved = undefined; headerTop = undefined;
        restorePending = true; layoutReady = false; props.renderer.requestRender();
      }
    }
  }
  createEffect(() => {
    prefixHeight();
    const page = contentPage(), width = props.width, height = props.height;
    if (disposed) return;
    if (lastPage && (page !== lastPage || width !== lastWidth || height !== lastHeight)) {
      if (!page.follow && !align && !saved) saved = untrack(() => props.anchor ?? capture());
      else if (page.follow && !gestureHold) { saved = undefined; headerTop = undefined; }
    }
    lastPage = page; lastWidth = width; lastHeight = height; restorePending = true; layoutReady = false;
    props.renderer.requestRender();
  });
  createEffect(() => { if (!disposed) highlighter.setPage(blocks().filter(block => visible().has(block.key))); });
  const postFrame = () => {
    restore();
    if (!box || disposed) return;
    if (selectionClearPending && !gestureHold && !props.renderer.getSelection()?.isDragging) {
      selectionClearPending = false;
      if (!handle.hasSelection() && atBottom() && !following()) {
        saved = undefined; headerTop = undefined; setFollowing(true);
        commitReadingIntent(true);
      }
    }
    const state = viewport(), selecting = !!props.renderer.getSelection();
    const page = contentPage();
    // Width/page are committed together with the restored scroll coordinate.
    // Publishing the new width with the old top would cull the source anchor
    // during the extra native layout frame required by restore().
    if (!restorePending && (state.page !== page || state.width !== props.width || state.top !== box.scrollTop || state.selecting !== selecting))
      setViewport({ page, width: props.width, top: box.scrollTop, selecting });
    reportReading();
    // 短视口不能看起来像到头：入口由 above 事实立即给出；内容按自然行高在后台补到已备页，不挂载、不挪动画面
    if (!readError && !selecting) fillStep();
  };
  props.renderer.addPostProcessFn(postFrame);
  props.onReady?.(handle);
  // 阅读键变化（换代、进出壳态）即新的阅读范围：在新页已就位之后重置，欢迎块起点按新页起算，旧手势、已备页与在途读取作废
  createEffect(on(() => props.readingKey, () => handle.resetReading(), { defer: true }));
  function release() {
    if (disposed) return;
    disposed = true; readingGeneration++; readQueue.reset(); earlierScope++; clearTimeout(pagingTimer); props.onReady?.(undefined);
    props.renderer.removePostProcessFn(postFrame); mounted.clear(); projected.clear(); wrapMeasure.destroy(); measureView.destroy(); measure.destroy();
  }
  onCleanup(() => {
    release();
    void highlighter.close().catch(() => {}); // close() exposes the same promise to the root lifecycle owner.
  });
  const layout = (block: BodyRenderBlock) => bodyBlockGeometry(block, contentWidth());
  const table = (block: BodyRenderBlock) => tableGeometry(block, layout(block).bodyWidth);
  // 表格一行的内容高度与测量同源（结果已缓存）：去掉真实表头起点的上边线与真实行尾的下边线
  const tableRows = (block: BodyRenderBlock) => Math.max(1, measureBlock(block, contentWidth()) - (tableTop(block) ? 1 : 0) - (block.rowEnd ? 1 : 0));
  const tableBars = (block: BodyRenderBlock) => Array.from({ length: tableRows(block) }, () => '│').join('\n');
  // 下边线（只在真实行尾画）：确定是表尾才收边；表头之下用双线与数据区分开；其余为行分隔
  const tableBottom = (block: BodyRenderBlock) => {
    const widths = table(block).widths;
    return tableEnds().has(block.key) ? bodyTableRule(widths, '└', '┴', '┘', '─') :
      block.node.header ? bodyTableRule(widths, '╞', '╪', '╡', '═') : bodyTableRule(widths, '├', '┼', '┤', '─');
  };
  const cellAlign = (block: BodyRenderBlock, cell: number) => block.node.align?.[cell] ?? 'left';
  const anchorTone = (block: BodyRenderBlock) => tone[processBodyColor(block.role, block.text) ?? 'brand'];
  const Text = (value: { block: BodyRenderBlock; width?: number; align?: 'left' | 'center' | 'right' }) => {
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
      width={value.width} minHeight={value.block.node.decoration !== undefined ? 1 : undefined} wrapMode={bodyWrapMode(value.block)} textAlign={value.align ?? 'left'}
      selectable selectionFg={tone.selectionFg} selectionBg={tone.selectionBg} />;
  };
  // 高度跟随外层区域的同一次布局（填满父框），不用量出来的 props.height：后者在布局之后才更新，
  // 视口变化（如候选面板收起）时会让滚动框晚一帧变高，先画出一帧正文停在旧位置、下方留空。
  // 同一次布局里视口变高时，滚动条按新视口收紧滚动位置，贴底的正文首帧即在稳定位置；宽度仍走量出的值与绘制后的恢复
  return <scrollbox ref={value => { box = value as TerminalScrollBox; }} width={Math.max(1, props.width)} height="100%" minHeight={1}
    scrollY scrollX={false} stickyScroll={false}
    verticalScrollbarOptions={{ width: spacing.scrollbar, showArrows: false, visible: false }}
    onMouseUp={event => { if (event.button === 0) { const version = navigationVersion; queueMicrotask(() => { if (!disposed && version === navigationVersion) { finishBodySelection(); endGesture(); } }); } }}
    onMouseDown={event => {
      if (event.button !== 0) return;
      event.stopPropagation(); beginGesture(); props.onOperation?.();
    }}
    onMouseScroll={event => {
      const direction = event.scroll?.direction;
      if (direction !== 'up' && direction !== 'down') return;
      event.preventDefault(); event.stopPropagation();
      void handle.page(direction === 'up' ? -1 : 1, 3).catch(props.onError);
      props.onOperation?.();
    }}>
    <Show when={showHeader()}><box width={Math.max(1, props.width)} flexShrink={0} flexDirection="column" onSizeChange={function(this: import('@opentui/core').BoxRenderable) { setHeaderHeight(this.height); }}>{props.header}
      {/* 欢迎框下原有的间隔行：确证到头时写“对话从这里开始”，行高不变，正文不挪动 */}
      <text height={1} wrapMode="none" selectable={false} fg={tone.dim} content={atStart() ? ' '.repeat(Math.max(0, spacing.content + Math.floor((contentWidth() - 20) / 2))) + '── 对话从这里开始 ──' : ''} />
    </box></Show>
    <For each={blockKeys()}>{key => {
      const block = createMemo(() => blockIndex().get(key)!);
      return <box flexDirection="column" flexShrink={0} marginX={spacing.content} width={contentWidth()} paddingLeft={layout(block()).indent} paddingTop={block().gapBefore ?? 0}
      height={heights().get(key)}>
      <Show when={visible().has(key)}>
      {/* 分隔线用虚线，与表格框线区分 */}
      <Show when={block().node.kind === 'rule'}><text marginLeft={layout(block()).leading} content={'┄'.repeat(layout(block()).bodyWidth)} fg={tone.rule} selectable={false} /></Show>
      <Show when={!['rule', 'space'].includes(block().node.kind)}>
      <Show when={block().node.kind === 'table'} fallback={<box flexDirection="row" flexShrink={0} paddingRight={layout(block()).trailing} backgroundColor={block().role === 'user' ? tone.history : undefined}>
        <text width={layout(block()).leading} content={block().role === 'user' ? '' : block().node.anchor ? ' ◆ ' : block().node.kind === 'quote' ? ' │ ' : ''}
          fg={block().node.anchor ? anchorTone(block()) : tone.dim} selectable={false} />
        <Show when={block().node.decoration}><text width={block().node.decoration?.length ?? 0}
          content={block().node.from === block().node.origin ? block().node.decoration : ''} fg={tone.dim} selectable={false} /></Show>
        <Text block={block()} width={layout(block()).textWidth} />
      </box>}>
        <box flexDirection="row" flexShrink={0}>
          <text width={layout(block()).leading} content={block().role !== 'user' && block().node.anchor ? ' ◆ ' : ''} fg={anchorTone(block())} selectable={false} />
          <Show when={!table(block()).stacked} fallback={
            <box width={layout(block()).bodyWidth} flexDirection="column" flexShrink={0} border={block().rowEnd ? ['bottom'] : false} borderColor={tone.tableFrame}>
              <For each={Array.from({ length: block().node.columns ?? 1 }, (_, i) => i)}>{cell =>
                <box width={layout(block()).bodyWidth} paddingRight={1} flexShrink={0} flexDirection="column">
                  <Show when={!block().node.header}><text selectable={false} fg={tone.dim} wrapMode="char"
                    width={Math.max(1, layout(block()).bodyWidth - 1)}>{`${block().node.labels?.[cell] ?? `列 ${cell + 1}`}：`}</text></Show>
                  <Text block={bodyCell(block(), cell)} width={Math.max(1, layout(block()).bodyWidth - 1)} />
                </box>}
              </For>
            </box>}>
            {/* 整表框线：真实表头起点上方画上边，真实行尾之下画行分隔／表头双线／收边；行的残段不伪造；框线不可选、不进复制 */}
            <box width={table(block()).width} flexDirection="column" flexShrink={0}>
              <Show when={tableTop(block())}><text height={1} wrapMode="none" selectable={false} fg={tone.tableFrame}
                content={bodyTableRule(table(block()).widths, '┌', '┬', '┐', '─')} /></Show>
              <box flexDirection="row" flexShrink={0} height={tableRows(block())}>
                <text width={1} height={tableRows(block())} wrapMode="none" selectable={false} fg={tone.tableFrame} content={tableBars(block())} />
                <For each={table(block()).widths.map((_, i) => i)}>{cell =>
                  <box flexDirection="row" flexShrink={0}>
                    {/* 对齐按显示行由原生完成（textAlign）：多行单元格的每一行都居中或居右，不往源文字补空格 */}
                    <box width={(table(block()).widths[cell] ?? 1) + 2} paddingLeft={1} paddingRight={1} flexShrink={0} flexDirection="column">
                      <Text block={bodyCell(block(), cell)} width={table(block()).widths[cell] ?? 1} align={cellAlign(block(), cell)} />
                    </box>
                    <text width={1} height={tableRows(block())} wrapMode="none" selectable={false} fg={tone.tableFrame} content={tableBars(block())} />
                  </box>}
                </For>
              </box>
              <Show when={block().rowEnd}><text height={1} wrapMode="none" selectable={false} fg={tone.tableFrame} content={tableBottom(block())} /></Show>
            </box>
          </Show>
        </box>
      </Show>
      </Show>
      </Show>
    </box>; }}</For>
  </scrollbox>;
}
