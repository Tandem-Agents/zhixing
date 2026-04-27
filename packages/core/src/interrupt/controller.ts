/**
 * AbortController 协议层 helper —— 4 个纯函数,不引入 controller class。
 *
 * 不引入 class 的原因:本仓库现有 ChatRequest / ToolExecutionContext /
 * ContextManagerInput 等几十处 API 全程使用原生 `AbortSignal`。引入 class
 * 会制造双轨制(旧调用方传 abortSignal、新调用方传 controller)。helper
 * 模式让任何接 `AbortSignal` 的库(fetch、Anthropic SDK、setTimeout)零改动
 * 接入,fork 关系通过 `forkController(parent)` 显式表达。
 *
 * 命名约定:`AbortSignal` 是只读跨边界传递,作为函数参数 / ctx 字段;
 * `AbortController` 是可写所有者持有,只在创建/触发 abort 的地方出现。
 * 不在工具层 / Provider 层 / ContextManager 层暴露 AbortController——避免
 * 下游误调 `.abort()` 把上游状态搞乱。
 */

import { setMaxListeners } from "node:events";
import type { AbortReason } from "./types.js";

/**
 * EventEmitter 默认 10 listener 警告对 abort 多源汇聚场景过于保守:
 * 一个 controller.signal 可能同时被 fetch / timer / for-await race / abort
 * record listener 等多处订阅。设 50 留充分余量,同时仍能捕捉真实泄漏。
 */
const DEFAULT_MAX_LISTENERS = 50;

/**
 * 创建 `AbortController`,可选三类输入:
 * - `parent`:父 signal,父 abort → 当前 controller 自动 abort with
 *   `{ kind: "parent-abort" }`(子 agent 路径用)
 * - `externalSignals`:外部多源 signal,任一 aborted → controller aborted with
 *   `{ kind: "external" }`(scheduler timeout / 外部 SDK 等)
 * - `maxListeners`:override `setMaxListeners` 默认值 50
 *
 * 三类输入可同时传入(子 agent 同时受父和外部 scheduler 限时)——任一触发都
 * 让 controller abort,abortWithReason 幂等保证 first-wins 不覆盖原 reason。
 *
 * 返回原生 `AbortController`,对外接口零侵入。
 *
 * 已 aborted 的 parent / ext signal 在构造时立即触发自身 abort——
 * `addEventListener` 在已 aborted signal 上不会被调用(EventTarget 标准),
 * 不同步处理会让后续依赖 abortFiredAt 的逻辑永远拿不到时间戳。
 *
 * 已知边界(暂不处理):`externalSignals` 上挂的 listener 用 `{ once: true }`,
 * 只在 `ext.abort()` 触发时自动 remove。若 ext signal 永不 abort 且生命周期长
 * (典型场景:跨多次 run 共享同一 abortSignal),N 次调用会在同一 ext signal
 * 上累积 N 个 listener,closure 引用 controller 让其无法 GC。当前 REPL 路径
 * per-turn 创建,turn 结束 controller 被 GC,无累积。引入 dispose 协议会
 * 破坏"返回原生 AbortController"的核心抽象,等真有长生命周期共享场景时再
 * 独立设计 dispose / WeakRef 方案。
 */
export function createInterruptController(opts?: {
  readonly parent?: AbortSignal;
  readonly externalSignals?: readonly AbortSignal[];
  readonly maxListeners?: number;
}): AbortController {
  // parent 路径委托给 forkController(它内部也调本函数无 parent 创建子,然后
  // 挂 onParentAbort listener,自带 setMaxListeners)。非 parent 路径走标准
  // AbortController + setMaxListeners。
  const controller = opts?.parent
    ? forkController(opts.parent)
    : new AbortController();

  if (!opts?.parent) {
    setMaxListeners(opts?.maxListeners ?? DEFAULT_MAX_LISTENERS, controller.signal);
  } else if (opts.maxListeners !== undefined) {
    // fork 路径已默认 setMaxListeners(50);仅当 caller 显式 override 才再设
    setMaxListeners(opts.maxListeners, controller.signal);
  }

  for (const ext of opts?.externalSignals ?? []) {
    // 一旦 controller 已 aborted(被本轮或上一轮迭代触发,或 parent 已 aborted),
    // 后续 ext 上不再挂 listener:挂上去就是 dead listener——controller 已 aborted,
    // onExtAbort 触发只会走 abortWithReason 的 no-op 分支;但 closure 引用
    // controller 让它无法被 GC,直到 ext signal 自己 abort(once:true 才移除)。
    if (controller.signal.aborted) break;

    if (ext.aborted) {
      abortWithReason(controller, { kind: "external" });
      continue;
    }
    const onExtAbort = () => abortWithReason(controller, { kind: "external" });
    ext.addEventListener("abort", onExtAbort, { once: true });
  }

  return controller;
}

/**
 * 触发 abort 并附带类型化 `reason`,通过原生 `signal.reason` 传递。
 * 幂等:已 aborted 时 no-op,不覆盖原 reason——多个 source 同时触发时第一个
 * 胜出,后续触发不擦除诊断信息。
 *
 * 纯函数契约:不发任何 EventBus 事件、不写日志。让"abort 触发"和
 * "事件可观测"严格分层,事件由 agent-loop 在退出路径上集中处理,确保
 * `interrupt:fired` 始终在 `agent:run_end` 之前发出且只发一次。
 */
export function abortWithReason(controller: AbortController, reason: AbortReason): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
}

/**
 * 安全地从 `AbortSignal` 提取 `AbortReason`。
 *
 * 仅识别本模块通过 `abortWithReason` 触发的 abort;其他来源(外部 signal /
 * 裸 controller.abort() 不带 reason / abort() 传非对象 reason)返回 `null`,
 * 调用方应做"未知中断源"分支处理。
 */
export function getAbortReason(signal: AbortSignal): AbortReason | null {
  if (!signal.aborted) return null;
  const r: unknown = signal.reason;
  if (
    r !== null &&
    typeof r === "object" &&
    "kind" in r &&
    typeof (r as { kind: unknown }).kind === "string"
  ) {
    return r as AbortReason;
  }
  return null;
}

/**
 * 创建子 controller。父 abort → 子自动 abort with `{ kind: "parent-abort" }`;
 * 子 abort 不影响父。子也走 `setMaxListeners(50)`。
 *
 * 接 `AbortSignal` 而非 `AbortController` 是有意为之:fork 在语义上是"读父的
 * abort 状态"——只需要 `aborted` 和 `addEventListener('abort')`。如果接 controller,
 * 父就被迫把 `.abort()` 写权限暴露给子,与本模块"AbortSignal 跨边界传递、
 * AbortController 仅在创建/触发处持有"的命名约定矛盾(子越权 abort 父)。
 *
 * 副收益:任何持有 signal 的方都能 fork——包括只接收到 parentSignal 的子 agent
 * 路径,无需双轨制。
 *
 * 父若已 aborted,子在创建时立即同步 abort——与 `createInterruptController` 的
 * 边界处理对称(addEventListener 在已 aborted signal 上不触发)。
 */
export function forkController(parent: AbortSignal): AbortController {
  const child = createInterruptController();

  if (parent.aborted) {
    abortWithReason(child, {
      kind: "parent-abort",
      parentReason: getAbortReason(parent),
    });
    return child;
  }

  const onParentAbort = () => {
    abortWithReason(child, {
      kind: "parent-abort",
      parentReason: getAbortReason(parent),
    });
  };
  parent.addEventListener("abort", onParentAbort, { once: true });
  return child;
}
