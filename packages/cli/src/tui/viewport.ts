/**
 * 视口合成 —— 固定顶部 + 滚动中间 + 固定底部,正好填满终端高度。
 *
 * alt-screen 全屏布局的通用原语:把"哪些钉死(顶 / 底)、哪些随内容滚动(中间)"分离开。
 *   - 内容放得下 → 中间补空行,把 bottom 顶到屏幕最下沿(底部固定区永远可见)。
 *   - 放不下 → 顶部对齐截断、末行折叠提示(v1 不滚;留 `scrollOffset` 扩展位给将来真滚动)。
 *   - 极矮终端(顶 / 底已撑满)→ 优先保住底部固定区,中间不显示。
 *
 * 返回正好 height 行(极矮终端除外),供 `Renderer.writeFrame` 满屏整帧写(末尾不带 \n、
 * 不触发终端滚动)。纯函数、无染色(overflowHint 已含样式由 caller 传)、无副作用。
 */
export interface ViewportOptions {
  /** 终端可用高度(行)。 */
  height: number;
  /** 固定顶部行(如标题 chrome)。 */
  top: readonly string[];
  /** 随内容滚动的中间区行(如字段 / 正文)。 */
  scroll: readonly string[];
  /** 固定底部行(如输入区 / 操作行)——永远钉在屏幕最下沿。 */
  bottom: readonly string[];
  /**
   * 内容超出可用高度被截断时,末行显示的折叠提示(已含样式)。
   * 省略则纯截断、不提示。
   */
  overflowHint?: string;
  /**
   * 滚动偏移(预留扩展位,v1 恒 0):>0 时从 scroll 第 N 行开始显示,支持上下滚动。
   * 当前不消费,仅占位声明可扩展性。
   */
  scrollOffset?: number;
}

export function composeViewport(opts: ViewportOptions): string[] {
  const { top, bottom, scroll, height, overflowHint } = opts;
  const avail = height - top.length - bottom.length;

  // 极矮终端:顶 / 底已撑满甚至溢出 —— 优先保住底部固定区(用户的操作锚点),中间不显示。
  if (avail <= 0) return [...top, ...bottom];

  let mid: string[];
  if (scroll.length <= avail) {
    // 放得下:内容 + 填充空行,把 bottom 顶到屏幕最下沿。
    mid = [...scroll, ...new Array(avail - scroll.length).fill("")];
  } else if (overflowHint !== undefined) {
    // 放不下:顶部对齐截断,末行留折叠提示(总占 avail 行)。
    mid = [...scroll.slice(0, avail - 1), overflowHint];
  } else {
    // 放不下、无提示:纯截断到 avail 行。
    mid = scroll.slice(0, avail);
  }
  return [...top, ...mid, ...bottom];
}
