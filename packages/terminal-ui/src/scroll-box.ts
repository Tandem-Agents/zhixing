import { ScrollBoxRenderable, type ScrollBoxOptions, type RenderContext, type MouseEvent } from '@opentui/core';
import { tone, spacing } from './theme.js';

declare module '@opentui/core' { interface CliRenderer { releasePointerCapture(): void } }

export function scrollGeometry(content: number, viewport: number, track: number, scroll: number) {
  const range = Math.max(0, content - viewport), height = range && track > 0
    ? Math.max(1, Math.min(Math.max(1, track - 1), Math.round(track * viewport / content))) : 0;
  return { range, height, top: range ? Math.round((track - height) * Math.max(0, Math.min(range, scroll)) / range) : 0 };
}

/** Shared scrollbar gestures. Native geometry paints; this owner alone maps
 * pointer navigation to scroll position. Programmatic layout emits no intent. */
export class TerminalScrollBox extends ScrollBoxRenderable {
  protected override _focusable = false;
  #drag?: { y: number; offset: number; geometry: string };
  readonly #cancel = () => this.cancelPointer();
  constructor(ctx: RenderContext, options: ScrollBoxOptions) {
    super(ctx, { ...options, verticalScrollbarOptions: { ...options.verticalScrollbarOptions,
      width: spacing.scrollbar, showArrows: false, visible: true,
      trackOptions: { backgroundColor: 'transparent', foregroundColor: tone.border } } });
    // 调用方明确不要竖条时（会话正文）经 setter 固定隐藏：OpenTUI 默认按溢出自动显隐，
    // 只有 setter 置否才会一直不显示，也不占列、不接收指针。
    if (options.verticalScrollbarOptions?.visible === false) this.verticalScrollBar.visible = false;
    const slider = this.verticalScrollBar.slider;
    ctx.on('terminal-pointer-cancel', this.#cancel);
    slider.onMouseDown = event => {
      if (event.button !== 0) return;
      this.cancelPointer();
      const g = this.#geometry();
      if (!g.range || slider.height <= 0) return;
      event.preventDefault(); event.stopPropagation();
      this.emit('reading-pointer');
      const y = event.y - slider.y;
      if (y >= g.top && y < g.top + g.height && slider.height > 1) {
        this.#drag = { y: event.y, offset: y - g.top, geometry: this.#signature() };
        slider.foregroundColor = tone.brand;
      } else if (slider.height > 1) this.scrollBy((y < g.top ? -1 : 1) * Math.max(1, this.viewport.height - 1));
      this.emit('reading-navigation');
    };
    slider.onMouseDrag = event => {
      if (!this.#drag) return;
      event.preventDefault(); event.stopPropagation();
      const g = this.#geometry(), signature = this.#signature();
      if (signature !== this.#drag.geometry) {
        this.#drag.offset = this.#drag.y - slider.y - g.top;
        this.#drag.geometry = signature;
      }
      const travel = slider.height - g.height;
      if (travel > 0) this.scrollTo(Math.round((event.y - slider.y - this.#drag.offset) * g.range / travel));
      this.#drag.y = event.y;
      this.emit('reading-navigation');
    };
    slider.onMouseUp = event => {
      event.preventDefault(); event.stopPropagation(); this.cancelPointer(); this.emit('reading-navigation');
    };
  }
  #geometry() { return scrollGeometry(this.scrollHeight, this.viewport.height, this.verticalScrollBar.slider.height, this.scrollTop); }
  #signature() { return [this.scrollHeight, this.viewport.height, this.verticalScrollBar.slider.height, this.verticalScrollBar.slider.y].join(':'); }
  cancelPointer() { this.#drag = undefined; this.stopAutoScroll(); this.verticalScrollBar.slider.foregroundColor = tone.border; }
  override destroy() { this._ctx.off('terminal-pointer-cancel', this.#cancel); super.destroy(); }
  protected override onMouseEvent(event: MouseEvent): void {
    if (event.defaultPrevented) return;
    if (event.type === 'down' && event.button === 0) {
      this.stopAutoScroll();
      this.#press = { y: event.y, left: false };
      this.#pointer = { x: event.x, y: event.y, seq: (this.#pointer?.seq ?? 0) + 1 };
    }
    super.onMouseEvent(event);
  }

  // 拖选的边缘自动滚动按选择意图触发：指针在视口首行或之上（末行或之下），且这次拖动的真实指针离开过按下行，
  // 才向那一边推进。在边缘行上横拖只是选这一行的字。全屏界面里拿不到指针越过屏幕边的距离，原生按距离分的三档
  // 改用在边缘停留的时长来定；停留时长在原有逐帧时钟里累计，不另开计时器。
  #press?: { y: number; left: boolean };
  #pointer?: { x: number; y: number; seq: number };
  #edge = { direction: 0, dwell: 0, carry: 0 };
  // hold：正文重排期间暂停推进，真实指针也不恢复；await：等下一次真实指针恢复；run：照常推进
  #pause: 'run' | 'hold' | 'await' = 'run';
  /** 本框内最近一次真实指针（按下或拖动），供正文判断重排期间有没有新的真实输入 */
  get realPointer(): { readonly x: number; readonly y: number; readonly seq: number } | undefined { return this.#pointer; }
  /** 正文重排期间暂停推进；意图与停留时长保留，暂停不是取消 */
  holdAutoScroll(): void { this.#pause = 'hold'; this.#live(); }
  /** 能证明排版与指针对应都没变：按原意图立即恢复 */
  resumeAutoScroll(): void { this.#pause = 'run'; this.#live(); }
  /** 不能证明对应不变：等下一次真实指针输入，按新布局继续 */
  awaitPointer(): void { this.#pause = 'await'; this.#live(); }
  // 原生在每次真实拖动时调用这里；起停与方向由本类按意图决定，不启动原生的计时推进
  override updateAutoScroll(x: number, y: number): void {
    this.#pointer = { x, y, seq: (this.#pointer?.seq ?? 0) + 1 };
    if (this.#press && y !== this.#press.y) this.#press.left = true;
    if (this.#pause === 'await') this.#pause = 'run';
    this.#aim(y);
  }
  override startAutoScroll(): void {}
  override stopAutoScroll(): void {
    this.#press = undefined; this.#edge = { direction: 0, dwell: 0, carry: 0 }; this.#pause = 'run';
    super.stopAutoScroll(); this.#live();
  }
  protected override onUpdate(deltaTime: number): void {
    super.onUpdate(deltaTime);
    const edge = this.#edge;
    if (!edge.direction || this.#pause !== 'run' || !this._ctx.getSelection()?.isDragging) return;
    // 停留中即使没有新的指针移动，速度也照常升档；方向在每一帧按当前滚动范围复核，到头即停
    if (this.#pointer) this.#aim(this.#pointer.y);
    if (!this.#edge.direction) return;
    edge.dwell += deltaTime;
    const speed = edge.dwell < EDGE_MEDIUM_AFTER_MS ? EDGE_SPEED_SLOW : edge.dwell < EDGE_FAST_AFTER_MS ? EDGE_SPEED_MEDIUM : EDGE_SPEED_FAST;
    edge.carry += edge.direction * speed * deltaTime / 1000;
    const step = Math.trunc(edge.carry);
    if (!step) return;
    edge.carry -= step;
    const before = this.scrollTop;
    this.scrollTop += step;
    if (this.scrollTop !== before) this._ctx.requestSelectionUpdate();
  }
  // 方向按实际视口的上下界判断（不是外壳的 y 与 height）；离边或反向即重置停留时长
  #aim(y: number): void {
    const top = this.viewport.y, bottom = top + this.viewport.height - 1;
    const direction = !this.#press?.left ? 0
      : y <= top ? (this.scrollTop > 0 ? -1 : 0)
      : y >= bottom ? (this.scrollTop < this.scrollHeight - this.viewport.height ? 1 : 0) : 0;
    if (direction !== this.#edge.direction) this.#edge = { direction, dwell: 0, carry: 0 };
    this.#live();
  }
  #live(): void { this.live = this.#edge.direction !== 0 && this.#pause === 'run'; }
}

// 沿用 OpenTUI 自动滚动的三档速度（行/秒）；刚到边缘走慢档，停留越久越快
const EDGE_SPEED_SLOW = 6, EDGE_SPEED_MEDIUM = 36, EDGE_SPEED_FAST = 72;
const EDGE_MEDIUM_AFTER_MS = 500, EDGE_FAST_AFTER_MS = 1500;
