/**
 * CLI 安全子系统入口
 *
 * 组装 core 的 SecurityPipeline 与 CLI 特定的 UI 层。
 */

export {
  showConfirmationDialog,
  renderBlockedMessage,
  renderUserDeniedMessage,
  type ConfirmationChoice,
  type PromptFn,
  type ShowConfirmationOptions,
} from "./confirmation-ui.js";

export {
  createSecureExecuteTool,
  SecurityBlockError,
  type SecureExecuteToolOptions,
} from "./secure-executor.js";

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

export {
  buildConfirmationRequest,
  buildConfirmationOptions,
  buildDisplayBody,
  buildPanelTitle,
  sanitizeCommandPreview,
} from "./request-builder.js";
export type { BuildConfirmationRequestParams } from "./request-builder.js";
