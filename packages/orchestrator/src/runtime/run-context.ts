/**
 * Per-run / per-spawn 上下文存储 —— 通过 AsyncLocalStorage 在嵌套异步链路中
 * 隐式传递 EventBus 与 lineage,供子 agent 派生 / Task 工具 closure 取用。
 *
 * 为什么要 ALS:
 *   - Task 工具 closure 在 createAgentRuntime 装配期 capture 父级共享服务
 *     (provider / pipeline / tools / broker 等),但 EventBus 与 lineage
 *     是**每次 run() 独立的**,closure 不可能 capture
 *   - 把 bus / lineage 显式塞进 ToolExecutionContext 会污染 ToolDefinition
 *     接口,且每个工具都得透传 —— 与 Task 工具是少数派的现实不符
 *   - ALS 走 node:async_hooks,在 Promise / async 链路自动透传上下文,
 *     工具内部 `runContextStorage.getStore()` 即可拿到当前 run 的 bus / lineage
 *
 * 使用契约:
 *   - 主 agent run() 入口包 `runContextStorage.run({ bus, lineage: "main" }, ...)`
 *   - 子 agent runChildAgent 内部包 `runContextStorage.run({ bus: childBus, lineage: childLineage }, ...)`
 *   - 工具 / 任意嵌套 helper 通过 `runContextStorage.getStore()` 读取
 *     (返回 undefined 时退化:无 bus 可用,工具只能走最基础路径)
 */

import { AsyncLocalStorage } from "node:async_hooks";
import type {
  AgentEventMap,
  EventBus,
  WorkModeSwitchIntent,
} from "@zhixing/core";

/**
 * Per-run/per-spawn 上下文 —— 跨嵌套异步链路传递的最小集合。
 *
 * 字段刻意精简:
 *   - bus 走具体类 EventBus 而非接口 IEventBus,与 createEventBus 返回值
 *     / RunChildAgentOptions.parentBus 类型链统一(子若再 spawn 孙子时
 *     直接拿此 bus 当 parentBus 透传)
 *   - lineage 必填(不是 optional 的 string | undefined),保证下游派生
 *     子 lineage 时必有前缀,EventBus 构造时不会因 parent 有 lineage / 子无
 *     而触发不变量违反
 */
export interface RunContext {
  bus: EventBus<AgentEventMap>;
  lineage: string;
  /**
   * 当前 conversation id —— 工具按需取（用于在持久化会话中区分写入目标 / 读取上下文）。
   *
   * 可选：ephemeral / 一次性 run（定时任务 / 单测 fixture）
   * 没有 conversation 上下文，工具应在 undefined 时显式分支处理（拒绝执行 /
   * graceful degrade），不要兜底编造。
   */
  conversationId?: string;
}

export const runContextStorage = new AsyncLocalStorage<RunContext>();

/**
 * 向当前 run 的 EventBus 发模式切换意图 —— turn 内只发意图不执行切换,
 * accumulator last-wins 收集后随 RunResult.pendingModeSwitch 带出,由调用方
 * 在 turn 边界唯一消费(REPL 直驱 / 宿主经定向通知交发起接入面)。
 *
 * 经 ALS 取 per-run bus(与 task_list 工具取 conversationId 同款机制);
 * 非 run 上下文(装配期 / 单测)静默 no-op。
 */
export function emitWorkModeSwitchIntent(intent: WorkModeSwitchIntent): void {
  runContextStorage.getStore()?.bus.emit("workmode:switch_requested", intent);
}
