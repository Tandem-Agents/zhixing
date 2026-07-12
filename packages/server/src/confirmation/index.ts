/** 网关侧确认呈现与文本匹配。确认权威由 owner-kernel 导出。 */

export { TextConfirmationRenderer, formatConfirmationMessage } from "./text-renderer.js";
export type { TextRendererOptions } from "./text-renderer.js";

export {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  MAX_REASON_LENGTH,
  matchTextToDecision,
  formatResolutionReceipt,
} from "./match.js";
