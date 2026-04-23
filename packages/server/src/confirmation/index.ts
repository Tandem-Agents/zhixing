/**
 * @zhixing/server/confirmation —— 远程权限确认 server 侧能力聚合
 *
 * 参见 remote-confirmation-execution.md：
 *   - §3.2 ConfirmationHub：聚合 per-runtime broker
 *   - §3.4 TextConfirmationRenderer：纯文本通道渲染器
 *   - §3.6 match：文本 → decision 匹配规则 + 词集
 */

export { ConfirmationHub } from "./hub.js";
export type { BrokerId, HubEntry, HubEvent, HubUnsubscribe } from "./hub.js";

export { TextConfirmationRenderer, formatConfirmationMessage } from "./text-renderer.js";
export type { TextRendererOptions } from "./text-renderer.js";

export {
  MAX_REASON_LENGTH,
  matchTextToDecision,
  formatResolutionReceipt,
} from "./match.js";
