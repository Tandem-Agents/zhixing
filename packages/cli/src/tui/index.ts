// TUI 组件公开 API

export { ANSI, stripAnsi } from "./ansi.js";
export { charWidth, clampLine, stringWidth } from "./line-width.js";
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

// ── Typeahead TTY 渲染（Step 4） ──
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
