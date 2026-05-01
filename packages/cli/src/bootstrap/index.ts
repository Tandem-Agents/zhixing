/**
 * 首次引导子模块出口。
 *
 * 引导流程编排（runBootstrap）独立于交互实现：
 *   - CLI 入口启动期：用 ReadlineBootstrapInteraction
 *   - 测试：mock interaction
 *   - 未来 TUI / GUI：换实现，runner 不变
 */

export { runBootstrap } from "./runner.js";
export type {
  BootstrapWriters,
  RunBootstrapArgs,
} from "./runner.js";

export { TerminalBootstrapInteraction } from "./terminal-interaction.js";

export { ensureBootstrap } from "./entry.js";
export type {
  BootstrapEntryResult,
  EnsureBootstrapOptions,
} from "./entry.js";

export type {
  BootstrapAskAnswer,
  BootstrapAskRequest,
  BootstrapInteraction,
  BootstrapResult,
} from "./types.js";
