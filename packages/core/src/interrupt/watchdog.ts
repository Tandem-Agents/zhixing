/**
 * `wrapStreamWithWatchdog` —— stream 中断响应的 facade。
 *
 * 组合两层职责:
 * 1. **race 基础层** (`wrapStreamWithAbortRace`): 永远生效, 保证 abort 后
 *    `iterator.next()` 在短时间内返回 `{ done: true }`, 不依赖底层 SDK 自身
 *    响应 abort。这是 abort 响应延迟的下限保证。
 * 2. **idle-timer 叠加层** (`wrapWithIdleTimer`): chunk-arrival idle 触发 abort,
 *    保证"LLM 流静默挂死"场景能自动检测并中断。`idleTimeoutMs <= 0` 时关闭
 *    叠加层 (race 仍生效)。
 *
 * 关键设计:
 *
 * - **timer fire 不抛错, 只调 `abortWithReason`**: race 层听到 abort 自动让
 *   iterator 立即返回 done, for-await 退出。把"检测"与"退出"两个职责分开,
 *   避免双重错误处理路径。
 *
 * - **chunk reset 共享同一时间点**: warn 与 abort timer 在每个 chunk 到达时
 *   一起重置, 保证 warn 触发 → 收 chunk → 新周期允许再 warn。
 *
 * - **资源回收用 try/finally**: 任何终态 (正常结束 / abort / consumer return /
 *   底层 throw) 都过 `clearTimers()`, 不允许定时器泄漏到下一轮 turn。
 *
 * - **emit fire-and-forget + .catch 防御**: EventBus emit 失败不能影响 stream
 *   消费; 订阅方报错被 swallow, 仅由 EventBus 自身的隔离机制处理。
 *
 * 关注点分离:
 * - watchdog **不** emit `interrupt:fired` —— 那是 `emitRunEnd` 的职责 (单点收敛)
 * - watchdog **不** 做 abort 优先转换 —— 那是 `finalizeRun` 的职责
 * - watchdog **不** 知道 turn 边界、tool 状态 —— 它只盯 stream chunk 间隔
 *
 * **诊断通道契约 (架构原则: core 不假设运行环境)**:
 * - 触发信号**仅通过 EventBus** 发出 (`interrupt:warn` / abort 路径的
 *   `interrupt:fired` 由 emitRunEnd 单点收敛), 由 caller 决定终点：
 *     · cli REPL → setupInterruptRendering → cliWriter (chrome scrollback)
 *     · serve daemon → 同一 cli render 路径 → stdout (重定向到 daemon log)
 *     · serve 等非交互 → StdoutWriter → stdout
 *     · 测试 → mock 订阅
 * - 历史曾在此路径直接 console.warn 兼任"操作员日志"，违反 core 不假设环境
 *   原则 (chrome 模式下的 stderr 写入会破坏 frame model)。当前架构所有 caller
 *   都已订阅 EventBus，console 路径冗余且有害——已移除。
 *
 * 后续扩展槽位 (本里程碑不实现): 若需新 watchdog 维度 (wall-clock total /
 * bytes-received / 等), 在 facade 内组合即可, 不破坏对外接口。
 */

import type { IEventBus } from "../events/types.js";
import type { AgentEventMap } from "../types/agent-events.js";
import { abortWithReason } from "./controller.js";
import { wrapStreamWithAbortRace } from "./stream-race.js";
import { DEFAULT_WATCHDOG_POLICY, type WatchdogPolicy } from "./types.js";

/**
 * 包装 stream, 在 race 基础上叠加可选的 idle-timer。
 *
 * `policy.idleTimeoutMs <= 0` → 仅包 race (idle-timer 关闭, 但 abort 响应能力
 * 由 race 保证仍然生效)。
 *
 * `eventBus` 缺省时, warn 阈值触发不发事件 (race + abort 行为不受影响)。
 */
export function wrapStreamWithWatchdog<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  policy: WatchdogPolicy = DEFAULT_WATCHDOG_POLICY,
  eventBus?: IEventBus<AgentEventMap>,
): AsyncIterable<T> {
  const raced = wrapStreamWithAbortRace(stream, controller);
  if (policy.idleTimeoutMs <= 0) return raced;
  return wrapWithIdleTimer(raced, controller, policy, eventBus);
}

/**
 * 内部: 给已 race 过的 stream 叠加 chunk-arrival idle 检测。
 *
 * 不对外导出 —— 调用方应通过 `wrapStreamWithWatchdog` 拿到完整 facade。
 * 内层 `iterator.next()` 已经 race 过 abort, 所以 timer fire 触发 abort 后
 * 下一次 `next()` 会立即返回 done, 进入 finally 清理。
 */
function wrapWithIdleTimer<T>(
  stream: AsyncIterable<T>,
  controller: AbortController,
  policy: WatchdogPolicy,
  eventBus?: IEventBus<AgentEventMap>,
): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<T, void, undefined> {
      const iterator = stream[Symbol.asyncIterator]();
      let chunksReceived = 0;
      let lastChunkAt = Date.now();
      let warnTimer: ReturnType<typeof setTimeout> | null = null;
      let abortTimer: ReturnType<typeof setTimeout> | null = null;

      const clearTimers = (): void => {
        if (warnTimer !== null) {
          clearTimeout(warnTimer);
          warnTimer = null;
        }
        if (abortTimer !== null) {
          clearTimeout(abortTimer);
          abortTimer = null;
        }
      };

      const armTimers = (): void => {
        clearTimers();
        const warnMs = policy.idleTimeoutMs * policy.warnThresholdRatio;

        warnTimer = setTimeout(() => {
          // 仅 emit EventBus——core 不假设运行环境，由 caller 决定终点
          // (cli REPL → cliWriter / serve daemon → stdout 日志 / 测试 → mock)。
          // emit fire-and-forget: 订阅方异常不能影响 stream 消费;
          // EventBus 自身的 listener 隔离已做 try/catch, 此处 .catch 是双重防御
          eventBus
            ?.emit("interrupt:warn", {
              kind: "idle-timeout-warn",
              elapsedMs: Date.now() - lastChunkAt,
              timeoutMs: policy.idleTimeoutMs,
              chunksReceived,
            })
            .catch(() => {});
        }, warnMs);

        abortTimer = setTimeout(() => {
          // 不抛错, 只触发 abort: race 层立即让下一次 iterator.next() 返回 done,
          // for-await 退出, 进入 finally → clearTimers。两个职责清晰分离。
          // abort 触发后的可见性由 emitRunEnd → interrupt:fired → caller 渲染层负责
          // (cli REPL writer.line "[interrupted]" / serve 同写 stdout 日志)，
          // watchdog 不直接 console（避免假设运行环境，避免破坏 chrome 模式 frame）。
          abortWithReason(controller, {
            kind: "idle-timeout",
            timeoutMs: policy.idleTimeoutMs,
            chunksReceived,
            elapsedSinceLastChunkMs: Date.now() - lastChunkAt,
          });
        }, policy.idleTimeoutMs);
      };

      try {
        // armTimers 放进 try 块内: 防御未来内部修改引入抛错时 finally 仍能清理。
        // 当前 armTimers 仅做 clearTimers + setTimeout, 不抛 —— 这是工程化最佳实践。
        armTimers();
        while (true) {
          // 内层 stream 已经 race 过 controller.signal, 此处 await 在 abort 后
          // 由 race 立即返回 done, 不依赖底层 iterator 自身响应 abort。
          const result = await iterator.next();
          if (result.done) return;
          chunksReceived++;
          lastChunkAt = Date.now();
          // 每个 chunk 到达 → 重置两个 timer 共享的周期起点。
          // warn 触发后收到 chunk → reset → 新周期允许再次 warn (chunk-arrival idle 语义)。
          armTimers();
          yield result.value;
        }
      } finally {
        // 任何终态都清理: 正常结束 / abort 退出 / consumer generator.return() /
        // 底层 throw 都过这里, 防止 timer 泄漏到下一轮 turn。
        clearTimers();
      }
    },
  };
}
