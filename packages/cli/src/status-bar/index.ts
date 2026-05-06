/**
 * 状态条公共导出。
 *
 * cli REPL 启动一个 StatusBar 订阅 EventBus，turn 活跃期间显示动态状态条；
 * 通过 ScreenController.setStatusBar 投递到屏幕。
 */

export { createStatusBar, type StatusBarHandle } from "./status-bar.js";
export {
  spinnerFrame,
  COMPLETED_GLYPH,
  formatDuration,
  formatTokens,
  truncate,
  VERBS,
} from "./verbs.js";
