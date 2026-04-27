/**
 * 可中断 Agent Loop —— 公开 API。
 *
 * 端到端架构与决策记录:
 *   research/design/specifications/interruptible-agent-loop-execution.md
 *
 * 本模块导出协议层 + 基础能力 + stream 看门狗 + 跨平台子进程优雅停止:
 * - AbortReason 判别联合 + WatchdogPolicy 配置类型 + createWatchdogPolicy 工厂
 * - 4 个 controller helper(create / abort / get / fork)
 * - stream 中断响应基础层(wrapStreamWithAbortRace)
 * - stream 看门狗 facade(wrapStreamWithWatchdog: race + 可选 idle-timer)
 * - abort 退出协议清理(buildCleanup + assemblePartialMessage)
 * - 跨平台子进程优雅停止(gracefulKill: SIGTERM → grace → SIGKILL, Windows 直接 kill)
 *
 * 不在本模块导出(按需后续引入):
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

export { wrapStreamWithWatchdog } from "./watchdog.js";

export { gracefulKill } from "./graceful-kill.js";
export type { GracefulKillOptions } from "./graceful-kill.js";

export { assemblePartialMessage, assembleSafeMessage } from "./assemble.js";

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
