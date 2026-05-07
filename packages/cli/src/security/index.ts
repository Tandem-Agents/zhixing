/**
 * CLI 安全子系统 barrel —— 仅导出 cli 内部模块。
 *
 * runtime 关注点(SecurityPipeline / SecureExecutor / request-builder /
 * SecurityBlockError 等)位于 @zhixing/core 与 @zhixing/orchestrator/security,
 * 消费者从源包直接 import,不通过本 barrel 跨包 re-export。
 */

export {
  createBlockedRenderer,
  createUserDeniedRenderer,
} from "./security-event-renderer.js";

export {
  handleTrustCommand,
  handleSecurityCommand,
} from "./commands.js";

export {
  TerminalConfirmationRenderer,
  TERMINAL_RENDERER_CAPABILITIES,
  buildSelectOptions,
  buildPanelBody,
  translate,
} from "./terminal-renderer.js";
export type { TerminalConfirmationRendererOptions } from "./terminal-renderer.js";
