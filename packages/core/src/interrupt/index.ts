/**
 * 可中断 Agent Loop —— 公开 API。
 *
 * 端到端架构与决策记录:
 *   research/design/specifications/interruptible-agent-loop-execution.md
 *
 * 本模块只导出协议层 + 基础能力:
 * - AbortReason 判别联合 + WatchdogPolicy 配置类型 + createWatchdogPolicy 工厂
 * - 4 个 controller helper(create / abort / get / fork)
 * - stream 中断响应基础层(wrapStreamWithAbortRace)
 * - abort 退出协议清理(buildCleanup + assemblePartialMessage)
 *
 * 不在本模块导出(按需后续引入):
 * - 看门狗 facade(idle-timer 叠加层)
 * - 跨平台子进程优雅停止(graceful-kill)
 * - REPL 输入路由(KeyboardSource / SignalSource):它们与 stdin 协调耦合,
 *   住在 packages/cli/src/interrupt/
 */

export {
  abortWithReason,
  createInterruptController,
  forkController,
  getAbortReason,
} from "./controller.js";

export { wrapStreamWithAbortRace } from "./stream-race.js";

export { assemblePartialMessage } from "./assemble.js";

export {
  buildCleanup,
  formatReasonForToolResult,
} from "./cleanup.js";

export {
  DEFAULT_WATCHDOG_POLICY,
  createWatchdogPolicy,
} from "./types.js";

export type {
  AbortReason,
  ExternalSignalReason,
  IdleTimeoutReason,
  ParentAbortReason,
  UserCancelReason,
  WatchdogPolicy,
} from "./types.js";

export type { CleanupContext, CleanupOutcome } from "./cleanup.js";
