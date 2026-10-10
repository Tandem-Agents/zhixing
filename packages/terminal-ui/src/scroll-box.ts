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
    if (!event.defaultPrevented) super.onMouseEvent(event);
  }
}
