/**
 * ReplInterruptRuntime —— REPL agent run 期间的中断协调层
 *
 * 把"controller + 两 abort 触发源 (KeyboardSource raw-mode + SignalSource OS 信号兜底)"
 * 封装为单一 handle，让 repl.ts 只看到一个对象、不需要直接持有两个 source 引用。
 *
 * 生命周期：每次 turn 创建一个新 runtime (controller per-turn 不复用,与 agent-loop 一致),
 * turn 结束 detach 释放全部资源。
 *
 * 暴露能力：
 * - controller.signal: 透传给 agentRuntime.run as abortSignal
 * - pause / resume: 给 securityPrompt 等 cooked-mode 子 UI 用,只暂停 KeyboardSource,
 *   SignalSource 仍工作 (Ctrl+C 走 OS SIGINT 仍可触发 abort,作为 pause 期间的兜底通道)
 * - detach: turn 结束统一释放
 *
 * 双击 Ctrl+C exit 语义由 REPL 通过 onDoublePress 决定 —— runtime 不感知 (透传到 KeyboardSource)。
 *
 * 依赖注入 (stdin / signals / now / doublePressMs) 让单测能用 mock 替换底层 IO,
 * 避免真听 process.stdin 或真给进程发信号。生产路径默认值不变。
 */

import { createInterruptController } from "@zhixing/core";
import { attachKeyboardSource } from "./keyboard-source.js";
import { attachSignalSource, type SignalEmitter } from "./signal-source.js";

export interface ReplInterruptRuntime {
  /** 当前 turn 的 controller —— REPL 透传 controller.signal 给 agentRuntime.run */
  readonly controller: AbortController;
  /**
   * 暂停 KeyboardSource (cooked-mode 子 UI 包裹用,如 securityPrompt 的 rl.question)。
   * SignalSource 仍工作,Ctrl+C 走 OS SIGINT 兜底中断。幂等。
   */
  pause(): void;
  /** 恢复 KeyboardSource raw-mode 拦截。pause/resume 必须配对。幂等。 */
  resume(): void;
  /** turn 结束释放两个 source + 恢复 stdin 初始状态。幂等。 */
  detach(): void;
}

export interface CreateReplInterruptRuntimeOptions {
  /**
   * 双击 Ctrl+C callback —— REPL 决定 exit 语义 (典型: abort 当前 turn + 等 turn 退出 +
   * 走 /exit 路径清理 scheduler.stop 等)。
   * 返回 Promise 表示需要异步执行,KeyboardSource fire-and-forget 不 await。
   */
  onDoublePress: (key: "ctrl-c") => void | Promise<void>;
  /** stdin 注入,默认 process.stdin (测试用 PassThrough mock 避免 hang) */
  stdin?: NodeJS.ReadStream;
  /** 信号源注入,默认 process (测试用 EventEmitter mock 避免给进程真发信号) */
  signals?: SignalEmitter;
  /** 时间源注入,默认 Date.now (测试可传 fake clock 控制双击窗口) */
  now?: () => number;
  /** 双击间隔阈值 (ms),默认 800 */
  doublePressMs?: number;
}

export function createReplInterruptRuntime(
  opts: CreateReplInterruptRuntimeOptions,
): ReplInterruptRuntime {
  const controller = createInterruptController();

  const keyboard = attachKeyboardSource({
    controller,
    onDoublePress: opts.onDoublePress,
    stdin: opts.stdin,
    now: opts.now,
    doublePressMs: opts.doublePressMs,
  });

  const signals = attachSignalSource({
    controller,
    signals: opts.signals,
    now: opts.now,
  });

  let detached = false;

  return {
    controller,
    pause: () => keyboard.pause(),
    resume: () => keyboard.resume(),
    detach: () => {
      if (detached) return;
      detached = true;
      keyboard.detach();
      signals.detach();
    },
  };
}
