/**
 * @zhixing/server/confirmation —— 远程权限确认兼容聚合入口
 *
 * ConfirmationHub 的实现归 owner-kernel；纯文本渲染与匹配仍由网关接入层提供。
 */

export { ConfirmationHub } from "./hub.js";
export type { BrokerId, HubEntry, HubEvent, HubUnsubscribe } from "./hub.js";

export { TextConfirmationRenderer, formatConfirmationMessage } from "./text-renderer.js";
export type { TextRendererOptions } from "./text-renderer.js";

export {
  APPROVE_KEYWORDS,
  DENY_KEYWORDS,
  MAX_REASON_LENGTH,
  matchTextToDecision,
  formatResolutionReceipt,
} from "./match.js";
