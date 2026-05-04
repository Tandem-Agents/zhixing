/**
 * TUI 设计语言层 —— 公共 API 入口
 *
 * 任何 caller（config-editor / REPL 工作台 / security 等）想用 TUI 视觉资源，
 * 都从此文件 import。**禁止** deep import 自 `./style.js` / `./chrome.js` 等
 * 具体文件——deep import 让"哪些是 public、哪些是内部"无法分辨，违反封装。
 *
 * 例外：`./_internal/*` 仅 tui 自身使用（raw mode lease / stdin ownership /
 * cursor invariants），下划线即"明知道是内部"，外部仍走对应 _internal 路径。
 *
 * ─── 四层结构 ────────────────────────────────────────────
 *
 * 1. **设计 Token**（语义颜色 / 图标 / 字符 / 布局常量 / 终端宽度）
 *    所有视觉决策的单一源——换主题、加深色模式只改这一层。
 *    不写硬编码颜色 / 图标，全部走 token 名。
 *
 * 2. **渲染原语**（chrome / button / pill / section / footer）
 *    纯函数：`options → string[]`，无状态、无副作用，caller 自己写 stdout。
 *    构造已 ANSI 染色的字符串行。
 *
 * 3. **TUI 应用组件**（select-with-input / typeahead-panel / typeahead-renderer）
 *    有状态、自带 I/O：接管 stdin keypress、生命周期 attach/detach、
 *    内部走 raw mode 与 stdin ownership。
 *
 * 4. **平台原语**（ANSI 控制序列 / 显示宽度计算 / OSC 8 超链接）
 *    底层工具，渲染原语和应用组件都依赖。caller 一般不直接用——
 *    需要时从此处取，避免重复实现。
 *
 * ─── 新增规则 ───────────────────────────────────────────
 *
 *   - 加新原语 / 组件：必须在此 index.ts 加 export，否则不算 public API。
 *   - 加新 token（如新颜色语义）：先在 style.ts 注册，再在此 export，
 *     最后再让 caller 用——保证从命名到使用全链可见。
 *   - 私有内部辅助：放进 `_internal/` 目录，不在此 export。
 */

// ─── 1. 设计 Token ───────────────────────────────────────

export {
  tone,
  icon,
  glyph,
  layout,
  getTerminalWidth,
} from "./style.js";

// ─── 2. 渲染原语 ─────────────────────────────────────────

export {
  renderChrome,
  type BrandAnchor,
  type ChromeOptions,
} from "./chrome.js";
export {
  renderButton,
  renderButtonRow,
  type ButtonOptions,
  type ButtonRowOptions,
} from "./button.js";
export {
  renderStatusPill,
  renderStatusPillWrapped,
  type PillKind,
} from "./status-pill.js";
export {
  renderSectionHead,
  renderEntryRow,
  renderListRow,
  type SectionHeadOptions,
  type EntryRowOptions,
  type ListRowOptions,
} from "./section.js";
export {
  renderFooter,
  type FooterOptions,
} from "./footer.js";

// ─── 3. TUI 应用组件 ─────────────────────────────────────

export {
  defaultTheme,
  selectWithInput,
  _getRawModeRefcount,
  _resetRawModeRefcountForTests,
} from "./select-with-input.js";
export type {
  SelectCancelCause,
  SelectOption,
  SelectResult,
  SelectWithInputOptions,
  Theme,
} from "./select-with-input.js";
export {
  computeWindow,
  createTypeaheadPanel,
  defaultTypeaheadTheme,
  renderSessionLines,
} from "./typeahead-panel.js";
export type {
  RenderOptions,
  TypeaheadPanelHandle,
  TypeaheadPanelOptions,
  TypeaheadTheme,
  VisibleWindow,
} from "./typeahead-panel.js";
export {
  createTerminalTypeaheadRenderer,
  TERMINAL_TYPEAHEAD_CAPABILITIES,
} from "./typeahead-renderer.js";
export type {
  TerminalTypeaheadRenderer,
  TerminalTypeaheadRendererOptions,
} from "./typeahead-renderer.js";

// ─── 4. 平台原语 ─────────────────────────────────────────

export {
  ANSI,
  stripAnsi,
  osc8Hyperlink,
} from "./ansi.js";
export {
  charWidth,
  clampLine,
  stringWidth,
  wrapToWidth,
} from "./line-width.js";
